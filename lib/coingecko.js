// Источник A (цифры): CoinGecko free API. Ключ не нужен.
// Тянем цену, объём и изменения за 24ч/7д одним запросом по списку активов.
import { ASSET_IDS } from "./assets.js";

const BASE = "https://api.coingecko.com/api/v3";

// Возвращает массив { asset_id, price, volume, chg_24h, chg_7d, fetched_at }.
// На сбой сети бросает — вызывающий решает, что делать (фолбэк на снапшот).
export async function fetchMarkets(ids = ASSET_IDS) {
  const url =
    `${BASE}/coins/markets?vs_currency=usd&ids=${ids.join(",")}` +
    `&price_change_percentage=24h,7d&sparkline=false`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // CoinGecko free бывает медленным — даём запас
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();
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
