// Запекает текущее состояние базы в data/seed.json — офлайн-снапшот для холодного
// старта на serverless и демо без сети. Запуск после живого ingest:
//   node --env-file=.env scripts/build-seed.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../lib/db.js";
import { ASSETS, matchAssets } from "../lib/assets.js";

const db = getDb();

// последние 2 снимка по каждому активу (нужны для тренда объёма на холодном старте)
const snapshots = [];
for (const a of ASSETS) {
  const rows = db
    .prepare(`SELECT asset_id, price, volume, chg_24h, chg_7d, fetched_at FROM price_snapshots
              WHERE asset_id = ? ORDER BY datetime(fetched_at) DESC, id DESC LIMIT 2`)
    .all(a.id);
  // вставляем в хронологическом порядке (старый раньше), чтобы история читалась верно
  for (const s of rows.reverse()) snapshots.push(s);
}

// новости с сентиментом, до 12 свежих на актив (seed компактный; живой сбор тянет
// полный объём NEWS_PER_COIN). Cold-start и офлайн-демо показывают репрезентативную выборку.
const rows = db
  .prepare(`SELECT guid, source, title, url, published_at, fetched_at, asset_id, score, method FROM (
              SELECT n.guid, n.source, n.title, n.url, n.published_at, n.fetched_at,
                     s.asset_id, s.score, s.method,
                     ROW_NUMBER() OVER (PARTITION BY s.asset_id
                       ORDER BY datetime(COALESCE(n.published_at, n.fetched_at)) DESC) AS rn
              FROM news_items n JOIN news_sentiment s ON s.news_id = n.id
            ) WHERE rn <= 12`)
  .all();

const byGuid = {};
for (const r of rows) {
  if (!byGuid[r.guid]) {
    byGuid[r.guid] = {
      guid: r.guid, source: r.source, title: r.title, url: r.url,
      published_at: r.published_at, fetched_at: r.fetched_at,
      score: r.score, method: r.method, assets: [],
    };
  }
  byGuid[r.guid].assets.push(r.asset_id);
}
const news = Object.values(byGuid);

// сверённые прогнозы (бэктест) — чтобы метрика точности была ненулевой и на холодном
// serverless-инстансе. Это реальные прогоны, а не выдумка.
const history = db
  .prepare(`SELECT asset_id, base_price, direction, score, confidence, momentum, sentiment,
                   news_count, risks_json, drivers_json, created_at, resolved_price, resolved_at,
                   actual_dir, hit
            FROM predictions WHERE hit IS NOT NULL ORDER BY id`)
  .all();

const seed = { generated_at: new Date().toISOString(), snapshots, news, history };
const dest = path.join(process.cwd(), "data", "seed.json");
writeFileSync(dest, JSON.stringify(seed, null, 2));
console.log(`seed.json: ${snapshots.length} снимков, ${news.length} новостей, ${history.length} сверённых прогнозов → ${dest}`);
