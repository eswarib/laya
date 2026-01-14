#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isOllamaUp(host) {
  try {
    const url = host.replace(/\/+$/, '') + '/api/tags';
    const resp = await fetch(url, { method: 'GET' });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(host, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isOllamaUp(host)) return true;
    await sleep(250);
  }
  return false;
}

function spawnOllamaServe() {
  // Fast-fail with a clear message if `ollama` isn't installed/available on PATH.
  const probe = spawnSync('ollama', ['--version'], { stdio: 'ignore' });
  if (probe.error && probe.error.code === 'ENOENT') {
    process.stderr.write(
      `laya: Ollama executable not found ("ollama").\n` +
        `Install Ollama, or point laya at an already-running Ollama via OLLAMA_HOST/config.json.\n`
    );
    return null;
  }

  // Detached so it can keep running in the background.
  const child = spawn('ollama', ['serve'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });
  child.unref();
  return child.pid ?? null;
}

function tryReadJson(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function resolveConfig({ scriptRoot }) {
  const explicit = process.env.LAYA_CONFIG_PATH ? path.resolve(process.env.LAYA_CONFIG_PATH) : null;
  const cwdCandidateNew = path.resolve(process.cwd(), 'config', 'config.json');
  const rootCandidateNew = path.resolve(scriptRoot, 'config', 'config.json');

  let configPath = null;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`LAYA_CONFIG_PATH does not exist: ${explicit}`);
    }
    configPath = explicit;
  } else if (fs.existsSync(cwdCandidateNew)) {
    configPath = cwdCandidateNew;
  } else if (fs.existsSync(rootCandidateNew)) {
    configPath = rootCandidateNew;
  }

  if (!configPath) {
    throw new Error(
      'Missing config/config.json. Create it (copy from config/examples/config.example.json) or set LAYA_CONFIG_PATH.'
    );
  }

  const parsed = tryReadJson(configPath);
  if (parsed === null) {
    throw new Error(`Failed to read/parse config.json at ${configPath}`);
  }

  const dir = path.dirname(configPath);
  const resolveMaybeRelative = v => {
    if (typeof v !== 'string' || !v.trim()) return undefined;
    return path.isAbsolute(v) ? v : path.resolve(dir, v);
  };
  const asNumber = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const asBoolean = v => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') return true;
      if (t === 'false' || t === '0' || t === 'no') return false;
    }
    return undefined;
  };

  return {
    configPath,
    config: {
      layaRoot: resolveMaybeRelative(parsed.layaRoot),
      mcpJsonPath: resolveMaybeRelative(parsed.mcpJsonPath),
      ollamaHost: typeof parsed.ollamaHost === 'string' ? parsed.ollamaHost : undefined,
      ollamaModel: typeof parsed.ollamaModel === 'string' ? parsed.ollamaModel : undefined,
      ollamaTimeoutMs: asNumber(parsed.ollamaTimeoutMs),
      maxToolSteps: asNumber(parsed.maxToolSteps),
      ollamaStartupTimeoutMs: asNumber(parsed.ollamaStartupTimeoutMs),
      killOllamaOnExit: asBoolean(parsed.killOllamaOnExit)
    }
  };
}

function spawnClient({ cwd, env }) {
  // Use local tsx so the launcher works without requiring global installs.
  const tsxPath = path.join(cwd, 'node_modules', '.bin', 'tsx');
  return spawn(tsxPath, ['client/src/index.ts'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
}

async function main() {
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { config } = resolveConfig({ scriptRoot });

  const cwd =
    config.layaRoot ??
    scriptRoot;

  const host = config.ollamaHost ?? 'http://127.0.0.1:11434';
  const model = config.ollamaModel ?? 'qwen2.5:1.5b';
  const startupTimeoutMs =
    config.ollamaStartupTimeoutMs ??
    15000;

  let startedPid = null;
  if (!(await isOllamaUp(host))) {
    startedPid = spawnOllamaServe();
    const ok = await waitForOllama(host, startupTimeoutMs);
    if (!ok) {
      process.stderr.write(
        `laya: Ollama did not become ready at ${host} within ${startupTimeoutMs}ms.\n` +
          `Start it manually in another terminal: ollama serve\n`
      );
      process.exit(1);
    }
  }

  // Run client in foreground.
  const child = spawnClient({
    cwd,
    env: {
      // Keep env vars as a compatibility layer; client can also read config.json.
      OLLAMA_HOST: host,
      OLLAMA_MODEL: model,
      OLLAMA_TIMEOUT_MS: String(
        config.ollamaTimeoutMs ?? 120000
      ),
      MAX_TOOL_STEPS: String(config.maxToolSteps ?? 10)
    }
  });

  child.on('exit', (code, signal) => {
    // Optional: stop Ollama if we started it.
    const killOnExit = config.killOllamaOnExit ?? false;
    if (startedPid && killOnExit) {
      try {
        process.kill(startedPid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

main().catch(err => {
  process.stderr.write(`laya launcher error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});


