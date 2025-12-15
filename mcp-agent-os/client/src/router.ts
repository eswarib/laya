import type { ConnectedServer } from './client.js';

export type RoutedToolCall = {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
};

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * Minimal router:
 * - `tools` / `help`
 * - `use <server>.<tool> <jsonArgs>`
 * - `run <command> [args...]` => terminal-server.run
 * - `confirm <token>` => terminal-server.confirm
 * - `read <path>` => terminal-server.read_file
 * - `write <path> <content>` => terminal-server.write_file (overwrite)
 */
export function routeLine(line: string, servers: ConnectedServer[]): RoutedToolCall | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const [head, ...rest] = trimmed.split(/\s+/);

  if (head === 'use') {
    const target = rest[0];
    if (!target) throw new Error('usage: use <server>.<tool> <jsonArgs>');
    const idx = target.indexOf('.');
    if (idx <= 0) throw new Error('usage: use <server>.<tool> <jsonArgs>');
    const serverName = target.slice(0, idx);
    const toolName = target.slice(idx + 1);
    const json = rest.slice(1).join(' ').trim();
    const args = json ? tryParseJsonObject(json) : {};
    if (json && !args) throw new Error('Invalid JSON args');
    return { serverName, toolName, args: args ?? {} };
  }

  const terminal = servers.find(s => s.name === 'terminal-server');
  if (!terminal) throw new Error('terminal-server not configured in mcp.json');

  if (head === 'confirm') {
    const token = rest[0];
    if (!token) throw new Error('usage: confirm <token>');
    return { serverName: 'terminal-server', toolName: 'confirm', args: { token } };
  }

  if (head === 'run') {
    const command = rest[0];
    if (!command) throw new Error('usage: run <command> [args...]');
    const args = rest.slice(1);
    return { serverName: 'terminal-server', toolName: 'run', args: { command, args } };
  }

  if (head === 'read') {
    const path = rest[0];
    if (!path) throw new Error('usage: read <relative-path>');
    return { serverName: 'terminal-server', toolName: 'read_file', args: { path } };
  }

  if (head === 'write') {
    const path = rest[0];
    if (!path) throw new Error('usage: write <relative-path> <content...>');
    const content = rest.slice(1).join(' ');
    return {
      serverName: 'terminal-server',
      toolName: 'write_file',
      args: { path, content, mode: 'overwrite' }
    };
  }

  // fallback: if user typed JSON for use-case, try terminal run with full line
  return { serverName: 'terminal-server', toolName: 'run', args: { command: head, args: rest } };
}




