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
