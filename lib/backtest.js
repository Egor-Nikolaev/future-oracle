// Исследовательский харнесс: честный walk-forward бэктест на длинной истории.
// Меряет ДВЕ задачи и сравнивает с бейзлайнами, чтобы видеть реальный edge:
//   A) НАПРАВЛЕНИЕ (up/down/flat) — краткосрочно ≈ случайно, тут edge почти нет;
//   B) ВОЛАТИЛЬНОСТЬ (будет ли крупное движение) — кластеризуется, тут edge есть.
// Порог калибруется на train-части и проверяется на out-of-sample test (без подглядывания).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ASSETS } from "./assets.js";
import { cgGet } from "./coingecko.js";
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

// Признаки и метки по дням одного актива.
function featurize(prices) {
  const rows = [];
  for (let t = 7; t < prices.length - 1; t++) {
    const chg24h = ((prices[t] - prices[t - 1]) / prices[t - 1]) * 100;
    const chg7d = ((prices[t] - prices[t - 7]) / prices[t - 7]) * 100;
    const rets = [];
    for (let k = t - 6; k <= t; k++) rets.push(((prices[k] - prices[k - 1]) / prices[k - 1]) * 100);
    const realizedVol = std(rets); // недельная реализованная волатильность
    const nextRet = ((prices[t + 1] - prices[t]) / prices[t]) * 100;
    rows.push({
      momentum: momentumSignal(chg24h, chg7d),
      realizedVol,
      actualDir: actualDirection(prices[t], prices[t + 1]),
      bigMove: Math.abs(nextRet) > BIG_MOVE_PCT ? 1 : 0,
    });
  }
  return rows;
}

function majorityClass(rows, key) {
  const c = {};
  for (const r of rows) c[r[key]] = (c[r[key]] || 0) + 1;
  let best = null, bestN = -1;
  for (const [k, n] of Object.entries(c)) if (n > bestN) { best = k; bestN = n; }
  return { cls: best, rate: rows.length ? bestN / rows.length : 0, counts: c };
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
  const perAssetRows = {};
  const all = [];
  for (let i = 0; i < ids.length; i += 2) {
    const batch = ids.slice(i, i + 2);
    const res = await Promise.all(batch.map(async (id) => {
      try { return { id, rows: featurize(await dailyPrices(id, days, cache)) }; }
      catch { return { id, rows: [] }; }
    }));
    for (const r of res) { perAssetRows[r.id] = r.rows; all.push(...r.rows); }
  }
  saveCache(cache);
  if (all.length < 30) return null;

  // train/test split 60/40 по каждому активу (без перемешивания — walk-forward)
  const train = [], test = [];
  for (const id of ids) {
    const rows = perAssetRows[id] || [];
    const cut = Math.floor(rows.length * 0.6);
    train.push(...rows.slice(0, cut));
    test.push(...rows.slice(cut));
  }

  const direction = evalDirection(train, test);
  const volatility = evalVolatility(train, test);

  // per-asset: текущая реализованная волатильность и риск-режим (для карточек)
  const thr = volatility.threshold;
  const per_asset = {};
  for (const id of ids) {
    const rows = perAssetRows[id] || [];
    const rv = rows.length ? rows[rows.length - 1].realizedVol : null;
    per_asset[id] = {
      realized_vol: rv != null ? Number(rv.toFixed(2)) : null,
      risk: rv == null ? "n/a" : rv > thr ? "high" : rv > thr * 0.6 ? "medium" : "low",
      big_move_expected: rv != null ? rv > thr : null,
    };
  }

  return {
    days,
    direction,     // A: близко к бейзлайну (edge ~0) — честно
    volatility,    // B: бьёт бейзлайн — где реальный edge
    ablation: ablation(all),
    per_asset,
    computed_at: null,
  };
}
