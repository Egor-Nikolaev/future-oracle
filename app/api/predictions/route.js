import { ensureSeeded } from "../../../lib/ingest.js";
import { ASSETS } from "../../../lib/assets.js";
import { latestPrediction, latestSnapshot, assetNews, accuracy } from "../../../lib/db.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // параллельный сбор 8 коинов (RSS + батч-LLM)

// Список объектов прогноза с карточками. На пустой базе триггерит досеивание.
export async function GET() {
  await ensureSeeded();

  const items = [];
  for (const a of ASSETS) {
    const pred = latestPrediction(a.id);
    if (!pred) continue;
    const snap = latestSnapshot(a.id);
    items.push({
      asset: { id: a.id, symbol: a.symbol, name: a.name },
      price: snap?.price ?? pred.base_price,
      chg_24h: snap?.chg_24h ?? null,
      chg_7d: snap?.chg_7d ?? null,
      volume: snap?.volume ?? null,
      prediction: {
        direction: pred.direction,
        score: pred.score,
        confidence: pred.confidence,
        momentum: pred.momentum,
        sentiment: pred.sentiment,
        news_count: pred.news_count,
        risks: JSON.parse(pred.risks_json),
        drivers: JSON.parse(pred.drivers_json),
        created_at: pred.created_at,
      },
      news: assetNews(a.id, 8),
    });
  }

  // сортируем по уверенности — сильные сигналы наверх
  items.sort((x, y) => y.prediction.confidence - x.prediction.confidence);

  return Response.json({
    generated_at: new Date().toISOString(),
    accuracy: accuracy(), // { resolved, hits, rate } — сверка прогнозов постфактум
    count: items.length,
    items,
  });
}
