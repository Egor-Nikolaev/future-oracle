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

// Батч: один LLM-вызов на список заголовков (десятки новостей на коин без сотен
// запросов). Возвращает массив { score, method } той же длины. При сбое LLM или
// расхождении длины — весь батч падает в rule-based, приложение не ломается.
export async function scoreTitlesBatch(titles) {
  if (!titles.length) return [];
  if (llmAvailable()) {
    try {
      const list = titles.map((t, i) => `${i + 1}. ${t.replace(/\n/g, " ")}`).join("\n");
      const out = await llmChat(
        [
          {
            role: "system",
            content:
              "Ты оцениваешь тон крипто-новостей для краткосрочного движения цены. " +
              "Для КАЖДОГО заголовка верни число от -1 (сильно медвежий) до 1 (сильно бычий), 0 нейтральный. " +
              "Ответь ТОЛЬКО JSON-массивом чисел той же длины и порядка, без слов. Пример: [0.5,-0.3,0].",
          },
          { role: "user", content: list },
        ],
        { temperature: 0, maxTokens: Math.min(1200, 20 + titles.length * 8) }
      );
      const arr = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] ?? out);
      if (Array.isArray(arr) && arr.length === titles.length) {
        return arr.map((x) => ({ score: Math.max(-1, Math.min(1, Number(x) || 0)), method: "llm" }));
      }
    } catch {
      /* падаем в rule-based */
    }
  }
  return titles.map((t) => ({ score: ruleScore(t), method: "rule-based" }));
}

export { ruleScore };
