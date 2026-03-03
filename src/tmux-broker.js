#!/usr/bin/env node
import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const BASE_DIR = join(tmpdir(), 'voice-terminal-tmux-broker');
const LOG_DIR = join(BASE_DIR, 'logs');
const STATE_DIR = join(BASE_DIR, 'states');
const LOCK_DIR = join(BASE_DIR, 'locks');
const QUIET_MS_DEFAULT = 5000;
const POST_PASTE_ENTER_DELAY_MS = 120;
const SUBMIT_KEY = 'Enter';
const MAX_BUFFER = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;

function usage() {
  console.error('Usage: tmux-broker <command> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  send-input    --session <name> [--pane <target>] --text <text> [--no-enter] [--json]');
  console.error('  read-stream   --session <name> [--pane <target>] [--cursor <n>] [--json]');
  console.error('  read-snapshot --session <name> [--pane <target>] [--lines <n>] [--json]');
  console.error('  status        (--session <name> | --all) [--pane <target>] [--all-panes] [--quiet-ms <ms>] [--json]');
}

function parseArgv(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      opts._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'no-enter' || key === 'json' || key === 'all' || key === 'all-panes') {
      opts[key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    opts[key] = value;
    i += 1;
  }
  return { command, opts };
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function stateKey(session, paneId) {
  return `${sanitize(session)}__${sanitize(paneId)}`;
}

function shellEscapeSingleQuoted(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(LOG_DIR, { recursive: true }),
    fs.mkdir(STATE_DIR, { recursive: true }),
    fs.mkdir(LOCK_DIR, { recursive: true })
  ]);
}

async function runTmux(args, options = {}) {
  if (!options.input) {
    const { stdout } = await execFileAsync('tmux', args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS
    });
    return (stdout || '').trimEnd();
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trimEnd());
      } else {
        reject(new Error((stderr || `tmux exited with code ${code}`).trim()));
      }
    });

    proc.stdin.end(options.input);
  });
}

async function resolvePane(sessionName, paneTarget) {
  const session = requireString(sessionName, 'session');
  await runTmux(['has-session', '-t', `=${session}`]);
  const target = (paneTarget && String(paneTarget).trim()) || `=${session}:`;
  const paneId = (await runTmux(['display-message', '-p', '-t', target, '#{pane_id}'])).trim();
  if (!paneId) {
    throw new Error(`unable to resolve pane for target: ${target}`);
  }
  const resolvedSession = (await runTmux(['display-message', '-p', '-t', paneId, '#{session_name}'])).trim() || session;
  return { session: resolvedSession, paneId, target: paneId };
}

async function listSessionPanes(sessionName) {
  const session = requireString(sessionName, 'session');
  await runTmux(['has-session', '-t', `=${session}`]);
  const output = await runTmux(['list-panes', '-t', `=${session}:`, '-F', '#{pane_id}']);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function statePathFor(key) {
  return join(STATE_DIR, `${key}.json`);
}

function logPathFor(key) {
  return join(LOG_DIR, `${key}.log`);
}

async function readState(key) {
  try {
    const raw = await fs.readFile(statePathFor(key), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeState(key, data) {
  const path = statePathFor(key);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, path);
}

async function getFileSize(path) {
  try {
    const stat = await fs.stat(path);
    return stat.size;
  } catch {
    return 0;
  }
}

async function readTail(path, byteCount = 4096) {
  const size = await getFileSize(path);
  if (size === 0) return '';
  const start = Math.max(0, size - byteCount);
  const handle = await fs.open(path, 'r');
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function hasPromptLikeEnding(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  return /(?:\$|#|>|❯|:)\s*$/.test(last);
}

function detectNextState(prevState, deltaBytes, promptLike, quietMs) {
  const now = Date.now();
  const next = { ...prevState, lastStatusAt: now };
  const lastActivity = Number(next.lastActivityAt) || 0;

  if (deltaBytes > 0) {
    next.state = 'working';
    next.lastActivityAt = now;
    next.promptLike = promptLike;
    return next;
  }

  const currentlyWorking = (next.state || 'idle') === 'working';
  if (!currentlyWorking) {
    next.state = 'idle';
    next.promptLike = promptLike;
    return next;
  }

  if (lastActivity === 0 || now - lastActivity < quietMs) {
    next.promptLike = promptLike;
    return next;
  }

  const strongEnough = promptLike || now - lastActivity >= quietMs * 2;
  if (!strongEnough) {
    next.promptLike = promptLike;
    return next;
  }

  next.state = 'idle';
  next.completionCount = Number(next.completionCount || 0) + 1;
  next.lastDoneAt = now;
  next.promptLike = promptLike;
  return next;
}

async function withPaneLock(key, fn, timeoutMs = 10000) {
  const path = join(LOCK_DIR, `${key}.lock`);
  const startedAt = Date.now();
  while (true) {
    let handle;
    try {
      handle = await fs.open(path, 'wx');
      try {
        return await fn();
      } finally {
        await handle.close();
        await fs.unlink(path).catch(() => {});
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for lock: ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function sleep(ms) {
  if (!ms || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePaneState(sessionName, paneTarget) {
  await ensureDirs();
  const resolved = await resolvePane(sessionName, paneTarget);
  const key = stateKey(resolved.session, resolved.paneId);
  const logPath = logPathFor(key);
  await fs.appendFile(logPath, '');

  const pipeCmd = `cat >> ${shellEscapeSingleQuoted(logPath)}`;
  await runTmux(['pipe-pane', '-O', '-t', resolved.target, pipeCmd]);

  const existing = await readState(key);
  if (existing) return { key, state: existing, resolved };

  const currentSize = await getFileSize(logPath);
  const initState = {
    key,
    session: resolved.session,
    paneId: resolved.paneId,
    target: resolved.target,
    logPath,
    cursor: currentSize,
    lastSize: currentSize,
    state: 'idle',
    completionCount: 0,
    lastActivityAt: 0,
    lastDoneAt: 0,
    lastStatusAt: Date.now(),
    promptLike: false
  };
  await writeState(key, initState);
  return { key, state: initState, resolved };
}

async function refreshPaneState(sessionName, paneTarget, quietMs) {
  const { key, state, resolved } = await ensurePaneState(sessionName, paneTarget);
  const currentSize = await getFileSize(state.logPath);
  const lastKnown = Number(state.lastSize ?? state.cursor ?? currentSize);
  const deltaBytes = Math.max(0, currentSize - lastKnown);
  const tail = await readTail(state.logPath);
  const promptLike = hasPromptLikeEnding(tail);
  const next = detectNextState(
    {
      ...state,
      cursor: Number(state.cursor ?? currentSize),
      lastSize: lastKnown,
      completionCount: Number(state.completionCount || 0)
    },
    deltaBytes,
    promptLike,
    quietMs
  );
  next.lastSize = currentSize;
  await writeState(key, next);
  return { key, state: next, resolved, currentSize };
}

function asJson(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function asPlain(output) {
  if (typeof output === 'string') {
    process.stdout.write(output);
    if (!output.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function cmdSendInput(opts) {
  const session = requireString(opts.session, 'session');
  if (typeof opts.text !== 'string') throw new Error('text is required');
  const quietMs = Number(opts['quiet-ms'] || QUIET_MS_DEFAULT);
  const { key, resolved } = await ensurePaneState(session, opts.pane);
  const pressEnter = !opts['no-enter'];
  const payload = opts.text;
  const payloadBytes = Buffer.byteLength(payload);
  const enterDelayMs = pressEnter ? POST_PASTE_ENTER_DELAY_MS : 0;

  const result = await withPaneLock(key, async () => {
    const bufferName = `voice_terminal_${randomUUID().replace(/-/g, '')}`;
    await runTmux(['load-buffer', '-b', bufferName, '-'], { input: payload });
    await runTmux(['paste-buffer', '-d', '-b', bufferName, '-t', resolved.target]);
    if (pressEnter) {
      // Large pastes can race with submit; wait briefly, then use Enter.
      // In tmux 3.4 + Codex panes, lowercase C-m is not reliable as an Enter alias.
      await sleep(enterDelayMs);
      await runTmux(['send-keys', '-t', resolved.target, SUBMIT_KEY]);
    }
    return {
      ok: true,
      session: resolved.session,
      paneId: resolved.paneId,
      bytes: payloadBytes,
      pressEnter,
      enterDelayMs
    };
  });

  await refreshPaneState(session, resolved.paneId, Number.isFinite(quietMs) ? quietMs : QUIET_MS_DEFAULT);
  if (opts.json) asJson(result);
  else asPlain(result);
}

async function cmdReadStream(opts) {
  const session = requireString(opts.session, 'session');
  const quietMs = Number(opts['quiet-ms'] || QUIET_MS_DEFAULT);
  const { key, state, resolved } = await refreshPaneState(session, opts.pane, Number.isFinite(quietMs) ? quietMs : QUIET_MS_DEFAULT);
  const raw = await fs.readFile(state.logPath);
  const explicitCursor = opts.cursor !== undefined ? Number(opts.cursor) : null;
  let start = Number.isInteger(explicitCursor) && explicitCursor >= 0
    ? explicitCursor
    : Number(state.cursor || 0);
  if (start > raw.length) start = raw.length;
  const chunk = raw.subarray(start);
  const nextCursor = raw.length;
  const nextState = { ...state, cursor: nextCursor };
  await writeState(key, nextState);

  const output = {
    ok: true,
    session: resolved.session,
    paneId: resolved.paneId,
    fromCursor: start,
    cursor: nextCursor,
    bytes: chunk.length,
    state: nextState.state,
    completionCount: nextState.completionCount,
    lastDoneAt: nextState.lastDoneAt || 0,
    text: chunk.toString('utf8')
  };
  if (opts.json) asJson(output);
  else asPlain(output.text);
}

async function cmdReadSnapshot(opts) {
  const session = requireString(opts.session, 'session');
  const { resolved } = await ensurePaneState(session, opts.pane);
  const linesRaw = opts.lines !== undefined ? Number(opts.lines) : 200;
  const lines = Number.isFinite(linesRaw) ? Math.max(1, Math.min(Math.trunc(linesRaw), 50000)) : 200;
  const text = await runTmux([
    'capture-pane',
    '-p',
    '-J',
    '-t',
    resolved.target,
    '-S',
    `-${lines}`,
    '-E',
    '-'
  ]);
  const output = {
    ok: true,
    session: resolved.session,
    paneId: resolved.paneId,
    lines,
    text
  };
  if (opts.json) asJson(output);
  else asPlain(text);
}

function summarizeSession(items) {
  let state = 'idle';
  let completionCount = 0;
  let lastDoneAt = 0;
  for (const item of items) {
    if (item.state === 'working') state = 'working';
    completionCount += Number(item.completionCount || 0);
    lastDoneAt = Math.max(lastDoneAt, Number(item.lastDoneAt || 0));
  }
  return { state, completionCount, lastDoneAt };
}

async function statusForSession(session, opts) {
  const quietMs = Number(opts['quiet-ms'] || QUIET_MS_DEFAULT);
  const paneIds = opts.pane
    ? [resolvePane(session, opts.pane).then((x) => x.paneId)]
    : await listSessionPanes(session);
  const resolvedPaneIds = Array.isArray(paneIds[0]) ? paneIds : await Promise.all(paneIds);
  const panes = [];
  for (const paneId of resolvedPaneIds) {
    const refreshed = await refreshPaneState(session, paneId, Number.isFinite(quietMs) ? quietMs : QUIET_MS_DEFAULT);
    panes.push({
      session: refreshed.state.session,
      paneId: refreshed.state.paneId,
      state: refreshed.state.state,
      completionCount: refreshed.state.completionCount,
      lastDoneAt: refreshed.state.lastDoneAt || 0,
      lastActivityAt: refreshed.state.lastActivityAt || 0,
      cursor: refreshed.state.cursor || 0
    });
  }
  const summary = summarizeSession(panes);
  return {
    session,
    state: summary.state,
    completionCount: summary.completionCount,
    lastDoneAt: summary.lastDoneAt,
    panes
  };
}

async function cmdStatus(opts) {
  const sessions = [];
  if (opts.all) {
    const list = await runTmux(['list-sessions', '-F', '#{session_name}']);
    sessions.push(...list.split('\n').map((line) => line.trim()).filter(Boolean));
  } else {
    sessions.push(requireString(opts.session, 'session'));
  }

  const outSessions = [];
  for (const session of sessions) {
    try {
      const status = await statusForSession(session, opts);
      if (opts['all-panes']) {
        outSessions.push(status);
      } else {
        outSessions.push({
          session: status.session,
          state: status.state,
          completionCount: status.completionCount,
          lastDoneAt: status.lastDoneAt
        });
      }
    } catch (err) {
      outSessions.push({
        session,
        error: err.message
      });
    }
  }

  const payload = {
    ok: true,
    sessions: outSessions
  };
  if (opts.json) asJson(payload);
  else asPlain(payload);
}

async function main() {
  const { command, opts } = parseArgv(process.argv.slice(2));
  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'send-input':
      await cmdSendInput(opts);
      return;
    case 'read-stream':
      await cmdReadStream(opts);
      return;
    case 'read-snapshot':
      await cmdReadSnapshot(opts);
      return;
    case 'status':
      await cmdStatus(opts);
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err?.message || String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
