import type { ConnectedServer, ToolInfo } from './client.js';
import { ollamaChat, type OllamaMessage } from './ollama.js';

export type ChatbotConfig = {
  ollamaHost: string;
  ollamaModel: string;
  ollamaTimeoutMs?: number;
  maxToolStepsPerUserTurn?: number;
};

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
type ChatMsg = { role: ChatRole; content: string };

type ToolAction = {
  type: 'tool';
  server: string;
  tool: string;
  args?: Record<string, unknown>;
};

type FinalAction = {
  type: 'final';
  text: string;
};

type Action = ToolAction | FinalAction;

type PendingConfirmationInfo = {
  token: string;
  reason?: string;
  expiresAt?: string;
};

function safeJsonParse(s: string): unknown {
  // Strip common markdown fences if the model ignores instructions,
  // then extract the first JSON object even if surrounded by extra text.
  const trimmed = s.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const extracted = extractFirstJsonObjectString(unfenced) ?? unfenced;
  return JSON.parse(extracted);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function extractFirstJsonObjectString(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      return s.slice(start, i + 1);
    }
  }

  return null;
}

function parseAction(modelText: string): Action {
  const v = safeJsonParse(modelText);
  if (!isRecord(v)) throw new Error('Model did not return a JSON object');
  const type = v.type;
  if (type === 'final') {
    if (typeof v.text !== 'string') throw new Error('final.text must be a string');
    return { type: 'final', text: v.text };
  }
  if (type === 'tool') {
    if (typeof v.server !== 'string') throw new Error('tool.server must be a string');
    if (typeof v.tool !== 'string') throw new Error('tool.tool must be a string');
    const args = v.args;
    if (args !== undefined && !isRecord(args)) throw new Error('tool.args must be an object');
    return { type: 'tool', server: v.server, tool: v.tool, args: (args as any) ?? {} };
  }
  throw new Error('Action.type must be "tool" or "final"');
}

function toolCatalogLine(serverName: string, t: ToolInfo): string {
  const desc = t.description ? ` — ${t.description}` : '';
  const argsSummary = summarizeInputSchema(t.inputSchema);
  return `- ${serverName}.${t.name}${desc}${argsSummary ? ` (args: ${argsSummary})` : ''}`;
}

function renderToolCatalog(servers: ConnectedServer[]): string {
  const lines: string[] = [];
  for (const s of servers) {
    lines.push(`Server: ${s.name}`);
    for (const t of s.tools) lines.push(toolCatalogLine(s.name, t));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function summarizeInputSchema(schema: unknown): string | null {
  // Expect JSON-schema-like objects returned by MCP SDK listTools.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as any;
  const props = s?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const required = Array.isArray(s?.required) ? (s.required as string[]) : [];

  const parts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      parts.push(`${k}${required.includes(k) ? '' : '?'}`);
      continue;
    }
    const vv = v as any;
    let ty = typeof vv.type === 'string' ? vv.type : 'any';
    if (ty === 'array' && vv.items && typeof vv.items === 'object' && typeof (vv.items as any).type === 'string') {
      ty = `${(vv.items as any).type}[]`;
    }
    parts.push(`${k}${required.includes(k) ? '' : '?'}:${ty}`);
  }
  return parts.length ? parts.join(', ') : null;
}

function buildSystemPrompt(servers: ConnectedServer[]): string {
  return [
    'You are SmartOS, a local agent running on a developer machine.',
    'You can use MCP tools from connected servers to read files, search files,run safe commands, and more.',
    'You can use the search tool to search for files and directories.',
    'CRITICAL: You must respond with ONLY a single JSON object, no extra text.',
    '',
    'Choose exactly one of these action shapes:',
    '',
    '1) Call a tool:',
    '{"type":"tool","server":"terminal-server","tool":"run","args":{"command":"ls","args":["-la"],"cwd":"."}}',
    '',
    '2) Finish:',
    '{"type":"final","text":"...your answer to the user..."}',
    '',
    'Rules:',
    '- If you need info, call tools; do not guess.',
    '- Prefer minimal tool usage.',
    '- Tool args must match the tool inputSchema.',
    '- Use relative paths unless the user explicitly asks for absolute paths.',
    '- After you receive a tool result, either call ONE additional tool if necessary or respond with {"type":"final",...}.',
    '- Do NOT repeat the same tool call with the same args. If a tool fails or is not implemented, respond with a final explanation.',
    '- Never call terminal-server.confirm automatically. If a tool returns a confirmation token, ask the user to run /confirm <token>.',
    '- Never invent tool names. Only use tools listed under "Available tools".',
    '- If you cannot find a suitable tool OR the available tools are blocked by policy, respond with {"type":"final",...} and include:',
    '  - a short explanation',
    '  - the exact terminal command(s) the user can run manually in their own shell (clearly labeled as "Run manually:")',
    '- When suggesting "Run manually" commands: prefer safe/non-destructive commands; include a safer alternative if available; and add a clear warning before any destructive or irreversible commands.',
    '- For file discovery (e.g. "find my downloads", "find images", "find recent files"), prefer terminal-server.find_files. Do NOT use terminal-server.search unless you truly need to search file contents.',
    '- For terminal-server.find_files, prefer relative directories like "Downloads" (relative to sandbox root). Avoid paths like "/Downloads" which are usually outside the sandbox.',
    '- IMPORTANT: If the user asks you to LIST files (e.g. "list the 5 newest files in Downloads"), you MUST call terminal-server.find_files. Do not answer from memory.',
    '- Example (recent files; extensions is optional): {"type":"tool","server":"terminal-server","tool":"find_files","args":{"dir":".","maxResults":10}}',
    '- Example (Downloads): {"type":"tool","server":"terminal-server","tool":"find_files","args":{"dir":"Downloads","maxResults":5}}',
    '- IMPORTANT: If the user asks for current system facts like date/time, you MUST call terminal-server.run with an allowlisted command (e.g. "date"). Do not invent files like /etc/mktime.',
    '- Example (date): {"type":"tool","server":"terminal-server","tool":"run","args":{"command":"date"}}',
    '',
    'SSH KEY WIZARD (important):',
    '- If the user asks to "create an ssh key" but did not provide details, DO NOT call generate_ssh_key yet.',
    '- Instead, ask the user to choose options and state the defaults:',
    '  - type: default "ed25519" (offer "rsa")',
    '  - filename under ~/.ssh: default "id_ed25519"',
    '  - comment: optional (default "laya-mcp")',
    '  - passphrase: optional (default empty)',
    '  - overwrite: default false',
    '- Only call terminal-server.generate_ssh_key after the user answers the options (or explicitly says "use defaults").',
    '',
    'Available tools:',
    renderToolCatalog(servers)
  ].join('\n');
}

function toOllamaMessages(history: ChatMsg[], servers: ConnectedServer[]): OllamaMessage[] {
  const msgs: OllamaMessage[] = [];
  msgs.push({ role: 'system', content: buildSystemPrompt(servers) });
  for (const h of history) {
    if (h.role === 'tool') {
      // Ollama doesn't have a standardized "tool" role across versions; treat as user-provided evidence.
      msgs.push({ role: 'user', content: `Tool result:\n${h.content}` });
    } else {
      msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
    }
  }
  return msgs;
}

function extractToolText(resp: any): string {
  const parts: string[] = [];
  if (resp && Array.isArray(resp.content)) {
    for (const c of resp.content) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else parts.push(JSON.stringify(c, null, 2));
    }
  }
  if (resp && resp.structuredContent !== undefined) {
    parts.push(`structuredContent: ${JSON.stringify(resp.structuredContent, null, 2)}`);
  }
  if (!parts.length) return JSON.stringify(resp, null, 2);
  return parts.join('\n');
}

export function createChatbot(servers: ConnectedServer[], cfg: ChatbotConfig) {
  const history: ChatMsg[] = [];
  let awaitingSshWizardInput = false;

  function sshWizardPrompt(): string {
    return [
      'I can generate an SSH key, but first choose options (or say "use defaults"):',
      '- type: default ed25519 (or rsa)',
      '- filename under ~/.ssh: default id_ed25519',
      '- comment (optional): default laya-mcp',
      '- passphrase (optional): default empty',
      '- overwrite existing key files? default no',
      '',
      'Reply with something like:',
      '"use defaults"',
      'or',
      '"type ed25519, filename id_ed25519_work, comment work, no passphrase, no overwrite"'
    ].join('\n');
  }

  function isSshKeyIntent(text: string): boolean {
    const t = text.toLowerCase();
    return (t.includes('ssh') && t.includes('key')) || t.includes('ssh-key') || t.includes('sshkey');
  }

  function parseSshWizardInput(text: string): {
    type?: 'ed25519' | 'rsa';
    filename?: string;
    comment?: string;
    passphrase?: string;
    overwrite?: boolean;
  } {
    const t = text.trim();
    const lower = t.toLowerCase();
    if (lower === 'use defaults' || lower === 'defaults' || lower === 'default') return {};

    // If the user just replied with a single token, treat it as filename.
    if (/^[a-zA-Z0-9._-]+$/.test(t) && !lower.includes('type') && !lower.includes('pass') && !lower.includes('comment')) {
      return { filename: t };
    }

    const out: {
      type?: 'ed25519' | 'rsa';
      filename?: string;
      comment?: string;
      passphrase?: string;
      overwrite?: boolean;
    } = {};

    if (lower.includes('rsa')) out.type = 'rsa';
    if (lower.includes('ed25519') || lower.includes('ed')) out.type = 'ed25519';

    const fnMatch = t.match(/filename\s*[:=]?\s*([a-zA-Z0-9._-]+)/i) ?? t.match(/\bfile(name)?\s*[:=]?\s*([a-zA-Z0-9._-]+)/i);
    if (fnMatch) out.filename = fnMatch[2] ?? fnMatch[1];

    const commentMatch = t.match(/comment\s*[:=]?\s*["']([^"']+)["']/i) ?? t.match(/comment\s*[:=]?\s*([^,]+)$/i);
    if (commentMatch) out.comment = (commentMatch[1] ?? '').trim();

    // passphrase can be quoted or "no passphrase"
    if (/\bno\s+passphrase\b/i.test(t) || /\bempty\s+passphrase\b/i.test(t)) out.passphrase = '';
    const passMatch = t.match(/passphrase\s*[:=]?\s*["']([^"']*)["']/i);
    if (passMatch) out.passphrase = passMatch[1] ?? '';

    if (/\boverwrite\b/i.test(t)) out.overwrite = true;
    if (/\bno\s+overwrite\b/i.test(t) || /\bdon't overwrite\b/i.test(t)) out.overwrite = false;

    return out;
  }

  function extractConfirmation(resp: any): PendingConfirmationInfo | null {
    const sc = resp?.structuredContent;
    if (!sc || typeof sc !== 'object') return null;
    if ((sc as any).requiresConfirmation !== true) return null;
    const token = (sc as any).token;
    if (typeof token !== 'string' || !token) return null;
    return {
      token,
      reason: typeof (sc as any).reason === 'string' ? (sc as any).reason : undefined,
      expiresAt: typeof (sc as any).expiresAt === 'string' ? (sc as any).expiresAt : undefined
    };
  }

  async function runTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<{ text: string; confirmation?: PendingConfirmationInfo }> {
    const server = servers.find(s => s.name === serverName);
    if (!server) throw new Error(`Unknown server: ${serverName}`);
    const resp = await server.client.callTool({ name: toolName, arguments: args });
    const text = extractToolText(resp);
    const confirmation = extractConfirmation(resp) ?? undefined;
    return { text, confirmation };
  }

  async function callModel(extraSystemNudge?: string): Promise<{ raw: string; action: Action }> {
    const msgs: OllamaMessage[] = toOllamaMessages(history, servers);
    if (extraSystemNudge) {
      msgs.unshift({ role: 'system', content: extraSystemNudge });
    }
    const raw = await ollamaChat({
      host: cfg.ollamaHost,
      model: cfg.ollamaModel,
      messages: msgs,
      timeoutMs: cfg.ollamaTimeoutMs,
      temperature: 0.2,
      numPredict: 300
    });
    const action = parseAction(raw);
    return { raw, action };
  }

  return {
    getHistory() {
      return [...history];
    },

    async handleUserMessage(userText: string): Promise<string> {
      history.push({ role: 'user', content: userText });

      // Deterministic SSH key wizard: don't rely on the model to ask the right questions.
      if (awaitingSshWizardInput) {
        const args = parseSshWizardInput(userText);
        awaitingSshWizardInput = false;
        try {
          const { text, confirmation } = await runTool('terminal-server', 'generate_ssh_key', args as any);
          history.push({ role: 'tool', content: `terminal-server.generate_ssh_key(${JSON.stringify(args)}):\n${text}` });
          if (confirmation) {
            return (
              `SSH key generation is pending confirmation.\n` +
              `Run these (twice) to proceed:\n` +
              `/confirm ${confirmation.token}\n` +
              `Then run /confirm <token2> from the response.\n`
            );
          }
          return text;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      }

      if (isSshKeyIntent(userText)) {
        // Always ask for options first unless the user explicitly wants defaults.
        const lower = userText.toLowerCase();
        const hasExplicitDefaults = lower.includes('use defaults') || lower === 'defaults' || lower === 'default';
        if (!hasExplicitDefaults) {
          awaitingSshWizardInput = true;
          return sshWizardPrompt();
        }
        // User explicitly asked defaults: still call the tool and require confirmation.
        try {
          const { text, confirmation } = await runTool('terminal-server', 'generate_ssh_key', {});
          history.push({ role: 'tool', content: `terminal-server.generate_ssh_key({}):\n${text}` });
          if (confirmation) {
            return (
              `SSH key generation is pending confirmation.\n` +
              `Run these (twice) to proceed:\n` +
              `/confirm ${confirmation.token}\n` +
              `Then run /confirm <token2> from the response.\n`
            );
          }
          return text;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      }

      const maxSteps = cfg.maxToolStepsPerUserTurn ?? 6;
      const seenToolCalls = new Set<string>();
      for (let step = 0; step < maxSteps; step++) {
        let modelResp: { raw: string; action: Action } | null = null;
        try {
          modelResp = await callModel();
        } catch (e) {
          // If the model output isn't parseable JSON, try one repair turn with a stricter nudge.
          try {
            modelResp = await callModel(
              'Your previous output was invalid. Return ONLY a single valid JSON object matching the specified action shapes.'
            );
          } catch (e2) {
            const msg = e2 instanceof Error ? e2.message : String(e2);
            return (
              `I couldn't parse the model response as an action JSON.\n` +
              `Error: ${msg}\n` +
              `Tip: try a smaller model, or ask a simpler question first (e.g. "Say hi").`
            );
          }
        }

        // Keep the raw assistant output for traceability.
        history.push({ role: 'assistant', content: modelResp.raw.trim() });

        if (modelResp.action.type === 'final') {
          return modelResp.action.text;
        }

        const { server: serverName, tool: toolName } = modelResp.action;
        const args = modelResp.action.args ?? {};

        // Never let the model auto-confirm. Ask the user to do /confirm manually.
        if (serverName === 'terminal-server' && toolName === 'confirm') {
          return `For safety, please run confirmations manually as a slash command: /confirm <token>`;
        }

        // Policy gate: don't silently default SSH key generation. Ask the user first.
        if (serverName === 'terminal-server' && toolName === 'generate_ssh_key') {
          const hasAnyOption =
            Object.prototype.hasOwnProperty.call(args, 'type') ||
            Object.prototype.hasOwnProperty.call(args, 'filename') ||
            Object.prototype.hasOwnProperty.call(args, 'comment') ||
            Object.prototype.hasOwnProperty.call(args, 'passphrase') ||
            Object.prototype.hasOwnProperty.call(args, 'overwrite');

          if (!hasAnyOption) {
            // Stop the tool loop and ask the user for preferences.
            awaitingSshWizardInput = true;
            return sshWizardPrompt();
          }
        }

        const callKey = `${serverName}.${toolName} ${JSON.stringify(args)}`;
        if (seenToolCalls.has(callKey)) {
          history.push({
            role: 'tool',
            content:
              `ERROR: Detected repeated tool call (${callKey}). ` +
              `Do not repeat the same call. Respond with a final answer now.`
          });
          continue;
        }
        seenToolCalls.add(callKey);

        if (step >= maxSteps - 2) {
          history.push({
            role: 'tool',
            content: `NOTE: Tool-call budget is almost exhausted (${step + 1}/${maxSteps}). Please respond with a final answer.`
          });
        }

        const server = servers.find(s => s.name === serverName);
        if (!server) {
          history.push({ role: 'tool', content: `ERROR: Unknown server "${serverName}"` });
          continue;
        }

        try {
          const resp = await server.client.callTool({ name: toolName, arguments: args });
          const text = extractToolText(resp);
          history.push({ role: 'tool', content: `${serverName}.${toolName}(${JSON.stringify(args)}):\n${text}` });

          // For file listing/discovery tools, the tool output is the answer. Return it directly so
          // the user sees actual filenames/paths (and we don't rely on the model to restate it).
          if (serverName === 'terminal-server' && toolName === 'find_files') {
            return text;
          }

          // For simple system fact queries (like date/time), return the command output directly.
          // This avoids a common failure mode where the model "acknowledges" the action but forgets to print results.
          if (serverName === 'terminal-server' && toolName === 'run') {
            const cmd = typeof (args as any)?.command === 'string' ? String((args as any).command) : '';
            if (cmd === 'date') return text;
          }

          const conf = extractConfirmation(resp);
          if (conf) {
            return (
              `Action requires confirmation.\n` +
              `Run these (twice) to proceed:\n` +
              `/confirm ${conf.token}\n` +
              `Then run /confirm <token2> from the response.\n`
            );
          }
        } catch (e) {
          history.push({
            role: 'tool',
            content: `ERROR calling ${serverName}.${toolName}(${JSON.stringify(args)}): ${
              e instanceof Error ? e.message : String(e)
            }`
          });
        }
      }

      return `I hit the tool-call step limit (${cfg.maxToolStepsPerUserTurn ?? 6}) before finishing. Try rephrasing or ask me to stop earlier.`;
    }
  };
}


