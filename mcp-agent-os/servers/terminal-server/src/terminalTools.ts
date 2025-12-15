import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createTwoFilesPatch } from 'diff';

export type DangerousPattern = {
  command: string;
  argsAnyOf?: string[];
  argsRegexAnyOf?: string[];
};

export type TerminalPolicy = {
  sandboxRoot: string;
  auditLogPath: string;
  allowedCommands: string[];
  blockedArgsRegex?: string[];
  dangerousCommands?: string[];
  dangerousPatterns?: DangerousPattern[];
  confirmTtlSeconds?: number;
  maxOutputChars?: number;
  maxFileReadBytes?: number;
};

export type PendingConfirmation = {
  token: string;
  stage: 1 | 2;
  createdAtMs: number;
  expiresAtMs: number;
  command: string;
  args: string[];
  cwd: string;
  reason: string;
};

export type TerminalContext = {
  policy: TerminalPolicy;
  sandboxRootAbs: string;
  auditLogAbs: string;
  pending: Map<string, PendingConfirmation>;
};

function clampText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n...[truncated to ${maxChars} chars]`;
}

function isSafeCommandName(cmd: string): boolean {
  // No slashes, no spaces, keep it simple.
  return /^[a-zA-Z0-9._-]+$/.test(cmd);
}

export async function loadTerminalPolicy(policyPath: string): Promise<TerminalPolicy> {
  const raw = await fs.readFile(policyPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<TerminalPolicy>;
  if (!parsed.allowedCommands || !Array.isArray(parsed.allowedCommands) || parsed.allowedCommands.length === 0) {
    throw new Error('terminal-policy.json must include non-empty allowedCommands');
  }
  return {
    sandboxRoot: parsed.sandboxRoot ?? '.',
    auditLogPath: parsed.auditLogPath ?? '.mcp-audit/terminal-server.jsonl',
    allowedCommands: parsed.allowedCommands,
    blockedArgsRegex: parsed.blockedArgsRegex ?? [],
    dangerousCommands: parsed.dangerousCommands ?? [],
    dangerousPatterns: parsed.dangerousPatterns ?? [],
    confirmTtlSeconds: parsed.confirmTtlSeconds ?? 90,
    maxOutputChars: parsed.maxOutputChars ?? 20000,
    maxFileReadBytes: parsed.maxFileReadBytes ?? 200000
  };
}

export async function createTerminalContext(opts?: { policyPath?: string }): Promise<TerminalContext> {
  const policyPath =
    opts?.policyPath ??
    process.env.TERMINAL_POLICY_PATH ??
    path.resolve(process.cwd(), 'servers/terminal-server/terminal-policy.json');

  const policy = await loadTerminalPolicy(policyPath);

  const sandboxRootAbs = path.resolve(process.cwd(), policy.sandboxRoot);
  const auditLogAbs = path.isAbsolute(policy.auditLogPath)
    ? policy.auditLogPath
    : path.resolve(sandboxRootAbs, policy.auditLogPath);

  await fs.mkdir(path.dirname(auditLogAbs), { recursive: true });

  return {
    policy,
    sandboxRootAbs,
    auditLogAbs,
    pending: new Map()
  };
}

export function resolveSandboxPath(ctx: TerminalContext, userPath: string): string {
  // Paths are interpreted relative to sandbox root unless absolute.
  const abs = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(ctx.sandboxRootAbs, userPath);

  const rel = path.relative(ctx.sandboxRootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside sandboxRoot: ${userPath}`);
  }
  return abs;
}

function isDangerous(ctx: TerminalContext, command: string, args: string[]): string | null {
  if (ctx.policy.dangerousCommands?.includes(command)) {
    return `Command "${command}" is marked dangerous by policy`;
  }

  for (const rule of ctx.policy.dangerousPatterns ?? []) {
    if (rule.command !== command) continue;
    if (rule.argsAnyOf && rule.argsAnyOf.some(a => args.includes(a))) {
      return `Dangerous pattern matched for "${command}" (argsAnyOf)`;
    }
    if (rule.argsRegexAnyOf) {
      for (const reStr of rule.argsRegexAnyOf) {
        const re = new RegExp(reStr);
        if (args.some(a => re.test(a))) return `Dangerous pattern matched for "${command}" (${reStr})`;
      }
    }
  }

  return null;
}

function checkArgsAgainstPolicy(ctx: TerminalContext, args: string[]) {
  for (const reStr of ctx.policy.blockedArgsRegex ?? []) {
    const re = new RegExp(reStr);
    const bad = args.find(a => re.test(a));
    if (bad) throw new Error(`Blocked argument by policy: ${bad}`);
  }

  // Basic path-escape guard: forbid ".." segments and absolute paths outside sandbox.
  for (const a of args) {
    if (a.includes('..')) throw new Error(`Refusing argument containing "..": ${a}`);
    if (a.startsWith('/')) {
      const abs = path.resolve(a);
      const rel = path.relative(ctx.sandboxRootAbs, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Absolute path argument outside sandbox: ${a}`);
      }
    }
  }
}

async function appendAudit(ctx: TerminalContext, entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await fs.appendFile(ctx.auditLogAbs, line, 'utf-8');
}

function createPendingConfirmation(
  ctx: TerminalContext,
  params: { command: string; args: string[]; cwdAbs: string; reason: string }
): PendingConfirmation {
  const ttlMs = (ctx.policy.confirmTtlSeconds ?? 90) * 1000;
  const now = Date.now();
  const token = crypto.randomUUID();
  const pending: PendingConfirmation = {
    token,
    stage: 1,
    createdAtMs: now,
    expiresAtMs: now + ttlMs,
    command: params.command,
    args: params.args,
    cwd: params.cwdAbs,
    reason: params.reason
  };
  ctx.pending.set(token, pending);
  return pending;
}

export async function toolRun(
  ctx: TerminalContext,
  params: { command: string; args?: string[]; cwd?: string }
): Promise<{ text: string; requiresConfirmation?: { token: string; reason: string; expiresAt: string } }> {
  const command = params.command;
  const args = params.args ?? [];
  const cwdAbs = resolveSandboxPath(ctx, params.cwd ?? '.');

  if (!isSafeCommandName(command)) throw new Error(`Invalid command name: ${command}`);
  if (!ctx.policy.allowedCommands.includes(command)) throw new Error(`Command not allowed: ${command}`);

  checkArgsAgainstPolicy(ctx, args);

  const dangerReason = isDangerous(ctx, command, args);
  if (dangerReason) {
    const pending = createPendingConfirmation(ctx, { command, args, cwdAbs, reason: dangerReason });

    await appendAudit(ctx, {
      event: 'run_requires_confirmation_stage1',
      token: pending.token,
      command,
      args,
      cwd: cwdAbs,
      reason: dangerReason
    });

    return {
      text:
        `Refusing to execute dangerous command without confirmation.\n` +
        `Reason: ${dangerReason}\n` +
        `Step 1/2: run: confirm ${pending.token}\n`,
      requiresConfirmation: {
        token: pending.token,
        reason: dangerReason,
        expiresAt: new Date(pending.expiresAtMs).toISOString()
      }
    };
  }

  const result = await spawnAndCapture(command, args, cwdAbs, ctx.policy.maxOutputChars ?? 20000);
  await appendAudit(ctx, {
    event: 'run_executed',
    command,
    args,
    cwd: cwdAbs,
    exitCode: result.exitCode
  });
  return { text: result.output };
}

export async function toolConfirm(
  ctx: TerminalContext,
  params: { token: string }
): Promise<{ text: string }> {
  const token = params.token;
  const pending = ctx.pending.get(token);
  if (!pending) throw new Error('Unknown confirmation token (maybe expired or already used)');
  if (Date.now() > pending.expiresAtMs) {
    ctx.pending.delete(token);
    throw new Error('Confirmation token expired');
  }

  // Double-confirm:
  // - Stage 1 token -> returns Stage 2 token
  // - Stage 2 token -> executes
  if (pending.stage === 1) {
    ctx.pending.delete(token);

    const ttlMs = (ctx.policy.confirmTtlSeconds ?? 90) * 1000;
    const now = Date.now();
    const token2 = crypto.randomUUID();
    const pending2: PendingConfirmation = {
      token: token2,
      stage: 2,
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
      command: pending.command,
      args: pending.args,
      cwd: pending.cwd,
      reason: pending.reason
    };
    ctx.pending.set(token2, pending2);

    await appendAudit(ctx, {
      event: 'confirm_stage1_issued_stage2',
      token1: token,
      token2,
      command: pending.command,
      args: pending.args,
      cwd: pending.cwd,
      reason: pending.reason
    });

    return {
      text:
        `Confirmation step 1/2 accepted.\n` +
        `Reason: ${pending.reason}\n` +
        `Step 2/2: run: confirm ${token2}\n`
    };
  }

  ctx.pending.delete(token);
  const result = await spawnAndCapture(pending.command, pending.args, pending.cwd, ctx.policy.maxOutputChars ?? 20000);

  // Post-processing for ssh-keygen: enforce safe permissions for ~/.ssh and key files.
  if (pending.command === 'ssh-keygen') {
    try {
      const fIdx = pending.args.findIndex(a => a === '-f');
      const keyPath = fIdx >= 0 ? pending.args[fIdx + 1] : undefined;
      if (keyPath && typeof keyPath === 'string') {
        const sshDir = path.dirname(keyPath);
        // Only touch within ~/.ssh to avoid unexpected chmods.
        const home = os.homedir();
        const sshDirAbs = path.resolve(sshDir);
        const expected = path.resolve(home, '.ssh');
        if (sshDirAbs === expected) {
          await fs.chmod(expected, 0o700).catch(() => {});
          await fs.chmod(keyPath, 0o600).catch(() => {});
          await fs.chmod(`${keyPath}.pub`, 0o644).catch(() => {});
        }
      }
    } catch {
      // best-effort; don't fail the command
    }
  }

  await appendAudit(ctx, {
    event: 'confirm_executed',
    token,
    stage: pending.stage,
    command: pending.command,
    args: pending.args,
    cwd: pending.cwd,
    reason: pending.reason,
    exitCode: result.exitCode
  });

  return { text: result.output };
}

export async function toolCancel(ctx: TerminalContext, params: { token: string }): Promise<{ text: string }> {
  const existed = ctx.pending.delete(params.token);
  await appendAudit(ctx, { event: 'confirm_cancel', token: params.token, existed });
  return { text: existed ? 'Cancelled pending confirmation.' : 'No pending confirmation for that token.' };
}

function ensureSafeSshKeyFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('filename must be non-empty');
  if (trimmed.includes('/') || trimmed.includes('\\')) throw new Error('filename must not contain path separators');
  if (trimmed === '.' || trimmed === '..') throw new Error('invalid filename');
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) throw new Error('filename contains invalid characters');
  return trimmed;
}

export async function toolGenerateSshKey(
  ctx: TerminalContext,
  params: { type?: 'ed25519' | 'rsa'; filename?: string; comment?: string; passphrase?: string; overwrite?: boolean }
): Promise<{ text: string; requiresConfirmation?: { token: string; reason: string; expiresAt: string } }> {
  const keyType = params.type ?? 'ed25519';
  const filename = ensureSafeSshKeyFileName(params.filename ?? 'id_ed25519');
  const comment = params.comment ?? 'smartos-mcp';
  const passphrase = params.passphrase ?? '';
  const overwrite = params.overwrite ?? false;

  const home = os.homedir();
  const sshDir = path.resolve(home, '.ssh');
  const keyPath = path.join(sshDir, filename);

  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });

  const exists =
    (await fs
      .stat(keyPath)
      .then(() => true)
      .catch(() => false)) ||
    (await fs
      .stat(`${keyPath}.pub`)
      .then(() => true)
      .catch(() => false));
  if (exists && !overwrite) {
    throw new Error(`Key already exists at ~/.ssh/${filename} (pass overwrite:true to replace)`);
  }

  // Always require confirmation for writes to ~/.ssh.
  const args: string[] = ['-t', keyType, '-f', keyPath, '-C', comment, '-N', passphrase];

  const reason =
    `Requested SSH key generation under ~/.ssh.\n` +
    `Type: ${keyType}\n` +
    `Target: ~/.ssh/${filename}\n` +
    (exists ? `NOTE: existing key files will be overwritten.\n` : '') +
    (passphrase ? `NOTE: a passphrase was provided.\n` : `NOTE: empty passphrase.\n`);

  const pending = createPendingConfirmation(ctx, { command: 'ssh-keygen', args, cwdAbs: home, reason });

  await appendAudit(ctx, {
    event: 'ssh_keygen_requires_confirmation_stage1',
    token: pending.token,
    keyType,
    keyPath,
    overwrite
  });

  return {
    text:
      `Refusing to generate SSH key under ~/.ssh without confirmation.\n` +
      `Reason:\n${reason}\n` +
      `Step 1/2: run: confirm ${pending.token}\n`,
    requiresConfirmation: { token: pending.token, reason, expiresAt: new Date(pending.expiresAtMs).toISOString() }
  };
}

async function spawnAndCapture(
  command: string,
  args: string[],
  cwd: string,
  maxOutputChars: number
): Promise<{ output: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';

    child.stdout.on('data', (d: Buffer) => {
      out += String(d);
      if (out.length > maxOutputChars) out = clampText(out, maxOutputChars);
    });
    child.stderr.on('data', (d: Buffer) => {
      err += String(d);
      if (err.length > maxOutputChars) err = clampText(err, maxOutputChars);
    });

    child.on('error', reject);
    child.on('close', (code: number | null) => {
      const combined = (out + (err ? `\n[stderr]\n${err}` : '')).trimEnd();
      resolve({ output: combined || '(no output)', exitCode: code });
    });
  });
}

export async function toolReadFile(ctx: TerminalContext, params: { path: string }): Promise<{ text: string }> {
  const abs = resolveSandboxPath(ctx, params.path);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error('Not a file');

  const maxBytes = ctx.policy.maxFileReadBytes ?? 200000;
  const buf = await fs.readFile(abs);
  const clipped = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const text = clipped.toString('utf-8');

  await appendAudit(ctx, { event: 'read_file', path: abs, bytes: clipped.byteLength });
  return { text: buf.byteLength > maxBytes ? text + `\n...[truncated to ${maxBytes} bytes]` : text };
}

export async function toolWriteFile(
  ctx: TerminalContext,
  params: { path: string; content: string; mode?: 'overwrite' | 'append' | 'create' }
): Promise<{ text: string }> {
  const abs = resolveSandboxPath(ctx, params.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const mode = params.mode ?? 'overwrite';
  if (mode === 'create') {
    await fs.writeFile(abs, params.content, { flag: 'wx' });
  } else if (mode === 'append') {
    await fs.appendFile(abs, params.content, 'utf-8');
  } else {
    await fs.writeFile(abs, params.content, 'utf-8');
  }

  await appendAudit(ctx, { event: 'write_file', path: abs, mode, bytes: Buffer.byteLength(params.content) });
  return { text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${path.relative(ctx.sandboxRootAbs, abs)}` };
}

export async function toolDiff(
  ctx: TerminalContext,
  params: { path: string; newContent: string }
): Promise<{ text: string }> {
  const abs = resolveSandboxPath(ctx, params.path);
  let old = '';
  try {
    old = await fs.readFile(abs, 'utf-8');
  } catch {
    old = '';
  }

  const patch = createTwoFilesPatch(
    `a/${path.relative(ctx.sandboxRootAbs, abs)}`,
    `b/${path.relative(ctx.sandboxRootAbs, abs)}`,
    old,
    params.newContent,
    undefined,
    undefined,
    { context: 3 }
  );

  await appendAudit(ctx, { event: 'diff', path: abs, oldBytes: Buffer.byteLength(old), newBytes: Buffer.byteLength(params.newContent) });
  return { text: patch.trimEnd() || '(no diff)' };
}

export async function toolSearch(
  ctx: TerminalContext,
  params: { query: string; maxMatches?: number }
): Promise<{ text: string }> {
  const query = params.query;
  const maxMatches = params.maxMatches ?? 50;

  const matches: string[] = [];
  const root = ctx.sandboxRootAbs;

  const ignoreDirs = new Set(['.git', 'node_modules', '.mcp-audit', 'dist']);

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (matches.length >= maxMatches) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue;
        await walk(p);
      } else if (e.isFile()) {
        // limit file size
        const st = await fs.stat(p);
        if (st.size > 1_000_000) continue;
        const content = await fs.readFile(p, 'utf-8').catch(() => '');
        if (!content) continue;
        const idx = content.indexOf(query);
        if (idx >= 0) {
          matches.push(path.relative(root, p));
        }
      }
    }
  }

  await walk(root);
  await appendAudit(ctx, { event: 'search', query, maxMatches, found: matches.length });
  return { text: matches.length ? matches.map(m => `- ${m}`).join('\n') : '(no matches)' };
}


