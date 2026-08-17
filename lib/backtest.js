// Исследовательский харнесс: честный walk-forward бэктест на длинной истории.
// Меряет ДВЕ задачи и сравнивает с бейзлайнами, чтобы видеть реальный edge:
//   A) НАПРАВЛЕНИЕ (up/down/flat) — краткосрочно ≈ случайно, тут edge почти нет;
//   B) ВОЛАТИЛЬНОСТЬ (будет ли крупное движение) — кластеризуется, тут edge есть.
// Порог калибруется на train-части и проверяется на out-of-sample test (без подглядывания).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ASSETS } from "./assets.js";
import { cgGet } from "./coingecko.js";
import { fundingHistory } from "./binance.js";
import { dataDir } from "./db.js";
import { momentumSignal, combineScore, directionOf, actualDirection } from "./predict.js";

const BASE = "https://api.coingecko.com/api/v3";
const BIG_MOVE_PCT = 3; // «крупное движение» = |изменение за день| > 3%

// Кэш дневной истории на диск — CoinGecko free строгий по лимитам, а история за день
// не меняется. Резко снижает число обращений (важно и для seed-регенерации, и для прода).
function cachePath() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "history-cache.json");
}
function loadCache() {
  try { return JSON.parse(readFileSync(cachePath(), "utf8")); } catch { return {}; }
}
function saveCache(c) {
  try { writeFileSync(cachePath(), JSON.stringify(c)); } catch { /* прод /tmp может быть readonly — не критично */ }
}
const CACHE_TTL_H = 12;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

async function dailyPrices(id, days = 365, cache = null) {
  const now = Date.now();
  if (cache && cache[id] && now - cache[id].at < CACHE_TTL_H * 3.6e6) {
    return cache[id].prices;
  }
  const data = await cgGet(`${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
  const prices = (data.prices || []).map((p) => p[1]);
  if (cache && prices.length) cache[id] = { at: now, prices };
  return prices;
}

// Дневные доходности в %.
function dailyReturns(prices) {
  const r = [0];
  for (let i = 1; i < prices.length; i++) r.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  return r;
}
const volOf = (rets, t, w) => std(rets.slice(Math.max(1, t - w + 1), t + 1));

// Признаки и метки по дням одного актива.
//   f     — ценовые фичи (окна волатильности + давность крупного движения);
//   fFund — те же + funding (уровень и |экстремум|), выровнены по хвосту серии.
// funding — дневной ряд funding-ставок (может быть короче/пустым).
function featurize(prices, funding = []) {
  const rets = dailyReturns(prices);
  const rows = [];
  const Lf = funding.length;
  const Lp = prices.length;
  for (let t = 14; t < prices.length - 1; t++) {
    const chg24h = rets[t];
    const chg7d = ((prices[t] - prices[t - 7]) / prices[t - 7]) * 100;
    const vol3 = volOf(rets, t, 3), vol7 = volOf(rets, t, 7), vol14 = volOf(rets, t, 14);
    let since = 14;
    for (let k = 1; k <= 14 && t - k >= 1; k++) if (Math.abs(rets[t - k]) > BIG_MOVE_PCT) { since = k; break; }
    const f = [vol3, vol7, vol14, Math.abs(rets[t]), since];
    // funding, выровненный по хвосту: последний день funding ↔ последний день цены
    const fi = Lf - 1 - (Lp - 1 - t);
    const fund = fi >= 0 ? funding[fi] : null;
    const fundAbs = fund != null ? Math.abs(fund) * 1e4 : 0; // экстремум плеча (в б.п.)
    const fundLvl = fund != null ? fund * 1e4 : 0;
    rows.push({
      momentum: momentumSignal(chg24h, chg7d),
      realizedVol: vol7,
      f,
      fFund: [...f, fundLvl, fundAbs],
      hasFund: fund != null,
      actualDir: actualDirection(prices[t], prices[t + 1]),
      bigMove: Math.abs(rets[t + 1]) > BIG_MOVE_PCT ? 1 : 0,
    });
  }
  return rows;
}

// --- лёгкая логистическая регрессия (обучаем на train, применяем на test) ---
function standardizer(rows, key = "f") {
  const d = rows[0][key].length;
  const mean = Array(d).fill(0), sd = Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[key][j];
  for (let j = 0; j < d; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) sd[j] += (r[key][j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / rows.length) || 1;
  return { mean, sd, apply: (f) => f.map((x, j) => (x - mean[j]) / sd[j]) };
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function trainLogistic(rows, std0, key = "f", { iters = 400, lr = 0.1, l2 = 0.001 } = {}) {
  const d = rows[0][key].length;
  let w = Array(d).fill(0), b = 0;
  const X = rows.map((r) => std0.apply(r[key]));
  const y = rows.map((r) => r.bigMove);
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(w.reduce((s, wj, j) => s + wj * X[i][j], b));
      const e = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b, predict: (f) => sigmoid(w.reduce((s, wj, j) => s + wj * std0.apply(f)[j], b)) };
}

function majorityClass(rows, key) {
  const c = {};
  for (const r of rows) c[r[key]] = (c[r[key]] || 0) + 1;
  let best = null, bestN = -1;
  for (const [k, n] of Object.entries(c)) if (n > bestN) { best = k; bestN = n; }
  return { cls: best, rate: rows.length ? bestN / rows.length : 0, counts: c };
}

// B2) ВОЛАТИЛЬНОСТЬ через логрег на нескольких фичах. Обучаем на train, на test берём
// топ-треть по предсказанной вероятности как «высокий риск» и меряем lift/recall/precision.
function evalVolatilityModel(train, test, key = "f") {
  const std0 = standardizer(train, key);
  const model = trainLogistic(train, std0, key);
  const probs = test.map((r) => ({ p: model.predict(r[key]), big: r.bigMove }));
  const baseRate = mean(test.map((r) => r.bigMove));
  const sorted = [...probs].sort((a, b) => b.p - a.p);
  const k = Math.max(1, Math.floor(sorted.length / 3)); // высокий риск = топ-треть
  const high = sorted.slice(0, k);
  const highRate = mean(high.map((r) => r.big));
  const totalBig = probs.filter((r) => r.big).length;
  const recall = totalBig ? high.filter((r) => r.big).length / totalBig : null;
  return {
    thr_prob: Number(sorted[k - 1].p.toFixed(3)), // порог вероятности для «высокого риска»
    base_rate: baseRate,
    high_risk_rate: highRate,
    lift: baseRate ? highRate / baseRate : null,
    recall,
    precision: highRate, // = доля крупных среди помеченных высоким риском
    coef: { w: model.w, b: model.b, mean: std0.mean, sd: std0.sd },
    n: test.length,
  };
}

// A) НАПРАВЛЕНИЕ: калибруем порог |momentum|, за которым зовём направление (иначе flat).
function evalDirection(train, test) {
  let bestThr = 0.12, bestAcc = -1;
  for (let thr = 0.05; thr <= 0.6; thr += 0.01) {
    const acc = accDir(train, thr);
    if (acc > bestAcc) { bestAcc = acc; bestThr = thr; }
  }
  const testAcc = accDir(test, bestThr);
  const base = majorityClass(test, "actualDir");
  // precision на НЕ-flat прогнозах (когда модель реально зовёт направление)
  let calls = 0, callHits = 0;
  for (const r of test) {
    const dir = Math.abs(r.momentum) >= bestThr ? (r.momentum > 0 ? "up" : "down") : "flat";
    if (dir !== "flat") { calls++; if (dir === r.actualDir) callHits++; }
  }
  return {
    threshold: Number(bestThr.toFixed(2)),
    accuracy: testAcc,
    baseline: base.rate,
    edge: testAcc - base.rate,
    directional_calls: calls,
    precision_on_calls: calls ? callHits / calls : null,
    n: test.length,
    classes: base.counts,
  };
}
const thrOf = (t) => t; // хелпер читаемости
function accDir(rows, thr) {
  let h = 0;
  for (const r of rows) {
    const dir = Math.abs(r.momentum) >= thr ? (r.momentum > 0 ? "up" : "down") : "flat";
    if (dir === r.actualDir) h++;
  }
  return rows.length ? h / rows.length : 0;
}

// B) ВОЛАТИЛЬНОСТЬ: крупные движения редки (~16%), поэтому «точность» вводит в заблуждение
// (всегда «нет движения» = 84%). Честная метрика — LIFT: среди дней, что модель пометила
// высоко-рисковыми (реализованная волатильность выше порога), доля крупных движений против
// базовой доли. Порог = 66-й перцентиль волатильности на TRAIN (режим повышенной волатильности).
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function evalVolatility(train, test) {
  const thr = percentile(train.map((r) => r.realizedVol), 0.66);
  const baseRate = mean(test.map((r) => r.bigMove));
  const high = test.filter((r) => r.realizedVol > thr);
  const low = test.filter((r) => r.realizedVol <= thr);
  const highRate = mean(high.map((r) => r.bigMove)); // P(крупное | высокий риск)
  const lowRate = mean(low.map((r) => r.bigMove));    // P(крупное | низкий риск)
  const captured = test.filter((r) => r.bigMove).length
    ? high.filter((r) => r.bigMove).length / test.filter((r) => r.bigMove).length
    : null; // recall: какую долю крупных движений накрыл высокий риск
  return {
    threshold: Number(thr.toFixed(2)),
    base_rate: baseRate,                                  // средняя частота крупных движений
    high_risk_rate: highRate,                             // частота крупных в высоко-рисковые дни
    low_risk_rate: lowRate,
    lift: baseRate ? highRate / baseRate : null,          // во сколько раз выше базовой
    recall: captured,                                     // сколько крупных движений накрыто
    high_days: high.length,
    n: test.length,
  };
}

// Ablation направления: чистый momentum-only против «всегда flat» — показывает, добавляет ли сигнал.
function ablation(all) {
  const base = majorityClass(all, "actualDir").rate;
  const momAcc = accDir(all, 0.12);
  return { always_flat: base, momentum_only: momAcc };
}

// Полный прогон. Возвращает метрики обеих задач + per-asset (волатильность/риск для live).
export async function runBacktest(days = 365) {
  const ids = ASSETS.map((a) => a.id);
  const cache = loadCache();
  // funding-история (best-effort) для ablation-сигнала
  const fundingById = {};
  await Promise.all(ids.map(async (id) => {
    try { fundingById[id] = await fundingHistory(id, days); } catch { fundingById[id] = []; }
  }));
  const perAssetRows = {};
  const all = [];
  for (let i = 0; i < ids.length; i += 2) {
    const batch = ids.slice(i, i + 2);
    const res = await Promise.all(batch.map(async (id) => {
      try { return { id, rows: featurize(await dailyPrices(id, days, cache), fundingById[id] || []) }; }
      catch { return { id, rows: [] }; }
    }));
    for (const r of res) { perAssetRows[r.id] = r.rows; all.push(...r.rows); }
  }
  saveCache(cache);
  if (all.length < 30) return null;
  const fundingCoverage = all.length ? all.filter((r) => r.hasFund).length / all.length : 0;

  // train/test split 60/40 по каждому активу (без перемешивания — walk-forward)
  const train = [], test = [];
  for (const id of ids) {
    const rows = perAssetRows[id] || [];
    const cut = Math.floor(rows.length * 0.6);
    train.push(...rows.slice(0, cut));
    test.push(...rows.slice(cut));
  }

  const direction = evalDirection(train, test);
  const volSimple = evalVolatility(train, test);             // один порог realizedVol
  const volPrice = evalVolatilityModel(train, test, "f");    // логрег: только цена
  const volFund = fundingCoverage > 0.3
    ? evalVolatilityModel(train, test, "fFund")              // логрег: цена + funding (ablation)
    : null;

  // Выбор live-модели: логрег даёт вероятность и высокий recall. Берём +funding, только
  // если funding РЕАЛЬНО добавляет lift (иначе — честно отбрасываем как шум). Fallback на
  // порог, если лог-регрессия не показала edge.
  const fundHelps = volFund && volFund.lift > volPrice.lift + 0.05;
  const chosen = fundHelps ? volFund : volPrice;
  const useModel = (chosen.lift || 0) >= 1.3;
  const featKey = fundHelps ? "fFund" : "f";
  const coef = chosen.coef;

  const per_asset = {};
  for (const id of ids) {
    const rows = perAssetRows[id] || [];
    const last = rows.length ? rows[rows.length - 1] : null;
    if (!last) { per_asset[id] = { realized_vol: null, risk: "n/a", prob_big_move: null, big_move_expected: null }; continue; }
    let prob = null, high;
    if (useModel) {
      prob = applyLogistic(coef, last[featKey]);
      high = prob >= chosen.thr_prob;
    } else {
      high = last.realizedVol > volSimple.threshold;
    }
    per_asset[id] = {
      realized_vol: Number(last.realizedVol.toFixed(2)),
      prob_big_move: prob != null ? Number(prob.toFixed(3)) : null,
      risk: high ? "high" : (prob != null ? (prob >= chosen.thr_prob * 0.6 ? "medium" : "low")
                                          : (last.realizedVol > volSimple.threshold * 0.6 ? "medium" : "low")),
      big_move_expected: high,
    };
  }

  return {
    days,
    direction,                                   // A: edge нет — честно
    volatility: useModel ? chosen : volSimple,   // основная (лучшая) метрика
    volatility_variants: { simple: volSimple, price_logistic: volPrice, price_plus_funding: volFund },
    funding_helps: !!fundHelps,
    funding_coverage: Number(fundingCoverage.toFixed(2)),
    model_used: useModel ? (fundHelps ? "logistic+funding" : "logistic") : "threshold",
    ablation: ablation(all),
    per_asset,
    computed_at: null,
  };
}

// применить сохранённые коэффициенты логрега к вектору фич
function applyLogistic(coef, f) {
  const z = coef.w.reduce((s, wj, j) => s + wj * ((f[j] - coef.mean[j]) / (coef.sd[j] || 1)), coef.b);
  return 1 / (1 + Math.exp(-z));
}
export { applyLogistic };
