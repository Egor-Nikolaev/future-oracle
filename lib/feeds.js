// Источник B (контекст): Google News RSS-поиск ПО КАЖДОМУ активу.
// Даёт десятки свежих осмысленных новостей на коин с точной привязкой (запрос = имя
// монеты), без ложных подстрок и перекоса в биток. Ключи/регистрация не нужны.
export function googleNewsUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

// Имя источника извлекаем из заголовка Google News ("Headline - Source").
export function sourceFromTitle(title) {
  const m = (title || "").match(/\s-\s([^-]+)$/);
  return m ? m[1].trim() : "Google News";
}
export function stripSource(title) {
  return (title || "").replace(/\s-\s[^-]+$/, "").trim();
}
