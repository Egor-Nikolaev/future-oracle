// Живой цикл обновления из терминала: node --env-file=.env scripts/ingest.mjs
// Тянет цены (CoinGecko) + новости (RSS), считает сентимент, сверяет прошлые
// прогнозы с фактом и строит новые. Печатает отчёт.
import { refreshAll } from "../lib/ingest.js";
import { accuracy, latestPrediction } from "../lib/db.js";
import { ASSETS } from "../lib/assets.js";

const t0 = Date.now();
const res = await refreshAll();
console.log(`\nОбновлено за ${((Date.now() - t0) / 1000).toFixed(1)}с:`);
console.log(`  активов: ${res.assets} | новостей с привязкой: ${res.news} | прогнозов: ${res.predictions}`);

console.log("\nТекущие прогнозы:");
for (const a of ASSETS) {
  const p = latestPrediction(a.id);
  if (!p) continue;
  const sent = p.sentiment == null ? "—" : (p.sentiment > 0 ? "+" : "") + p.sentiment;
  console.log(
    `  ${a.symbol.padEnd(5)} ${p.direction.padEnd(5)} балл ${String(p.score).padStart(6)} ` +
    `увер ${String(p.confidence).padStart(3)}% | момент ${p.momentum} сентимент ${sent} (${p.news_count} нов.)`
  );
}

const acc = accuracy();
console.log(
  `\nТочность: ${acc.resolved ? Math.round(acc.rate * 100) + "% (" + acc.hits + "/" + acc.resolved + ")" : "копится (нужно 2+ обновления)"}`
);
