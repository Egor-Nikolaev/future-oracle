import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Единая точка доступа к базе.
// Локально файл лежит в data/future-oracle.db (в .gitignore).
// На serverless (Vercel) writable только /tmp, поэтому база там эфемерная,
// а данные досеиваются автоматически при пустой базе (см. lib/ingest.js).
const DATA_DIR =
  process.env.DB_DIR ||
  (process.env.VERCEL ? "/tmp/future-oracle" : path.join(process.cwd(), "data"));
mkdirSync(DATA_DIR, { recursive: true });

let _db;

export function getDb() {
  if (_db) return _db;
  _db = new Database(path.join(DATA_DIR, "future-oracle.db"));
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  return _db;
}

export function dataDir() {
  return DATA_DIR;
}

function migrate(db) {
  db.exec(`
    -- Объекты прогноза (криптоактивы)
    CREATE TABLE IF NOT EXISTS assets (
      id     TEXT PRIMARY KEY,       -- coingecko id, напр. "bitcoin"
      symbol TEXT NOT NULL,          -- BTC
      name   TEXT NOT NULL           -- Bitcoin
    );

    -- Сырые снимки рынка (история обновлений источника A — цифры)
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id   TEXT NOT NULL,
      price      REAL NOT NULL,
      volume     REAL,
      chg_24h    REAL,               -- % за 24ч
      chg_7d     REAL,               -- % за 7д
      fetched_at TEXT NOT NULL,
      UNIQUE(asset_id, fetched_at)
    );

    -- Сырые новости (источник B — контекст)
    CREATE TABLE IF NOT EXISTS news_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      guid         TEXT UNIQUE,
      source       TEXT NOT NULL,
      title        TEXT NOT NULL,
      url          TEXT NOT NULL,
      published_at TEXT,
      fetched_at   TEXT NOT NULL
    );

    -- Нормализованный показатель: сентимент новости по активу [-1..+1]
    CREATE TABLE IF NOT EXISTS news_sentiment (
      news_id  INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      score    REAL NOT NULL,        -- -1 медвежий … +1 бычий
      method   TEXT NOT NULL,        -- llm | rule-based
      PRIMARY KEY (news_id, asset_id)
    );

    -- Прогнозы: считаются из сохранённых снимка + сентимента, не из воздуха
    CREATE TABLE IF NOT EXISTS predictions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id       TEXT NOT NULL,
      snapshot_id    INTEGER NOT NULL,     -- на каком снимке цен построен
      base_price     REAL NOT NULL,        -- цена на момент прогноза (для сверки)
      direction      TEXT NOT NULL,        -- up | down | flat
      score          REAL NOT NULL,        -- итоговый балл [-1..+1]
      confidence     INTEGER NOT NULL,     -- 0..100
      momentum       REAL NOT NULL,        -- вклад цифр [-1..+1]
      sentiment      REAL,                 -- вклад новостей [-1..+1] или null (нет покрытия)
      news_count     INTEGER NOT NULL,
      risks_json     TEXT NOT NULL,        -- массив риск-факторов
      drivers_json   TEXT NOT NULL,        -- массив «что повлияло» (числа)
      created_at     TEXT NOT NULL,
      -- сверка постфактум (как система понимает, что ошиблась)
      resolved_price REAL,
      resolved_at    TEXT,
      actual_dir     TEXT,                 -- up | down | flat по факту
      hit            INTEGER                -- 1 попал / 0 мимо / null ещё не сверен
    );
  `);
}

// --- assets ---
export function upsertAsset(a) {
  getDb()
    .prepare(`INSERT INTO assets (id, symbol, name) VALUES (@id, @symbol, @name)
              ON CONFLICT(id) DO UPDATE SET symbol=excluded.symbol, name=excluded.name`)
    .run(a);
}
export function listAssets() {
  return getDb().prepare(`SELECT * FROM assets ORDER BY symbol`).all();
}

// --- price snapshots ---
export function insertSnapshot(s) {
  const info = getDb()
    .prepare(`INSERT INTO price_snapshots (asset_id, price, volume, chg_24h, chg_7d, fetched_at)
              VALUES (@asset_id, @price, @volume, @chg_24h, @chg_7d, @fetched_at)
              ON CONFLICT(asset_id, fetched_at) DO NOTHING`)
    .run(s);
  return info.lastInsertRowid;
}
export function latestSnapshot(assetId) {
  return getDb()
    .prepare(`SELECT * FROM price_snapshots WHERE asset_id = ? ORDER BY datetime(fetched_at) DESC, id DESC LIMIT 1`)
    .get(assetId);
}
export function snapshotHistory(assetId, limit = 30) {
  return getDb()
    .prepare(`SELECT * FROM price_snapshots WHERE asset_id = ? ORDER BY datetime(fetched_at) DESC, id DESC LIMIT ?`)
    .all(assetId, limit);
}

// --- news ---
export function upsertNews(n) {
  const info = getDb()
    .prepare(`INSERT INTO news_items (guid, source, title, url, published_at, fetched_at)
              VALUES (@guid, @source, @title, @url, @published_at, @fetched_at)
              ON CONFLICT(guid) DO NOTHING`)
    .run(n);
  return info.changes > 0 ? info.lastInsertRowid : getNewsIdByGuid(n.guid);
}
export function getNewsIdByGuid(guid) {
  const r = getDb().prepare(`SELECT id FROM news_items WHERE guid = ?`).get(guid);
  return r ? r.id : null;
}
export function recentNews(limit = 60) {
  return getDb()
    .prepare(`SELECT * FROM news_items ORDER BY datetime(COALESCE(published_at, fetched_at)) DESC, id DESC LIMIT ?`)
    .all(limit);
}
export function countNews() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM news_items`).get().n;
}

// --- sentiment ---
export function saveSentiment(s) {
  getDb()
    .prepare(`INSERT INTO news_sentiment (news_id, asset_id, score, method)
              VALUES (@news_id, @asset_id, @score, @method)
              ON CONFLICT(news_id, asset_id) DO UPDATE SET score=excluded.score, method=excluded.method`)
    .run(s);
}
export function getSentiment(newsId, assetId) {
  return getDb()
    .prepare(`SELECT * FROM news_sentiment WHERE news_id = ? AND asset_id = ?`)
    .get(newsId, assetId);
}
// Новости с сентиментом по активу (для карточки прогноза)
export function assetNews(assetId, limit = 8) {
  return getDb()
    .prepare(`SELECT n.title, n.url, n.source, n.published_at, s.score, s.method
              FROM news_sentiment s JOIN news_items n ON n.id = s.news_id
              WHERE s.asset_id = ?
              ORDER BY datetime(COALESCE(n.published_at, n.fetched_at)) DESC LIMIT ?`)
    .all(assetId, limit);
}

// --- predictions ---
export function insertPrediction(p) {
  const info = getDb()
    .prepare(`INSERT INTO predictions
      (asset_id, snapshot_id, base_price, direction, score, confidence, momentum, sentiment,
       news_count, risks_json, drivers_json, created_at)
      VALUES (@asset_id, @snapshot_id, @base_price, @direction, @score, @confidence, @momentum,
       @sentiment, @news_count, @risks_json, @drivers_json, @created_at)`)
    .run(p);
  return info.lastInsertRowid;
}
// Вставка уже сверённого прогноза (бэктест-история из seed). Нужна, чтобы метрика
// точности показывала реальное число даже на холодном serverless-инстансе, где
// /tmp эфемерна и живая сверка между запросами не накапливается.
export function insertHistoryPrediction(p) {
  getDb()
    .prepare(`INSERT INTO predictions
      (asset_id, snapshot_id, base_price, direction, score, confidence, momentum, sentiment,
       news_count, risks_json, drivers_json, created_at, resolved_price, resolved_at, actual_dir, hit)
      VALUES (@asset_id, 0, @base_price, @direction, @score, @confidence, @momentum, @sentiment,
       @news_count, @risks_json, @drivers_json, @created_at, @resolved_price, @resolved_at, @actual_dir, @hit)`)
    .run(p);
}

export function latestPrediction(assetId) {
  return getDb()
    .prepare(`SELECT * FROM predictions WHERE asset_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`)
    .get(assetId);
}
// Предыдущий ещё не сверенный прогноз (для resolve постфактум)
export function unresolvedBefore(assetId, beforeIso) {
  return getDb()
    .prepare(`SELECT * FROM predictions WHERE asset_id = ? AND hit IS NULL AND datetime(created_at) < datetime(?)
              ORDER BY datetime(created_at) DESC LIMIT 1`)
    .get(assetId, beforeIso);
}
export function resolvePrediction(id, patch) {
  getDb()
    .prepare(`UPDATE predictions SET resolved_price=@resolved_price, resolved_at=@resolved_at,
              actual_dir=@actual_dir, hit=@hit WHERE id=@id`)
    .run({ id, ...patch });
}
export function accuracy() {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS resolved, COALESCE(SUM(hit),0) AS hits FROM predictions WHERE hit IS NOT NULL`)
    .get();
  return { resolved: r.resolved, hits: r.hits, rate: r.resolved ? r.hits / r.resolved : null };
}
export function countPredictions() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM predictions`).get().n;
}
