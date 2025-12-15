import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { McpJson } from './client.js';
import { connectAllServers } from './client.js';
import { createChatbot } from './chatbot.js';
import { routeLine } from './router.js';

function printHelp() {
  console.log(
    [
      '',
      'Chat mode:',
      '  Type any message to chat with the local model (Ollama).',
      '',
      'Slash commands:',
      '  /help                       Show help',
      '  /tools                      List discovered tools',
      '  /use <server>.<tool> <json> Call a tool directly',
      '  /run <cmd> [args...]        terminal-server.run',
      '  /confirm <token>            terminal-server.confirm (for dangerous ops)',
      '  /read <path>                terminal-server.read_file',
      '  /write <path> <content...>  terminal-server.write_file',
      '  /exit                       Quit',
      ''
    ].join('\n')
  );
}

async function checkOllama(host: string) {
  try {
    const url = host.replace(/\/+$/, '') + '/api/tags';
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[ollama] Warning: ${resp.status} ${resp.statusText} from /api/tags: ${text.slice(0, 200)}`);
      return;
    }
  } catch (e) {
    console.error(
      `[ollama] Warning: cannot reach Ollama at ${host}. Start it with: ollama serve (and pull model). Error: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

async function findMcpJsonPath(): Promise<string> {
  const explicit = process.env.MCP_JSON_PATH;
  if (explicit) return path.resolve(explicit);

  // When run via `npm -w client`, cwd is usually `.../client`.
  // Walk up a few levels to find the nearest mcp.json.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'mcp.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Unable to find mcp.json (set MCP_JSON_PATH to an absolute path)');
}

async function readMcpJson(mcpPath: string): Promise<McpJson> {
  const raw = await fs.readFile(mcpPath, 'utf-8');
  return JSON.parse(raw) as McpJson;
}

async function main() {
  const mcpPath = await findMcpJsonPath();
  const mcp = await readMcpJson(mcpPath);
  const mcpDir = path.dirname(mcpPath);

  const servers = await connectAllServers(mcp, mcpDir);

  console.log('Connected servers:');
  for (const s of servers) {
    console.log(`- ${s.name}: ${s.tools.length} tools`);
  }

  const ollamaHost = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama3';
  console.log(`Ollama: ${ollamaHost} (model: ${ollamaModel})`);
  await checkOllama(ollamaHost);

  const bot = createChatbot(servers, {
    ollamaHost,
    ollamaModel,
    maxToolStepsPerUserTurn: Number(process.env.MAX_TOOL_STEPS ?? '10') || 10
  });

  printHelp();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('Laya> ');
  rl.prompt();

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit' || trimmed === '/quit') {
      rl.close();
      return;
    }
    if (trimmed === 'help' || trimmed === '/help') {
      printHelp();
      return;
    }
    if (trimmed === 'tools' || trimmed === '/tools') {
      for (const s of servers) {
        console.log(`\n${s.name}`);
        for (const t of s.tools) console.log(`  - ${t.name}${t.description ? `: ${t.description}` : ''}`);
      }
      console.log('');
      return;
    }

    // Slash commands (tool calls) vs chat.
    if (trimmed.startsWith('/')) {
      try {
        const routed = routeLine(trimmed.slice(1), servers);
        if (!routed) return;

        const server = servers.find(s => s.name === routed.serverName);
        if (!server) throw new Error(`Unknown server: ${routed.serverName}`);

        const resp = await server.client.callTool({
          name: routed.toolName,
          arguments: routed.args
        });

        // Print content blocks if present (common for tool output)
        if ('content' in resp && Array.isArray((resp as any).content)) {
          for (const c of (resp as any).content) {
            if (c?.type === 'text') console.log(c.text);
            else console.log(JSON.stringify(c, null, 2));
          }
        } else {
          console.log(JSON.stringify(resp, null, 2));
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Chat mode
    try {
      process.stdout.write('(thinking...)\n');
      const answer = await bot.handleUserMessage(trimmed);
      console.log(answer);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
    }
    rl.prompt();
  });

  await new Promise<void>(resolve => rl.on('close', resolve));
  process.exit(0);
}

main().catch(err => {
  console.error('Client error:', err);
  process.exit(1);
});


