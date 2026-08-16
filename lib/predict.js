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

// Нормализованный сигнал позиционирования из funding rate (Binance Futures).
// +0.03% funding ≈ насыщение. Положительный = лонги переполнены (бычье плечо).
export function fundingSignal(funding) {
  if (funding == null) return null;
  return round(clamp(funding / 0.0003));
}

// Базовые веса сигналов. Итоговый балл — взвешенное среднее по ПРИСУТСТВУЮЩИМ
// сигналам (нормируется на сумму весов доступных). Отсутствие сигнала не обнуляет
// прогноз, а перераспределяет вес; на уверенность нехватка сигналов влияет отдельно.
const WEIGHTS = { momentum: 0.45, sentiment: 0.35, funding: 0.2 };

export function combineScore({ momentum = 0, sentiment = null, funding = null }) {
  let num = 0;
  let den = 0;
  for (const [k, v] of [["momentum", momentum], ["sentiment", sentiment], ["funding", funding]]) {
    if (v == null) continue;
    num += WEIGHTS[k] * v;
    den += WEIGHTS[k];
  }
  return den ? round(num / den) : 0;
}

export function directionOf(score) {
  if (score >= DIR_THRESHOLD) return "up";
  if (score <= -DIR_THRESHOLD) return "down";
  return "flat";
}

// Уверенность 0..100: сила итогового балла, скорректированная на согласие сигналов,
// покрытие новостями и волатильность. Никогда не 100 — честный потолок 92.
export function confidenceOf({ score, momentum, sentiment, funding, newsCount, chg24h, volumeTrend }) {
  let c = Math.abs(score) * 90;
  if (sentiment != null) {
    if (sign(momentum) === sign(sentiment) && momentum !== 0) c += 10; // цена и новости согласны
    else if (sign(momentum) === -sign(sentiment) && momentum !== 0 && sentiment !== 0) c -= 16; // спорят
  }
  // funding подтверждает направление (плечо в ту же сторону) или спорит с ним
  if (funding != null && momentum !== 0) {
    if (sign(funding) === sign(momentum)) c += 6;
    else if (sign(funding) === -sign(momentum) && funding !== 0) c -= 8;
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

export function risksOf({ momentum, sentiment, funding, newsCount, chg24h, score, volumeTrend }) {
  const risks = [];
  if (Math.abs(chg24h) > 8)
    risks.push(`Высокая волатильность (${chg24h > 0 ? "+" : ""}${round(chg24h, 1)}% за 24ч) — движение может резко развернуться.`);
  if (sentiment != null && sign(momentum) === -sign(sentiment) && momentum !== 0 && sentiment !== 0)
    risks.push("Цифры и новости спорят: моментум и сентимент направлены в разные стороны.");
  if (funding != null && sign(funding) === -sign(momentum) && funding !== 0 && momentum !== 0)
    risks.push("Плечо (funding) идёт против ценового движения — риск разворота/сквиза.");
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

export function driversOf({ chg24h, chg7d, sentiment, newsCount, momentum, volume, volumeTrend, volumePct, funding, fundingRaw, openInterest }) {
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
  if (funding != null) {
    const pct = fundingRaw != null ? (fundingRaw * 100).toFixed(4) + "%" : "";
    const bias = funding > 0 ? "лонги платят (бычье плечо)" : funding < 0 ? "шорты платят (медвежье плечо)" : "нейтрально";
    d.push(`Funding: ${pct} — ${bias}${openInterest != null ? `, OI ${fmtUsd(openInterest)}` : ""}`);
  }
  return d;
}

// Собрать полный прогноз из снимка, предыдущего снимка (тренд объёма) и сентимента.
// Сентимент можно передать двумя способами:
//   sentiments — массив чисел [-1..1] (равный вес, простой путь для тестов);
//   sentiment + newsCount — уже посчитанное (напр. взвешенное по свежести) среднее.
// funding берётся из snapshot.funding (сигнал позиционирования Binance).
export function buildPrediction({ snapshot, prevSnapshot = null, sentiments = null, sentiment = undefined, newsCount = undefined }) {
  const chg24h = snapshot.chg_24h ?? 0;
  const chg7d = snapshot.chg_7d ?? 0;
  const momentum = momentumSignal(chg24h, chg7d);

  if (sentiment === undefined) {
    const arr = sentiments || [];
    newsCount = arr.length;
    sentiment = newsCount ? round(arr.reduce((a, b) => a + b, 0) / newsCount) : null;
  }
  newsCount = newsCount || 0;

  const fundingRaw = snapshot.funding ?? null;
  const openInterest = snapshot.open_interest ?? null;
  const funding = fundingSignal(fundingRaw);

  const score = combineScore({ momentum, sentiment, funding });
  const direction = directionOf(score);
  const volume = snapshot.volume ?? null;
  const { trend: volumeTrend, pct: volumePct } = volumeTrendOf(volume, prevSnapshot?.volume ?? null);
  const confidence = confidenceOf({ score, momentum, sentiment, funding, newsCount, chg24h, volumeTrend });
  const risks = risksOf({ momentum, sentiment, funding, newsCount, chg24h, score, volumeTrend });
  const drivers = driversOf({ chg24h, chg7d, sentiment, newsCount, momentum, volume, volumeTrend, volumePct, funding, fundingRaw, openInterest });
  return { momentum, sentiment, newsCount, score, direction, confidence, risks, drivers, volume, volumeTrend, volumePct, funding, fundingRaw, openInterest };
}

// Фактическое направление за период (для сверки прогноза постфактум).
export function actualDirection(basePrice, nowPrice, thresholdPct = 1) {
  const pct = ((nowPrice - basePrice) / basePrice) * 100;
  if (pct >= thresholdPct) return "up";
  if (pct <= -thresholdPct) return "down";
  return "flat";
}
