// Эвал слоя прогноза: юнит-тесты чистой логики scoring + проверка воспроизводимости
// («цифры сходятся»). Валит процесс ненулевым кодом при любом провале — годится для CI.
// Запуск: npm run eval   (LLM/сеть не нужны, тестируется детерминированное ядро)
import {
  momentumSignal, combineScore, directionOf, confidenceOf,
  buildPrediction, actualDirection, DIR_THRESHOLD,
} from "../lib/predict.js";
import { matchAssets } from "../lib/assets.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
const approx = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

console.log("Юнит-тесты ядра прогноза:\n");

// momentum: границы и монотонность
ok("моментум в [-1..1]", momentumSignal(999, 999) === 1 && momentumSignal(-999, -999) === -1);
ok("моментум нейтрален на нуле", momentumSignal(0, 0) === 0);
ok("рост цены → положительный моментум", momentumSignal(4, 10) > 0);
ok("падение цены → отрицательный моментум", momentumSignal(-4, -10) < 0);
ok("24ч весит больше 7д", momentumSignal(6, 0) > momentumSignal(0, 6));

// combine: с новостями и без
ok("без сентимента балл = 0.8·моментум", approx(combineScore(0.5, null), 0.4));
ok("с сентиментом балл = взвешенная сумма", approx(combineScore(1, -1), round2(0.55 - 0.45)));

// direction по порогу
ok("выше порога → up", directionOf(DIR_THRESHOLD) === "up");
ok("ниже -порога → down", directionOf(-DIR_THRESHOLD) === "down");
ok("около нуля → flat", directionOf(0) === "flat");

// confidence: потолок, согласие/спор
ok("уверенность ≤ 92 (нет 100%)", confidenceOf({ score: 1, momentum: 1, sentiment: 1, newsCount: 9, chg24h: 1 }) <= 92);
ok("уверенность ≥ 5", confidenceOf({ score: 0, momentum: 0, sentiment: null, newsCount: 0, chg24h: 0 }) >= 5);
const agree = confidenceOf({ score: 0.5, momentum: 0.5, sentiment: 0.5, newsCount: 4, chg24h: 1 });
const argue = confidenceOf({ score: 0.5, momentum: 0.5, sentiment: -0.5, newsCount: 4, chg24h: 1 });
ok("согласие сигналов даёт больше уверенности, чем спор", agree > argue);
ok("высокая волатильность снижает уверенность",
  confidenceOf({ score: 0.5, momentum: 0.5, sentiment: 0.5, newsCount: 4, chg24h: 20 }) <
  confidenceOf({ score: 0.5, momentum: 0.5, sentiment: 0.5, newsCount: 4, chg24h: 1 }));

// actualDirection (сверка постфактум)
ok("рост цены → факт up", actualDirection(100, 103) === "up");
ok("падение цены → факт down", actualDirection(100, 97) === "down");
ok("мелкое движение → факт flat", actualDirection(100, 100.5) === "flat");

// buildPrediction: воспроизводимость («цифры сходятся»)
const snap = { chg_24h: 5, chg_7d: 12, price: 60000 };
const p1 = buildPrediction({ snapshot: snap, sentiments: [0.4, 0.6, 0.2] });
const p2 = buildPrediction({ snapshot: snap, sentiments: [0.4, 0.6, 0.2] });
ok("прогноз детерминирован (одинаковый вход → одинаковый выход)", JSON.stringify(p1) === JSON.stringify(p2));
ok("балл пересчитывается из моментума и сентимента",
  approx(p1.score, combineScore(p1.momentum, p1.sentiment)));
ok("направление согласовано с баллом", p1.direction === directionOf(p1.score));
ok("без новостей сентимент = null, риск про отсутствие новостей",
  buildPrediction({ snapshot: snap, sentiments: [] }).sentiment === null &&
  buildPrediction({ snapshot: snap, sentiments: [] }).risks.some((r) => r.includes("Нет свежих новостей")));

// сценарий «спорят»: бычьи цифры + медвежьи новости → уверенность ниже согласного
const conflict = buildPrediction({ snapshot: { chg_24h: 5, chg_7d: 10, price: 1 }, sentiments: [-0.8, -0.6] });
ok("конфликт цифр и новостей помечен риском",
  conflict.risks.some((r) => r.includes("спорят")));

// привязка новостей к активам: полные имена ловятся, ложные подстроки — нет
const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
ok("полное имя актива ловится", eq(matchAssets("Solana trading launches"), ["solana"]));
ok("несколько активов в заголовке", eq(matchAssets("Bitcoin, Ether, Solana"), ["bitcoin", "ethereum", "solana"]));
ok("тикер с $ ловится", eq(matchAssets("$BTC breaks 60k"), ["bitcoin"]));
ok("ложная подстрока тикера НЕ ловится (Sol в Sol Ultrafast)", eq(matchAssets("GPT-5.6 Sol Ultrafast"), []));
ok("имя человека 'Ada' НЕ ловится как ADA", eq(matchAssets("Ada Lovelace museum"), []));

function round2(x) { return Number(x.toFixed(3)); }

console.log(`\nИтог: ${pass} прошло, ${fail} провалено.`);
if (fail > 0) {
  console.error("ЭВАЛ ПРОВАЛЕН");
  process.exit(1);
}
console.log("Эвал зелёный.");
