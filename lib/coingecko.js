// Источник A (цифры): CoinGecko free API. Ключ не нужен.
// Тянем цену, объём и изменения за 24ч/7д одним запросом по списку активов.
import { ASSET_IDS } from "./assets.js";

const BASE = "https://api.coingecko.com/api/v3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET с ретраем на 429/5xx (CoinGecko free строгий по лимитам).
export async function cgGet(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1500 * i); // 0, 1.5, 3, 4.5с — расходимся при лимите
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`CoinGecko ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    return res.json();
  }
  throw lastErr || new Error("CoinGecko: не удалось");
}

// Возвращает массив { asset_id, price, volume, chg_24h, chg_7d, fetched_at }.
// На сбой сети бросает — вызывающий решает, что делать (фолбэк на снапшот).
export async function fetchMarkets(ids = ASSET_IDS) {
  const url =
    `${BASE}/coins/markets?vs_currency=usd&ids=${ids.join(",")}` +
    `&price_change_percentage=24h,7d&sparkline=false`;
  const data = await cgGet(url);
  const now = new Date().toISOString();
  return data.map((c) => ({
    asset_id: c.id,
    price: c.current_price,
    volume: c.total_volume,
    chg_24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? 0,
    chg_7d: c.price_change_percentage_7d_in_currency ?? 0,
    fetched_at: now,
  }));
}
