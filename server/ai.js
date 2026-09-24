/**
 * A client for an OpenAI-compatible chat endpoint, configured for DeepSeek by
 * default and pointable at anything that speaks the same shape.
 *
 *   LB_AI_KEY       the API key. Absent means the feature is simply off.
 *   LB_AI_BASE_URL  default https://api.deepseek.com
 *   LB_AI_MODEL     default deepseek-chat
 *
 * Two things this module insists on, because the data here belongs to
 * children and the service is somebody else's:
 *
 *   - Names never leave. Callers pass pseudonyms and map back locally; there
 *     is no argument for a marking analysis to know that 學生甲 is called
 *     陳大文, and once a name is sent it cannot be unsent.
 *   - Every call is bounded. A request that hangs must not hang a lesson, and
 *     a loop that retries must not quietly spend money.
 */

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 1200;

export class AiError extends Error {
  constructor(message, code = 'AI_FAILED', status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const aiConfig = () => ({
  enabled: Boolean(process.env.LB_AI_KEY),
  baseUrl: (process.env.LB_AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ''),
  model: process.env.LB_AI_MODEL ?? DEFAULT_MODEL,
});

/**
 * Guard against a name reaching the request by accident. This is a backstop,
 * not the mechanism: callers are expected to have pseudonymised already, and
 * this refuses to send anything that still looks like it has not.
 */
export function assertNoNames(payload, names) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const name of names) {
    if (name && name.length >= 2 && text.includes(name)) {
      throw new AiError(`送出的內容仍含有真實姓名「${name}」`, 'NAME_LEAK', 500);
    }
  }
}

export async function chat(messages, { temperature = 0.4, maxTokens = MAX_OUTPUT_TOKENS } = {}) {
  const { enabled, baseUrl, model } = aiConfig();
  if (!enabled) {
    throw new AiError('尚未設定 AI 金鑰（LB_AI_KEY），這個功能目前關閉', 'AI_DISABLED', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.LB_AI_KEY}`,
      },
      body: JSON.stringify({
        model, messages, temperature, max_tokens: maxTokens, stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AiError(
      err.name === 'AbortError' ? 'AI 服務逾時' : `無法連上 AI 服務：${err.message}`,
      'AI_UNREACHABLE',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    // The upstream message can carry key fragments and account details, so
    // only the status is passed on.
    console.error('[ai]', res.status, text.slice(0, 500));
    throw new AiError(`AI 服務回應 ${res.status}`, 'AI_HTTP_ERROR');
  }

  let body;
  try { body = JSON.parse(text); } catch {
    throw new AiError('AI 服務回應不是合法 JSON', 'AI_BAD_RESPONSE');
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new AiError('AI 服務沒有回應內容', 'AI_EMPTY');

  return {
    content: content.trim(),
    model: body.model ?? model,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    },
  };
}
