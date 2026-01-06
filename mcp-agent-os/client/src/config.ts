import fs from 'node:fs/promises';
import path from 'node:path';

export type LayaConfig = {
  /**
   * Root directory for the mcp-agent-os workspace.
   * If relative, it is resolved relative to the directory containing config.json.
   */
  layaRoot?: string;

  /**
   * Absolute path to mcp.json (or relative to config.json directory).
   * If set, the client will use this instead of searching for mcp.json.
   */
  mcpJsonPath?: string;

  ollamaHost?: string;
  ollamaModel?: string;
  ollamaTimeoutMs?: number;

  maxToolSteps?: number;

  // Launcher-only knobs (still safe to keep here; ignored by client if unused)
  ollamaStartupTimeoutMs?: number;
  killOllamaOnExit?: boolean;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function asOptionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
  }
  return undefined;
}

function normalizeConfig(raw: unknown, configPathAbs: string): LayaConfig {
  const dir = path.dirname(configPathAbs);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;

  const resolveMaybeRelative = (p: unknown): string | undefined => {
    if (typeof p !== 'string' || !p.trim()) return undefined;
    return path.isAbsolute(p) ? p : path.resolve(dir, p);
  };

  return {
    layaRoot: resolveMaybeRelative(r.layaRoot),
    mcpJsonPath: resolveMaybeRelative(r.mcpJsonPath),
    ollamaHost: typeof r.ollamaHost === 'string' ? r.ollamaHost : undefined,
    ollamaModel: typeof r.ollamaModel === 'string' ? r.ollamaModel : undefined,
    ollamaTimeoutMs: asOptionalNumber(r.ollamaTimeoutMs),
    maxToolSteps: asOptionalNumber(r.maxToolSteps),
    ollamaStartupTimeoutMs: asOptionalNumber(r.ollamaStartupTimeoutMs),
    killOllamaOnExit: asOptionalBoolean(r.killOllamaOnExit)
  };
}

/**
 * Finds config.json.
 *
 * Precedence:
 * - LAYA_CONFIG_PATH (must exist if set)
 * - nearest config.json walking up from process.cwd()
 */
export async function findConfigPath(): Promise<string | null> {
  const explicit = process.env.LAYA_CONFIG_PATH;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!(await fileExists(abs))) throw new Error(`LAYA_CONFIG_PATH does not exist: ${abs}`);
    return abs;
  }

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'config.json');
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function readLayaConfig(): Promise<{ config: LayaConfig; path: string | null }> {
  const p = await findConfigPath();
  if (!p) return { config: {}, path: null };
  const raw = await fs.readFile(p, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return { config: normalizeConfig(parsed, p), path: p };
}


