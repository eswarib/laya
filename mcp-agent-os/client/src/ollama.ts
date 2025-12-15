export type OllamaRole = 'system' | 'user' | 'assistant';

export type OllamaMessage = {
  role: OllamaRole;
  content: string;
};

export type OllamaChatOptions = {
  host: string; // e.g. http://127.0.0.1:11434
  model: string; // e.g. llama3
  messages: OllamaMessage[];
  temperature?: number;
  numPredict?: number;
};

function joinUrl(host: string, path: string): string {
  const h = host.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${h}${p}`;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? '120000') || 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  clearTimeout(timer);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Ollama HTTP ${resp.status} ${resp.statusText}: ${text}`);
  }
  return parseOllamaJsonOrNdjson(text);
}

function messagesToPrompt(messages: OllamaMessage[]): string {
  // Fallback prompt format for /api/generate if /api/chat is unavailable.
  // Keep it simple + explicit. The system message (if any) leads.
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') out.push(`System: ${m.content}`);
  }
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') out.push(`User: ${m.content}`);
    else out.push(`Assistant: ${m.content}`);
  }
  out.push('Assistant:');
  return out.join('\n\n');
}

function parseOllamaJsonOrNdjson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Ollama returned empty body');

  // Prefer plain JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to NDJSON (streaming responses sometimes still happen).
  }

  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error(`Ollama returned non-JSON: ${text.slice(0, 500)}`);

  const items: any[] = [];
  for (const l of lines) {
    try {
      items.push(JSON.parse(l));
    } catch {
      throw new Error(`Ollama returned non-JSON/NDJSON: ${text.slice(0, 500)}`);
    }
  }

  // Return a synthetic merged response similar to stream:false.
  // /api/generate: { response, done }
  if (items.some(i => typeof i?.response === 'string')) {
    const response = items.map(i => (typeof i?.response === 'string' ? i.response : '')).join('');
    const last = items[items.length - 1];
    return { ...last, response };
  }

  // /api/chat: { message: { content }, done }
  if (items.some(i => typeof i?.message?.content === 'string')) {
    const content = items.map(i => (typeof i?.message?.content === 'string' ? i.message.content : '')).join('');
    const last = items[items.length - 1];
    return { ...last, message: { ...(last?.message ?? {}), content } };
  }

  // Unknown streaming shape; return the last item.
  return items[items.length - 1];
}

/**
 * Calls Ollama using /api/chat if available; falls back to /api/generate.
 * Returns assistant content (string).
 */
export async function ollamaChat(opts: OllamaChatOptions): Promise<string> {
  const host = opts.host || 'http://127.0.0.1:11434';
  const model = opts.model || 'llama3';

  // 1) Try /api/chat
  try {
    const url = joinUrl(host, '/api/chat');
    const data = await postJson(url, {
      model,
      messages: opts.messages,
      stream: false,
      options: {
        temperature: opts.temperature,
        num_predict: opts.numPredict
      }
    });
    const content = data?.message?.content;
    if (typeof content !== 'string') throw new Error('Unexpected /api/chat response shape');
    return content;
  } catch (e) {
    // 2) Fallback /api/generate (older or minimal installs)
    const url = joinUrl(host, '/api/generate');
    const data = await postJson(url, {
      model,
      prompt: messagesToPrompt(opts.messages),
      stream: false,
      options: {
        temperature: opts.temperature,
        num_predict: opts.numPredict
      }
    });
    const content = data?.response;
    if (typeof content !== 'string') {
      throw e instanceof Error ? e : new Error(String(e));
    }
    return content;
  }
}


