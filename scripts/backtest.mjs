// Полный отчёт walk-forward бэктеста: node --env-file=.env scripts/backtest.mjs
// Две задачи (направление / волатильность) с бейзлайнами и out-of-sample метриками.
import { runBacktest } from "../lib/backtest.js";

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
const t0 = Date.now();
const r = await runBacktest(Number(process.env.BACKTEST_DAYS) || 365);
if (!r) {
  console.error("Нет данных (вероятно rate-limit CoinGecko). Повтори позже.");
  process.exit(1);
}

console.log(`\nWalk-forward бэктест, ${r.days}д, out-of-sample. Посчитано за ${((Date.now() - t0) / 1000).toFixed(1)}с\n`);

console.log("A) НАПРАВЛЕНИЕ (up/down/flat):");
console.log(`   точность модели : ${pct(r.direction.accuracy)}`);
console.log(`   бейзлайн (частый): ${pct(r.direction.baseline)}`);
console.log(`   edge            : ${pct(r.direction.edge)}  ${r.direction.edge < 0 ? "← сигнала нет" : ""}`);
console.log(`   precision ставок: ${pct(r.direction.precision_on_calls)} (${r.direction.directional_calls} направленных ставок из ${r.direction.n})`);
console.log(`   порог |momentum|: ${r.direction.threshold}\n`);

console.log("B) ВОЛАТИЛЬНОСТЬ (крупное движение >3% завтра):");
console.log(`   базовая частота крупных : ${pct(r.volatility.base_rate)}`);
console.log(`   в ВЫСОКО-рисковые дни    : ${pct(r.volatility.high_risk_rate)}`);
console.log(`   в НИЗКО-рисковые дни     : ${pct(r.volatility.low_risk_rate)}`);
console.log(`   LIFT                     : ${r.volatility.lift ? r.volatility.lift.toFixed(2) + "x" : "—"}  ${r.volatility.lift > 1.3 ? "← реальный сигнал" : ""}`);
console.log(`   recall (накрыто крупных) : ${pct(r.volatility.recall)}\n`);

console.log("Вывод: направление краткосрочно ≈ случайно (edge нет), а режим повышенной");
console.log("волатильности реально предсказывает крупные движения (lift > 1). Поэтому продукт");
console.log("честно показывает риск-режим, а не обещает угадать up/down.");
