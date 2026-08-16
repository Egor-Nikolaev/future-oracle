import Parser from "rss-parser";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { googleNewsUrl, sourceFromTitle, stripSource } from "./feeds.js";
import { ASSETS, matchAssets } from "./assets.js";
import { fetchMarkets } from "./coingecko.js";
import { scoreTitlesBatch, ruleScore } from "./sentiment.js";
import { buildPrediction, actualDirection } from "./predict.js";
import {
  upsertAsset, insertSnapshot, latestSnapshot, snapshotHistory,
  upsertNews, saveSentiment, assetNews,
  insertPrediction, latestPrediction, unresolvedBefore, resolvePrediction,
  insertHistoryPrediction, countPredictions,
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

// Пул с ограничением параллелизма — чтобы не долбить LLM 8 запросами разом (429).
async function runPool(items, worker, concurrency = 3) {
  const out = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return out;
}

// Сентимент батчами по CHUNK заголовков (меньший батч надёжнее по длине ответа).
async function scoreAll(titles, chunk = 12) {
  const out = [];
  for (let i = 0; i < titles.length; i += chunk) {
    const part = await scoreTitlesBatch(titles.slice(i, i + chunk));
    for (const s of part) out.push(s);
  }
  return out;
}

// 2а) Тянем RSS по каждому коину (параллельно, это сеть — не LLM) и складываем новости.
async function fetchAssetNews(a, limit) {
  const url = googleNewsUrl(a.query);
  let parsed;
  try {
    parsed = await parser.parseURL(url);
  } catch {
    return { asset: a, entries: [] };
  }
  const entries = [];
  for (const it of (parsed.items || []).slice(0, limit)) {
    const title = stripSource(stripHtml(it.title || ""));
    const guid = it.guid || it.link;
    if (!title || !guid) continue;
    const newsId = upsertNews({
      guid,
      source: sourceFromTitle(stripHtml(it.title || "")),
      title,
      url: it.link || guid,
      published_at: it.isoDate || it.pubDate || null,
      fetched_at: new Date().toISOString(),
    });
    if (!newsId) continue;
    entries.push({ newsId, title });
  }
  return { asset: a, entries };
}

// 2) Новости → база + сентимент. По КАЖДОМУ активу отдельный Google News RSS-поиск:
// десятки свежих новостей на коин с точной привязкой (запрос = имя монеты), без
// ложных подстрок и перекоса в биток. Сентимент — LLM батчами с rule-based фолбэком,
// параллелизм ограничен пулом, чтобы не ловить rate-limit.
async function ingestNews({ perCoin } = {}) {
  const limit = perCoin || Number(process.env.NEWS_PER_COIN) || 40;
  const perAsset = {};
  for (const a of ASSETS) perAsset[a.id] = [];

  // сеть: тянем RSS всех коинов параллельно
  const fetched = await Promise.all(ASSETS.map((a) => fetchAssetNews(a, limit)));

  // LLM: считаем сентимент пулом (не более 3 активов одновременно)
  let added = 0;
  await runPool(
    fetched,
    async ({ asset, entries }) => {
      if (!entries.length) return;
      const scored = await scoreAll(entries.map((e) => e.title));
      const scores = [];
      for (let i = 0; i < entries.length; i++) {
        const { score, method } = scored[i] || { score: ruleScore(entries[i].title), method: "rule-based" };
        saveSentiment({ news_id: entries[i].newsId, asset_id: asset.id, score, method });
        scores.push(score);
      }
      perAsset[asset.id] = scores;
      added += entries.length;
    },
    3
  );

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

    // предыдущий снимок для тренда объёма (история обновлений)
    const hist = snapshotHistory(a.id, 2);
    const prevSnap = hist.length > 1 ? hist[1] : null;
    const p = buildPrediction({ snapshot: snap, prevSnapshot: prevSnap, sentiments: perAsset[a.id] || [] });
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
function readSeed() {
  const seedPath = path.join(process.cwd(), "data", "seed.json");
  if (!existsSync(seedPath)) return null;
  try {
    return JSON.parse(readFileSync(seedPath, "utf8"));
  } catch {
    return null;
  }
}

// Загрузка бэктест-истории (сверённые прогнозы) для метрики точности. Реальные
// прогоны из локальной сборки. Нужна, чтобы точность была ненулевой и на холодном
// serverless-инстансе, где живая сверка между запросами не накапливается.
function loadHistory(seed) {
  ensureAssets();
  let n = 0;
  for (const h of seed?.history || []) {
    insertHistoryPrediction(h);
    n++;
  }
  return n;
}

// Только снимки цен из seed — опорная точка, чтобы живой рефреш мог посчитать тренд
// объёма (свежий снимок против seed-снимка) уже на первом холодном запросе.
function loadSeedSnapshots(seed) {
  ensureAssets();
  const now = seed.generated_at || new Date().toISOString();
  for (const s of seed.snapshots || []) {
    insertSnapshot({ ...s, fetched_at: s.fetched_at || now });
  }
}

function loadSeed(seedArg) {
  const seed = seedArg || readSeed();
  if (!seed) return false;
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

// Досеивание при пустой базе. Порядок:
//   1) грузим бэктест-историю из seed → метрика точности ненулевая даже на холодном
//      инстансе (текущие прогнозы новее, поэтому в карточках показываются они);
//   2) пробуем живой цикл для актуальных прогнозов, при сбое сети — офлайн seed.
let _seeding = null;
export async function ensureSeeded() {
  if (countPredictions() > 0) return { seeded: false };
  if (!_seeding) {
    _seeding = (async () => {
      const seed = readSeed();
      const history = seed ? loadHistory(seed) : 0;
      if (seed) loadSeedSnapshots(seed); // опорные снимки → тренд объёма на холодном старте
      try {
        await refreshAll();
        return { seeded: true, source: "live", history };
      } catch (e) {
        const ok = seed ? loadSeed(seed) : false;
        return { seeded: ok || history > 0, source: ok ? "seed" : "history-only", history, error: String(e.message || e) };
      }
    })().finally(() => { _seeding = null; });
  }
  return _seeding;
}

export { loadSeed, loadHistory };
