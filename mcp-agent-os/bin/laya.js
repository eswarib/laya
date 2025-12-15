#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

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
  // Detached so it can keep running in the background.
  const child = spawn('ollama', ['serve'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });
  child.unref();
  return child.pid ?? null;
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
  const cwd = process.env.LAYA_ROOT
    ? path.resolve(process.env.LAYA_ROOT)
    : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  const startupTimeoutMs = Number(process.env.LAYA_OLLAMA_STARTUP_TIMEOUT_MS ?? '15000') || 15000;

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
      OLLAMA_HOST: host,
      OLLAMA_MODEL: model
    }
  });

  child.on('exit', (code, signal) => {
    // Optional: stop Ollama if we started it.
    if (startedPid && process.env.LAYA_KILL_OLLAMA_ON_EXIT === '1') {
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


