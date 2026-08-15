import Parser from "rss-parser";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { FEEDS } from "./feeds.js";
import { ASSETS, matchAssets, assetById } from "./assets.js";
import { fetchMarkets } from "./coingecko.js";
import { scoreTitle, ruleScore } from "./sentiment.js";
import { buildPrediction, actualDirection } from "./predict.js";
import {
  upsertAsset, insertSnapshot, latestSnapshot,
  upsertNews, saveSentiment, assetNews,
  insertPrediction, latestPrediction, unresolvedBefore, resolvePrediction,
  countPredictions,
} from "./db.js";

const parser = new Parser({ timeout: 15000 });

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();
}

// Гарантируем, что справочник активов в базе.
function ensureAssets() {
  for (const a of ASSETS) upsertAsset({ id: a.id, symbol: a.symbol, name: a.name });
}

// 1) Цены → снимки. Возвращает map asset_id → snapshot_id.
async function ingestPrices() {
  const markets = await fetchMarkets();
  const snapIds = {};
  for (const m of markets) {
    insertSnapshot(m);
    const snap = latestSnapshot(m.asset_id);
    snapIds[m.asset_id] = snap.id;
  }
  return { snapIds, count: markets.length };
}

// 2) Новости → база + сентимент по упомянутым активам.
async function ingestNews({ perFeed } = {}) {
  const limit = perFeed || Number(process.env.INGEST_PER_FEED) || 20;
  let added = 0;
  const perAsset = {}; // asset_id → массив сентиментов [-1..1]
  for (const a of ASSETS) perAsset[a.id] = [];

  for (const feed of FEEDS) {
    let parsed;
    try {
      parsed = await parser.parseURL(feed.url);
    } catch {
      continue;
    }
    for (const item of (parsed.items || []).slice(0, limit)) {
      const title = stripHtml(item.title || "");
      if (!title) continue;
      const assets = matchAssets(title);
      if (!assets.length) continue; // новость не про наши активы — пропускаем

      const guid = item.guid || item.link;
      const newsId = upsertNews({
        guid,
        source: feed.source,
        title,
        url: item.link || guid,
        published_at: item.isoDate || item.pubDate || null,
        fetched_at: new Date().toISOString(),
      });
      if (!newsId) continue;
      added++;

      const { score, method } = await scoreTitle(title); // один разбор на заголовок
      for (const assetId of assets) {
        saveSentiment({ news_id: newsId, asset_id: assetId, score, method });
        perAsset[assetId].push(score);
      }
    }
  }
  return { added, perAsset };
}

// 3) Прогнозы: сверяем прошлый с фактом, строим новый из снимка + сентимента.
function buildPredictions({ snapIds, perAsset }) {
  const now = new Date().toISOString();
  let made = 0;
  for (const a of ASSETS) {
    const snap = latestSnapshot(a.id);
    if (!snap) continue;

    // сверка постфактум: прошлый несверенный прогноз против текущей цены
    const prev = unresolvedBefore(a.id, now);
    if (prev) {
      const actual = actualDirection(prev.base_price, snap.price);
      resolvePrediction(prev.id, {
        resolved_price: snap.price,
        resolved_at: now,
        actual_dir: actual,
        hit: actual === prev.direction ? 1 : 0,
      });
    }

    const p = buildPrediction({ snapshot: snap, sentiments: perAsset[a.id] || [] });
    insertPrediction({
      asset_id: a.id,
      snapshot_id: snapIds[a.id] || snap.id,
      base_price: snap.price,
      direction: p.direction,
      score: p.score,
      confidence: p.confidence,
      momentum: p.momentum,
      sentiment: p.sentiment,
      news_count: p.newsCount,
      risks_json: JSON.stringify(p.risks),
      drivers_json: JSON.stringify(p.drivers),
      created_at: now,
    });
    made++;
  }
  return made;
}

// Полный цикл обновления (живой). Порядок: цены → новости → прогнозы.
export async function refreshAll(opts = {}) {
  ensureAssets();
  const prices = await ingestPrices();
  const news = await ingestNews(opts);
  const made = buildPredictions({ snapIds: prices.snapIds, perAsset: news.perAsset });
  return { assets: prices.count, news: news.added, predictions: made };
}

// --- seed-фолбэк для serverless/холодного старта и офлайн-демо ---
function loadSeed() {
  const seedPath = path.join(process.cwd(), "data", "seed.json");
  if (!existsSync(seedPath)) return false;
  let seed;
  try {
    seed = JSON.parse(readFileSync(seedPath, "utf8"));
  } catch {
    return false;
  }
  ensureAssets();
  const now = seed.generated_at || new Date().toISOString();
  const snapIds = {};
  const perAsset = {};
  for (const a of ASSETS) perAsset[a.id] = [];

  for (const s of seed.snapshots || []) {
    insertSnapshot({ ...s, fetched_at: s.fetched_at || now });
    const snap = latestSnapshot(s.asset_id);
    if (snap) snapIds[s.asset_id] = snap.id;
  }
  for (const n of seed.news || []) {
    const newsId = upsertNews({
      guid: n.guid, source: n.source, title: n.title, url: n.url,
      published_at: n.published_at || null, fetched_at: n.fetched_at || now,
    });
    if (!newsId) continue;
    for (const assetId of n.assets || matchAssets(n.title)) {
      const score = n.score ?? ruleScore(n.title);
      saveSentiment({ news_id: newsId, asset_id: assetId, score, method: n.method || "rule-based" });
      if (perAsset[assetId]) perAsset[assetId].push(score);
    }
  }
  buildPredictions({ snapIds, perAsset });
  return true;
}

// Досеивание при пустой базе: сначала пробуем живой цикл, при сбое — seed.
let _seeding = null;
export async function ensureSeeded() {
  if (countPredictions() > 0) return { seeded: false };
  if (!_seeding) {
    _seeding = (async () => {
      try {
        await refreshAll();
        return { seeded: true, source: "live" };
      } catch (e) {
        const ok = loadSeed();
        return { seeded: ok, source: ok ? "seed" : "none", error: String(e.message || e) };
      }
    })().finally(() => { _seeding = null; });
  }
  return _seeding;
}

export { loadSeed };
