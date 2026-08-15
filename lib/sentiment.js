// Сентимент крипто-новости: насколько заголовок бычий (+1) или медвежий (-1).
// Основной путь — LLM, фолбэк — лексикон. Без ключа приложение считает прогнозы
// на rule-based сентименте, зависимость от модели не жёсткая.
import { llmChat, llmAvailable } from "./llm.js";

// Лексикон рыночного тона. Стемы, регистронезависимо. Веса грубые, но прозрачные.
const BULLISH = [
  "surge", "soar", "rally", "jump", "gain", "rise", "spike", "breakout", "all-time high",
  "ath", "adopt", "approval", "approve", "inflow", "bullish", "boom", "buy", "accumulat",
  "upgrade", "partnership", "institutional", "etf", "record", "recover", "rebound", "pump",
];
const BEARISH = [
  "crash", "plunge", "plummet", "dump", "drop", "fall", "slump", "sell-off", "selloff",
  "bearish", "hack", "exploit", "lawsuit", "sec", "ban", "outflow", "liquidat", "fear",
  "decline", "loss", "warning", "fraud", "scam", "collapse", "sink", "tumble", "fine",
];

function ruleScore(title) {
  const t = (title || "").toLowerCase();
  let s = 0;
  for (const w of BULLISH) if (t.includes(w)) s += 1;
  for (const w of BEARISH) if (t.includes(w)) s -= 1;
  if (s === 0) return 0;
  // сглаживаем в [-1..1]: 3+ совпадений в одну сторону = насыщение
  return Math.max(-1, Math.min(1, s / 3));
}

// LLM: строго число от -1 до 1. Парсим, при мусоре — падаем в rule-based.
async function llmScore(title) {
  const out = await llmChat(
    [
      {
        role: "system",
        content:
          "Ты оцениваешь тон крипто-новости для краткосрочного движения цены. " +
          "Ответь ТОЛЬКО одним числом от -1 до 1: -1 сильно медвежья, 0 нейтральная, 1 сильно бычья. " +
          "Без слов, без пояснений, только число.",
      },
      { role: "user", content: `Заголовок: "${title}"` },
    ],
    { temperature: 0, maxTokens: 8 }
  );
  const m = out.match(/-?\d+(\.\d+)?/);
  if (!m) throw new Error("LLM sentiment: не число");
  return Math.max(-1, Math.min(1, parseFloat(m[0])));
}

// Возвращает { score, method }. Никогда не бросает: LLM-сбой → rule-based.
export async function scoreTitle(title) {
  if (llmAvailable()) {
    try {
      return { score: await llmScore(title), method: "llm" };
    } catch {
      /* падаем в rule-based */
    }
  }
  return { score: ruleScore(title), method: "rule-based" };
}

export { ruleScore };
