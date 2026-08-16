import Parser from "rss-parser";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { googleNewsUrl, sourceFromTitle, stripSource } from "./feeds.js";
import { ASSETS, matchAssets } from "./assets.js";
import { fetchMarkets } from "./coingecko.js";
import { fetchDerivatives } from "./binance.js";
import { runBacktest } from "./backtest.js";
import { scoreTitlesBatch, ruleScore } from "./sentiment.js";
import { buildPrediction, actualDirection } from "./predict.js";
import {
  upsertAsset, insertSnapshot, latestSnapshot, snapshotHistory,
  upsertNews, saveSentiment, assetNews,
  insertPrediction, latestPrediction, unresolvedBefore, resolvePrediction,
  insertHistoryPrediction, countPredictions, setMeta, getMeta,
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

// 1) Цены (CoinGecko) + деривативы (Binance funding/OI) → снимки.
async function ingestPrices() {
  const [markets, derivs] = await Promise.all([
    fetchMarkets(),
    fetchDerivatives().catch(() => ({})), // funding не критичен — при сбое просто отсутствует
  ]);
  const snapIds = {};
  for (const m of markets) {
    const d = derivs[m.asset_id] || {};
    insertSnapshot({ ...m, funding: d.funding ?? null, open_interest: d.open_interest ?? null });
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

// Нормализация заголовка для дедупа сюжетов (один и тот же материал из разных изданий).
function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-zа-я0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
}

// Вес по свежести: свежая новость важнее старой. Полувес ~ через 2 суток.
function recencyWeight(publishedAt) {
  if (!publishedAt) return 0.5;
  const ageH = (Date.now() - new Date(publishedAt).getTime()) / 3.6e6;
  if (!isFinite(ageH) || ageH < 0) return 1;
  return Math.exp(-ageH / 48);
}

// 2а) Тянем RSS по каждому коину (параллельно, это сеть — не LLM). Дедупим сюжеты по
// нормализованному заголовку, чтобы 5 перепечаток одной новости не считались за 5.
async function fetchAssetNews(a, limit) {
  const url = googleNewsUrl(a.query);
  let parsed;
  try {
    parsed = await parser.parseURL(url);
  } catch {
    return { asset: a, entries: [] };
  }
  const entries = [];
  const seen = new Set();
  for (const it of parsed.items || []) {
    if (entries.length >= limit) break;
    const title = stripSource(stripHtml(it.title || ""));
    const guid = it.guid || it.link;
    if (!title || !guid) continue;
    const key = normTitle(title);
    if (key.length < 8 || seen.has(key)) continue; // дубль сюжета — пропускаем
    seen.add(key);
    const published_at = it.isoDate || it.pubDate || null;
    const newsId = upsertNews({
      guid,
      source: sourceFromTitle(stripHtml(it.title || "")),
      title,
      url: it.link || guid,
      published_at,
      fetched_at: new Date().toISOString(),
    });
    if (!newsId) continue;
    entries.push({ newsId, title, published_at });
  }
  return { asset: a, entries };
}

// 2) Новости → база + сентимент. По КАЖДОМУ активу отдельный Google News RSS-поиск:
// десятки свежих осмысленных новостей на коин с точной привязкой (запрос = имя монеты).
// Сентимент — LLM батчами (rule-based фолбэк), пул на 3 актива против rate-limit.
// Итоговый сентимент коина — среднее, ВЗВЕШЕННОЕ ПО СВЕЖЕСТИ (свежее важнее).
async function ingestNews({ perCoin } = {}) {
  const limit = perCoin || Number(process.env.NEWS_PER_COIN) || 60;
  const perAsset = {};
  for (const a of ASSETS) perAsset[a.id] = { sentiment: null, newsCount: 0 };

  const fetched = await Promise.all(ASSETS.map((a) => fetchAssetNews(a, limit)));

  let added = 0;
  await runPool(
    fetched,
    async ({ asset, entries }) => {
      if (!entries.length) return;
      const scored = await scoreAll(entries.map((e) => e.title));
      let wsum = 0;
      let wnum = 0;
      for (let i = 0; i < entries.length; i++) {
        const { score, method } = scored[i] || { score: ruleScore(entries[i].title), method: "rule-based" };
        saveSentiment({ news_id: entries[i].newsId, asset_id: asset.id, score, method });
        const w = recencyWeight(entries[i].published_at);
        wsum += w;
        wnum += w * score;
      }
      perAsset[asset.id] = {
        sentiment: wsum ? Number((wnum / wsum).toFixed(3)) : null,
        newsCount: entries.length,
      };
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
    const sd = perAsset[a.id] || { sentiment: null, newsCount: 0 };
    const p = buildPrediction({
      snapshot: snap, prevSnapshot: prevSnap,
      sentiment: sd.sentiment, newsCount: sd.newsCount,
    });
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

// Полный цикл обновления (живой). Порядок: цены+деривативы → новости → прогнозы.
// Бэктест ценового сигнала считаем best-effort (CoinGecko history бывает лимитирован);
// при сбое остаётся прошлый результат из meta/seed.
export async function refreshAll(opts = {}) {
  ensureAssets();
  const prices = await ingestPrices();
  const news = await ingestNews(opts);
  const made = buildPredictions({ snapIds: prices.snapIds, perAsset: news.perAsset });
  if (opts.backtest !== false) {
    try {
      const bt = await runBacktest(Number(process.env.BACKTEST_DAYS) || 40);
      if (bt) setMeta("backtest", { ...bt, computed_at: new Date().toISOString() });
    } catch {
      /* оставляем прошлый бэктест */
    }
  }
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
  const acc = {}; // asset_id → { wsum, wnum, n } для взвешенного сентимента
  for (const a of ASSETS) acc[a.id] = { wsum: 0, wnum: 0, n: 0 };

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
      if (acc[assetId]) {
        const w = recencyWeight(n.published_at);
        acc[assetId].wsum += w;
        acc[assetId].wnum += w * score;
        acc[assetId].n++;
      }
    }
  }
  const perAsset = {};
  for (const a of ASSETS) {
    const x = acc[a.id];
    perAsset[a.id] = { sentiment: x.wsum ? Number((x.wnum / x.wsum).toFixed(3)) : null, newsCount: x.n };
  }
  if (seed.backtest) setMeta("backtest", seed.backtest);
  buildPredictions({ snapIds, perAsset });
  return true;
}

// Досеивание при пустой базе. Порядок:
//   1) грузим бэктест-историю из seed → метрика точности ненулевая даже на холодном
//      инстансе (текущие прогнозы новее, поэтому в карточках показываются они);
//   2) пробуем живой цикл для актуальных прогнозов, при сбое сети — офлайн seed.
let _seeding = null;
export async function ensureSeeded() {
  // бэктест-метрику всегда держим из seed, даже если прогнозы уже есть на инстансе
  // (иначе после прямого /api/ingest без cold-start метрика пропадает)
  if (!getMeta("backtest")) {
    const s0 = readSeed();
    if (s0?.backtest) setMeta("backtest", s0.backtest);
  }
  if (countPredictions() > 0) return { seeded: false };
  if (!_seeding) {
    _seeding = (async () => {
      const seed = readSeed();
      const history = seed ? loadHistory(seed) : 0;
      if (seed?.backtest) setMeta("backtest", seed.backtest); // бэктест виден сразу
      if (seed) loadSeedSnapshots(seed); // опорные снимки → тренд объёма на холодном старте
      try {
        // на холодном старте бэктест не гоняем (щадим CoinGecko) — берём из seed,
        // кнопка «Обновить» пересчитывает свежий
        await refreshAll({ backtest: false });
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
