// Тонкий клиент к любому OpenAI-совместимому провайдеру (Groq по умолчанию,
// OpenRouter как запасной). Один и тот же клиент используется для сентимента
// новостей и для генерации текстовых аргументов прогноза.
//
// Провайдер задаётся переменными окружения (приоритет LLM_* > OPENROUTER_*):
//   LLM_BASE_URL   базовый URL, напр. https://api.groq.com/openai/v1
//   LLM_API_KEY    ключ
//   LLM_MODEL      модель, напр. llama-3.3-70b-versatile

const LLM_BASE = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const LLM_URL = `${LLM_BASE}/chat/completions`;

export function apiKey() {
  return process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
}

export function llmAvailable() {
  return Boolean(apiKey());
}

export function defaultModel() {
  return process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || "llama-3.3-70b-versatile";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Один запрос к чату с ретраями на 429/503. Возвращает текст ответа (обрезанный,
// без markdown-обёртки). Бросает, если после всех попыток не удалось.
export async function llmChat(messages, opts = {}) {
  const model = opts.model || defaultModel();
  const temperature = opts.temperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? 400;
  const maxAttempts =
    Number(process.env.LLM_MAX_ATTEMPTS) || Number(process.env.OPENROUTER_MAX_ATTEMPTS) || 3;

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    let res;
    try {
      res = await fetch(LLM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
          "X-Title": "Future Oracle",
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      });
    } catch (e) {
      lastErr = e;
      continue; // сетевой сбой — ретрай
    }
    if (res.status === 429 || res.status === 503) {
      lastErr = new Error(`LLM ${res.status} (rate-limited)`);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM: пустой ответ");
    text = text.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
    return text;
  }
  throw lastErr || new Error("LLM: не удалось получить ответ");
}
