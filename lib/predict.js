// Ядро прогноза. Всё считается из сохранённых чисел (снимок цен) и нормализованного
// сентимента новостей — детерминированно и объяснимо. Никакой случайности.
//
// Модель намеренно простая и прозрачная (это требование ТЗ: «цифры должны сходиться»):
//   momentum  — сигнал из цифр: динамика цены 24ч/7д
//   sentiment — сигнал из новостей: средний тон заголовков по активу [-1..+1]
//   score     — взвешенная сумма → направление
//   confidence — сила сигналов + согласие источников (не «да/нет»)
//   risks     — почему прогноз может не сработать
//   drivers   — какие именно числа повлияли

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const round = (x, d = 3) => Number(x.toFixed(d));

// Порог, за которым считаем движение направленным (иначе — боковик).
export const DIR_THRESHOLD = 0.12;

// Сигнал моментума из динамики цены. 6% за 24ч ИЛИ 18% за 7д = насыщение сигнала.
// 24ч важнее для краткосрочного прогноза, потому вес больше.
export function momentumSignal(chg24h = 0, chg7d = 0) {
  return round(0.6 * clamp(chg24h / 6) + 0.4 * clamp(chg7d / 18));
}

// Итоговый балл. Без новостей вес момента дисконтируется (меньше уверенности).
export function combineScore(momentum, sentiment) {
  if (sentiment == null) return round(0.8 * momentum);
  return round(0.55 * momentum + 0.45 * sentiment);
}

export function directionOf(score) {
  if (score >= DIR_THRESHOLD) return "up";
  if (score <= -DIR_THRESHOLD) return "down";
  return "flat";
}

// Уверенность 0..100: сила итогового балла, скорректированная на согласие сигналов,
// покрытие новостями и волатильность. Никогда не 100 — честный потолок 92.
export function confidenceOf({ score, momentum, sentiment, newsCount, chg24h, volumeTrend }) {
  let c = Math.abs(score) * 90;
  if (sentiment != null) {
    if (sign(momentum) === sign(sentiment) && momentum !== 0) c += 12; // источники согласны
    else if (sign(momentum) === -sign(sentiment) && momentum !== 0 && sentiment !== 0) c -= 18; // спорят
  }
  if (newsCount >= 3) c += 5;
  else if (newsCount === 0) c -= 10;
  if (Math.abs(chg24h) > 8) c -= 10; // высокая волатильность = ниже доверие
  // объём подтверждает направленное движение: рост цены на растущем объёме
  // надёжнее, чем на падающем (классическое volume-confirmation).
  if (Math.abs(score) >= DIR_THRESHOLD && volumeTrend) {
    if (volumeTrend === "up") c += 6;
    else if (volumeTrend === "down") c -= 6;
  }
  return Math.round(Math.max(5, Math.min(92, c)));
}

// Тренд объёма из двух снимков (история обновлений). Порог 10% — объём шумный.
export function volumeTrendOf(volume, prevVolume) {
  if (volume == null || prevVolume == null || prevVolume <= 0) return { trend: null, pct: null };
  const pct = ((volume - prevVolume) / prevVolume) * 100;
  const trend = pct > 10 ? "up" : pct < -10 ? "down" : "flat";
  return { trend, pct: round(pct, 1) };
}

// Компактный формат объёма в USD ($12.3B / $767M).
export function fmtUsd(x) {
  if (x == null) return "—";
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(0)}M`;
  return `$${Math.round(x)}`;
}

export function risksOf({ momentum, sentiment, newsCount, chg24h, score, volumeTrend }) {
  const risks = [];
  if (Math.abs(chg24h) > 8)
    risks.push(`Высокая волатильность (${chg24h > 0 ? "+" : ""}${round(chg24h, 1)}% за 24ч) — движение может резко развернуться.`);
  if (sentiment != null && sign(momentum) === -sign(sentiment) && momentum !== 0 && sentiment !== 0)
    risks.push("Цифры и новости спорят: моментум и сентимент направлены в разные стороны.");
  if (Math.abs(score) >= DIR_THRESHOLD && volumeTrend === "down")
    risks.push("Движение на падающем объёме — слабое подтверждение тренда.");
  if (newsCount === 0)
    risks.push("Нет свежих новостей по активу — прогноз опирается только на цену и объём.");
  else if (newsCount < 2)
    risks.push("Тонкое новостное покрытие (мало заголовков) — сентимент неустойчив.");
  if (Math.abs(score) < DIR_THRESHOLD)
    risks.push("Слабый сигнал: рынок близок к боковику, направленность неуверенная.");
  if (!risks.length) risks.push("Явных факторов риска не выявлено, но крипторынок непредсказуем в принципе.");
  return risks;
}

export function driversOf({ chg24h, chg7d, sentiment, newsCount, momentum, volume, volumeTrend, volumePct }) {
  const d = [];
  d.push(`Цена за 24ч: ${chg24h > 0 ? "+" : ""}${round(chg24h, 2)}%`);
  d.push(`Цена за 7д: ${chg7d > 0 ? "+" : ""}${round(chg7d, 2)}%`);
  d.push(`Моментум (сигнал из цифр): ${momentum > 0 ? "+" : ""}${momentum}`);
  if (volume != null) {
    const trendTxt =
      volumeTrend === "up" ? `растёт${volumePct != null ? `, +${volumePct}%` : ""}` :
      volumeTrend === "down" ? `падает${volumePct != null ? `, ${volumePct}%` : ""}` :
      volumeTrend === "flat" ? "стабилен" : "нет истории";
    d.push(`Объём за 24ч: ${fmtUsd(volume)} (${trendTxt})`);
  }
  if (sentiment != null)
    d.push(`Сентимент ${newsCount} новостей: ${sentiment > 0 ? "+" : ""}${round(sentiment, 2)}`);
  else d.push("Сентимент: нет данных (новостей по активу не найдено)");
  return d;
}

// Собрать полный прогноз из снимка, предыдущего снимка (для тренда объёма) и
// списка сентиментов новостей по активу. sentiments — массив чисел [-1..1].
export function buildPrediction({ snapshot, prevSnapshot = null, sentiments = [] }) {
  const chg24h = snapshot.chg_24h ?? 0;
  const chg7d = snapshot.chg_7d ?? 0;
  const momentum = momentumSignal(chg24h, chg7d);
  const newsCount = sentiments.length;
  const sentiment = newsCount ? round(sentiments.reduce((a, b) => a + b, 0) / newsCount) : null;
  const score = combineScore(momentum, sentiment);
  const direction = directionOf(score);
  const volume = snapshot.volume ?? null;
  const { trend: volumeTrend, pct: volumePct } = volumeTrendOf(volume, prevSnapshot?.volume ?? null);
  const confidence = confidenceOf({ score, momentum, sentiment, newsCount, chg24h, volumeTrend });
  const risks = risksOf({ momentum, sentiment, newsCount, chg24h, score, volumeTrend });
  const drivers = driversOf({ chg24h, chg7d, sentiment, newsCount, momentum, volume, volumeTrend, volumePct });
  return { momentum, sentiment, newsCount, score, direction, confidence, risks, drivers, volume, volumeTrend, volumePct };
}

// Фактическое направление за период (для сверки прогноза постфактум).
export function actualDirection(basePrice, nowPrice, thresholdPct = 1) {
  const pct = ((nowPrice - basePrice) / basePrice) * 100;
  if (pct >= thresholdPct) return "up";
  if (pct <= -thresholdPct) return "down";
  return "flat";
}
