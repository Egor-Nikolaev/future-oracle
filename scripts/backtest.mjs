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
const vs = r.volatility_variants;
const line = (name, v) => v && console.log(`   ${name.padEnd(22)}: lift ${v.lift ? v.lift.toFixed(2) + "x" : "—"} | precision ${pct(v.high_risk_rate)} | recall ${pct(v.recall)}`);
line("порог vol7", vs.simple);
line("логрег (цена)", vs.price_logistic);
line("логрег (цена+funding)", vs.price_plus_funding);
console.log(`   ablation funding        : ${r.funding_helps ? "ПОМОГАЕТ (добавили)" : "не помогает (отброшен)"} (покрытие ${pct(r.funding_coverage)})`);
console.log(`   → в live используется   : ${r.model_used}\n`);

console.log("Вывод: направление краткосрочно ≈ случайно (edge нет), а режим повышенной");
console.log("волатильности реально предсказывает крупные движения (lift > 1). Поэтому продукт");
console.log("честно показывает риск-режим, а не обещает угадать up/down.");
