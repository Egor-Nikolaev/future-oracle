// Сигнал с реальным edge: деривативы Binance Futures (без ключа).
// funding rate — кто платит за плечо: положительный = лонги переполнены (бычье
// позиционирование), отрицательный = шорты. open interest — размер плеча в рынке.
import { ASSETS } from "./assets.js";

const FAPI = "https://fapi.binance.com/fapi/v1";

// coingecko id → тикер бессрочного контракта Binance
const SYMBOL = {
  bitcoin: "BTCUSDT", ethereum: "ETHUSDT", solana: "SOLUSDT", binancecoin: "BNBUSDT",
  ripple: "XRPUSDT", dogecoin: "DOGEUSDT", cardano: "ADAUSDT", "avalanche-2": "AVAXUSDT",
};

async function j(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json();
}

const SYM = SYMBOL;

// История funding-ставок, агрегированная в дневные средние (самые свежие в конце).
// Binance отдаёт 8-часовые ставки; ~1000 записей ≈ 330 дней. Для бэктеста сигнала.
export async function fundingHistory(id, days = 365) {
  const sym = SYM[id];
  if (!sym) return [];
  let raw;
  try {
    raw = await j(`${FAPI}/fundingRate?symbol=${sym}&limit=1000`);
  } catch {
    return [];
  }
  const byDay = new Map(); // YYYY-MM-DD → [ставки]
  for (const r of raw || []) {
    const d = new Date(r.fundingTime).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(Number(r.fundingRate));
  }
  const daily = [...byDay.keys()].sort().map((d) => {
    const a = byDay.get(d);
    return a.reduce((s, x) => s + x, 0) / a.length;
  });
  return daily.slice(-days);
}

// Возвращает map asset_id → { funding, open_interest } (null-поля при сбое).
export async function fetchDerivatives(ids = ASSETS.map((a) => a.id)) {
  const out = {};
  await Promise.all(
    ids.map(async (id) => {
      const sym = SYMBOL[id];
      out[id] = { funding: null, open_interest: null };
      if (!sym) return;
      try {
        const [pi, oi] = await Promise.all([
          j(`${FAPI}/premiumIndex?symbol=${sym}`),
          j(`${FAPI}/openInterest?symbol=${sym}`),
        ]);
        out[id] = {
          funding: pi?.lastFundingRate != null ? Number(pi.lastFundingRate) : null,
          open_interest: oi?.openInterest != null ? Number(oi.openInterest) : null,
        };
      } catch {
        /* оставляем null — funding-сигнал просто не участвует */
      }
    })
  );
  return out;
}
