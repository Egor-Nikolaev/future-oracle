// Вселенная прогноза: топ крипты. coingecko id → symbol/name.
// aliases — полные имена (матчатся без учёта регистра как цельные слова).
// Тикер (symbol) матчится ОТДЕЛЬНО и с учётом регистра — только заглавный
// standalone-токен (BTC, $BTC), чтобы не ловить "Sol" в "Sol Ultrafast" или
// "Ada" как имя. Это убирает ложные привязки коротких тикеров к новостям.
export const ASSETS = [
  { id: "bitcoin",     symbol: "BTC",  name: "Bitcoin",   aliases: ["bitcoin"] },
  { id: "ethereum",    symbol: "ETH",  name: "Ethereum",  aliases: ["ethereum", "ether"] },
  { id: "solana",      symbol: "SOL",  name: "Solana",    aliases: ["solana"] },
  { id: "binancecoin", symbol: "BNB",  name: "BNB",       aliases: ["binance coin"] },
  { id: "ripple",      symbol: "XRP",  name: "XRP",       aliases: ["ripple"] },
  { id: "dogecoin",    symbol: "DOGE", name: "Dogecoin",  aliases: ["dogecoin"] },
  { id: "cardano",     symbol: "ADA",  name: "Cardano",   aliases: ["cardano"] },
  { id: "avalanche-2", symbol: "AVAX", name: "Avalanche", aliases: ["avalanche"] },
];

export const ASSET_IDS = ASSETS.map((a) => a.id);

export function assetById(id) {
  return ASSETS.find((a) => a.id === id);
}

// Привязка заголовка новости к активам. Возвращает массив asset_id.
// Два независимых пути, оба требуют границу слова:
//   - полное имя (aliases) — без учёта регистра ("Solana", "ether");
//   - тикер — С учётом регистра, только заглавный ("SOL", "$BTC"), не "Sol".
export function matchAssets(text) {
  const raw = text || "";
  const lower = raw.toLowerCase();
  const hits = new Set();
  for (const a of ASSETS) {
    const byName = a.aliases.some((k) => new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(lower));
    const byTicker = new RegExp(`(^|[^A-Za-z0-9])\\$?${a.symbol}(?![A-Za-z0-9])`).test(raw);
    if (byName || byTicker) hits.add(a.id);
  }
  return [...hits];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
