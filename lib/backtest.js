// Настоящий walk-forward бэктест ЦЕНОВОГО сигнала на реальной истории (CoinGecko).
// Честно: сентимент новостей исторически недоступен, поэтому бэктестим момент-сигнал
// (динамика цены). Прогноз в день T строится из данных ДО T и сверяется с фактическим
// движением T→T+1. Сравнение с тупым бейзлайном (всегда самый частый класс) показывает,
// есть ли у модели edge над «угадать большинство».
import { ASSETS } from "./assets.js";
import { cgGet } from "./coingecko.js";
import { momentumSignal, combineScore, directionOf, actualDirection } from "./predict.js";

const BASE = "https://api.coingecko.com/api/v3";

async function dailyPrices(id, days = 40) {
  const url = `${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const data = await cgGet(url);
  return (data.prices || []).map((p) => p[1]); // массив дневных цен
}

// Прогон одного актива. Возвращает массив { dir, actual } по дням.
function walkForward(prices) {
  const rows = [];
  for (let t = 7; t < prices.length - 1; t++) {
    const chg24h = ((prices[t] - prices[t - 1]) / prices[t - 1]) * 100;
    const chg7d = ((prices[t] - prices[t - 7]) / prices[t - 7]) * 100;
    const dir = directionOf(combineScore({ momentum: momentumSignal(chg24h, chg7d) }));
    const actual = actualDirection(prices[t], prices[t + 1]); // следующий день, порог 1%
    rows.push({ dir, actual });
  }
  return rows;
}

// Полный бэктест по всем активам. Ограниченный параллелизм — CoinGecko free строгий.
export async function runBacktest(days = 40) {
  const all = [];
  const ids = ASSETS.map((a) => a.id);
  for (let i = 0; i < ids.length; i += 2) {
    const batch = ids.slice(i, i + 2);
    const res = await Promise.all(
      batch.map(async (id) => {
        try {
          return walkForward(await dailyPrices(id, days));
        } catch {
          return [];
        }
      })
    );
    for (const r of res) all.push(...r);
  }

  const n = all.length;
  if (!n) return null;
  const hits = all.filter((r) => r.dir === r.actual).length;
  // бейзлайн: всегда предсказывать самый частый фактический класс
  const counts = { up: 0, down: 0, flat: 0 };
  for (const r of all) counts[r.actual]++;
  const majority = Math.max(counts.up, counts.down, counts.flat);

  return {
    days,
    n,
    accuracy: hits / n,
    baseline: majority / n, // «всегда угадывай большинство»
    edge: (hits - majority) / n, // насколько модель лучше тупого бейзлайна
    computed_at: null, // проставляется снаружи (Date недоступен в некоторых окружениях сборки)
  };
}
