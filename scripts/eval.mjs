// Эвал слоя прогноза: юнит-тесты чистой логики scoring + проверка воспроизводимости
// («цифры сходятся»). Валит процесс ненулевым кодом при любом провале — годится для CI.
// Запуск: npm run eval   (LLM/сеть не нужны, тестируется детерминированное ядро)
import {
  momentumSignal, combineScore, directionOf, confidenceOf,
  buildPrediction, actualDirection, DIR_THRESHOLD, volumeTrendOf, fundingSignal,
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

// combine: взвешенное среднее по присутствующим сигналам (нормируется)
ok("только моментум → балл = моментум", approx(combineScore({ momentum: 0.5 }), 0.5));
ok("моментум+сентимент → нормированное среднее", approx(combineScore({ momentum: 1, sentiment: -1 }), round2((0.45 - 0.35) / 0.8)));
ok("три сигнала согласны → балл того же знака", combineScore({ momentum: 0.6, sentiment: 0.6, funding: 0.6 }) > 0.5);
ok("funding против цены тянет балл вниз", combineScore({ momentum: 0.6, sentiment: null, funding: -0.6 }) < 0.6);

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
ok("балл пересчитывается из сигналов (funding здесь нет)",
  approx(p1.score, combineScore({ momentum: p1.momentum, sentiment: p1.sentiment, funding: p1.funding })));
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

// объём: тренд из двух снимков и его влияние на прогноз
ok("тренд объёма: рост", volumeTrendOf(120, 100).trend === "up");
ok("тренд объёма: падение", volumeTrendOf(80, 100).trend === "down");
ok("тренд объёма: мелкое колебание = стабилен", volumeTrendOf(105, 100).trend === "flat");
ok("тренд объёма: нет истории → null", volumeTrendOf(100, null).trend === null);
const volUp = confidenceOf({ score: 0.4, momentum: 0.4, sentiment: null, newsCount: 0, chg24h: 2, volumeTrend: "up" });
const volDown = confidenceOf({ score: 0.4, momentum: 0.4, sentiment: null, newsCount: 0, chg24h: 2, volumeTrend: "down" });
ok("растущий объём подтверждает направление (уверенность выше)", volUp > volDown);
const pv = buildPrediction({ snapshot: { chg_24h: 5, chg_7d: 12, price: 1, volume: 80 }, prevSnapshot: { volume: 100 }, sentiments: [0.5] });
ok("движение на падающем объёме помечено риском", pv.risks.some((r) => r.includes("падающем объёме")));
ok("объём попадает в 'что повлияло'", pv.drivers.some((d) => d.startsWith("Объём за 24ч")));

// funding как сигнал позиционирования
ok("funding null → сигнал null", fundingSignal(null) === null);
ok("положительный funding → бычий сигнал", fundingSignal(0.0003) > 0);
ok("отрицательный funding → медвежий сигнал", fundingSignal(-0.0003) < 0);
ok("funding нормируется в [-1..1]", fundingSignal(0.01) === 1 && fundingSignal(-0.01) === -1);
const fUp = buildPrediction({ snapshot: { chg_24h: 4, chg_7d: 8, price: 1, funding: 0.0004 }, sentiments: [] });
const fDn = buildPrediction({ snapshot: { chg_24h: 4, chg_7d: 8, price: 1, funding: -0.0004 }, sentiments: [] });
ok("funding по движению даёт больше уверенности, чем против", fUp.confidence > fDn.confidence);
ok("funding попадает в 'что повлияло'", fUp.drivers.some((d) => d.startsWith("Funding")));
ok("funding против цены помечен риском", fDn.risks.some((r) => r.includes("Плечо")));

function round2(x) { return Number(x.toFixed(3)); }

console.log(`\nИтог: ${pass} прошло, ${fail} провалено.`);
if (fail > 0) {
  console.error("ЭВАЛ ПРОВАЛЕН");
  process.exit(1);
}
console.log("Эвал зелёный.");
