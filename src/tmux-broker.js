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
const SUBMIT_KEY = 'Enter';
const MAX_BUFFER = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const STALE_LOCK_MS = 60000;
// Guard against a pane log growing without bound: read-stream only ever needs
// the bytes after the cursor, so never pull more than this into memory at once.
const MAX_STREAM_READ_BYTES = 5 * 1024 * 1024;

function usage() {
  console.error('Usage: tmux-broker <command> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  send-input    --session <name> [--pane <target>] --text <text> [--no-enter] [--force] [--json]');
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
    if (key === 'no-enter' || key === 'json' || key === 'all' || key === 'all-panes' || key === 'force') {
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

async function readRange(path, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    // A single read() can come up short; trust bytesRead rather than the
    // requested length, otherwise the tail is padded with NUL bytes.
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTail(path, byteCount = 4096) {
  const size = await getFileSize(path);
  if (size === 0) return '';
  const start = Math.max(0, size - byteCount);
  return (await readRange(path, start, size - start)).toString('utf8');
}

function hasPromptLikeEnding(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  return /(?:\$|#|>|❯|:)\s*$/.test(last);
}

// ---------------------------------------------------------------------------
// Blocking-dialog detection
//
// A TUI sitting on a modal select renders once and then goes quiet, so the pane
// log shows no delta and the pane reads as 'idle' -- indistinguishable from a
// session waiting at its prompt.  The difference only exists on the rendered
// screen, so these helpers look there instead of at the log.
//
// Everything here fails open: any doubt, any tmux error, any unfamiliar layout
// returns null and callers behave exactly as they did before this existed.  A
// false positive would refuse a legitimate send, which is far worse than
// missing a dialog and landing back on today's behaviour.
// ---------------------------------------------------------------------------

// The footer every Claude Code select renders. The confirm verb varies -- the
// trust dialog says "Enter to confirm", the /model picker says "Enter to set as
// default" -- but the cancel half is stable, and it is capitalised, so it does
// not collide with the "esc to interrupt" a mid-turn pane shows.
const DIALOG_FOOTER_RE = /Esc to cancel|Enter to confirm/;
// How many trailing non-empty lines may hold that footer. Dialogs draw it last;
// bounding it this tightly stops transcript text that merely quotes the phrase
// from matching.
const DIALOG_FOOTER_SCAN_LINES = 2;
// "❯ 1. Yes, I trust this folder" / "  2. No, exit"
const DIALOG_OPTION_RE = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;

function classifyDialog(screen) {
  if (/Bypass Permissions mode/i.test(screen)) return 'bypass-permissions';
  if (/trust this folder|Quick safety check/i.test(screen)) return 'trust-folder';
  if (/trust these settings/i.test(screen)) return 'trust-settings';
  return 'select';
}

function detectPaneDialog(screen) {
  const text = String(screen || '');
  const lines = text.split('\n');

  const nonEmpty = lines.filter((line) => line.trim());
  const footer = nonEmpty.slice(-DIALOG_FOOTER_SCAN_LINES);
  if (!footer.some((line) => DIALOG_FOOTER_RE.test(line))) return null;

  const options = [];
  for (const rawLine of lines) {
    const match = rawLine.match(DIALOG_OPTION_RE);
    if (!match) continue;
    options.push({
      index: Number(match[2]),
      label: match[3].trim(),
      selected: Boolean(match[1])
    });
  }
  // Footer without a numbered option list is not a shape we know how to answer.
  if (options.length === 0) return null;

  const selected = options.find((option) => option.selected);
  // No visible cursor means we cannot say what an Enter would confirm, so this
  // is not something to block on -- fall through to the pre-existing behaviour.
  if (!selected) return null;

  return {
    kind: classifyDialog(text),
    options,
    selectedIndex: selected.index,
    selectedLabel: selected.label
  };
}

// Visible screen only -- deliberately no -S. Scrollback would match dialogs the
// user answered minutes ago and block every subsequent send.
async function readPaneDialog(target) {
  try {
    const screen = await runTmux(['capture-pane', '-p', '-J', '-t', target]);
    return detectPaneDialog(screen);
  } catch {
    return null;
  }
}

function describeDialog(dialog) {
  const lines = [`${dialog.kind} dialog is open`];
  for (const option of dialog.options) {
    lines.push(`  ${option.selected ? '❯' : ' '} ${option.index}. ${option.label}`);
  }
  return lines.join('\n');
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
      // A holder that was SIGKILLed leaves its lock file behind forever, which
      // would wedge this pane for every future caller.  Reclaim clearly-stale ones.
      try {
        const { mtimeMs } = await fs.stat(path);
        if (Date.now() - mtimeMs > STALE_LOCK_MS) {
          await fs.unlink(path).catch(() => {});
          continue;
        }
      } catch { /* lock vanished between open and stat; just retry */ }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for lock: ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function ensurePaneState(sessionName, paneTarget) {
  await ensureDirs();
  const resolved = await resolvePane(sessionName, paneTarget);
  const key = stateKey(resolved.session, resolved.paneId);
  const logPath = logPathFor(key);
  await fs.appendFile(logPath, '');

  // Only (re)establish the pipe when the pane isn't already piped.  This runs on
  // every status poll; unconditionally re-running pipe-pane killed and respawned
  // the `cat` helper each time, which is pure churn and can drop pane output in
  // the gap between teardown and re-attach.
  const alreadyPiped = (await runTmux(['display-message', '-p', '-t', resolved.target, '#{pane_pipe}'])).trim();
  if (alreadyPiped !== '1') {
    const pipeCmd = `cat >> ${shellEscapeSingleQuoted(logPath)}`;
    await runTmux(['pipe-pane', '-O', '-t', resolved.target, pipeCmd]);
  }

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
  const force = Boolean(opts.force);
  const pressEnter = !opts['no-enter'];
  const payload = opts.text;
  const payloadBytes = Buffer.byteLength(payload);
  const hasPayload = payloadBytes > 0;

  const result = await withPaneLock(key, async () => {
    // A modal select discards the pasted text but still consumes the Enter that
    // follows, confirming whichever option happens to be highlighted.  On the
    // bypass-permissions dialog that default is "No, exit", so an ordinary send
    // silently kills the session.  Refuse rather than guess.
    if (!force) {
      const dialog = await readPaneDialog(resolved.target);
      if (dialog) {
        return {
          ok: false,
          blocked: true,
          reason: 'dialog-open',
          session: resolved.session,
          paneId: resolved.paneId,
          dialog,
          hint: 'Answer it with `tmux-broker send-keys` (e.g. --key Down --key Enter), or re-send with --force to paste anyway.'
        };
      }
    }

    if (hasPayload) {
      const bufferName = `voice_terminal_${randomUUID().replace(/-/g, '')}`;
      await runTmux(['load-buffer', '-b', bufferName, '-'], { input: payload });
      // Use -p so bracketed paste-aware apps (like Claude Code) can safely handle large payloads.
      await runTmux(['paste-buffer', '-d', '-r', '-p', '-b', bufferName, '-t', resolved.target]);
      if (pressEnter) {
        // Delay before Enter so the TUI app (React/ink) finishes processing the
        // bracketed paste before we submit.  Without this, Enter arrives before
        // the paste is committed to the input buffer and gets swallowed.
        await new Promise((resolve) => setTimeout(resolve, 150));
        await runTmux(['send-keys', '-t', resolved.target, SUBMIT_KEY]);
      }
    } else if (pressEnter) {
      await runTmux(['send-keys', '-t', resolved.target, SUBMIT_KEY]);
    }
    return {
      ok: true,
      session: resolved.session,
      paneId: resolved.paneId,
      bytes: payloadBytes,
      pressEnter
    };
  });

  if (result.blocked) {
    // Exit 2, not 1: a caller can tell "the pane is waiting on a question" from
    // "the command failed", and nothing was sent either way.
    process.exitCode = 2;
    if (opts.json) asJson(result);
    else asPlain(`refused: nothing sent -- ${describeDialog(result.dialog)}\n${result.hint}`);
    return;
  }

  await refreshPaneState(session, resolved.paneId, Number.isFinite(quietMs) ? quietMs : QUIET_MS_DEFAULT);
  if (opts.json) asJson(result);
  else asPlain(result);
}

async function cmdReadStream(opts) {
  const session = requireString(opts.session, 'session');
  const quietMs = Number(opts['quiet-ms'] || QUIET_MS_DEFAULT);
  const { key, state, resolved } = await refreshPaneState(session, opts.pane, Number.isFinite(quietMs) ? quietMs : QUIET_MS_DEFAULT);
  const size = await getFileSize(state.logPath);
  const explicitCursor = opts.cursor !== undefined ? Number(opts.cursor) : null;
  let start = Number.isInteger(explicitCursor) && explicitCursor >= 0
    ? explicitCursor
    : Number(state.cursor || 0);
  if (start > size) start = size;
  // Read only the unread tail rather than the whole file, and cap it so a pane
  // that has produced megabytes since the last poll can't blow up memory.
  if (size - start > MAX_STREAM_READ_BYTES) start = size - MAX_STREAM_READ_BYTES;
  const chunk = await readRange(state.logPath, start, size - start);
  const nextCursor = size;
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
  let dialog = null;
  for (const item of items) {
    // Precedence: something actively running outranks something waiting on a
    // question, which outranks an ordinary idle prompt.
    if (item.state === 'working') state = 'working';
    else if (item.state === 'blocked' && state !== 'working') state = 'blocked';
    if (item.dialog && !dialog) dialog = item.dialog;
    completionCount += Number(item.completionCount || 0);
    lastDoneAt = Math.max(lastDoneAt, Number(item.lastDoneAt || 0));
  }
  return { state, completionCount, lastDoneAt, dialog };
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
    const pane = {
      session: refreshed.state.session,
      paneId: refreshed.state.paneId,
      state: refreshed.state.state,
      completionCount: refreshed.state.completionCount,
      lastDoneAt: refreshed.state.lastDoneAt || 0,
      lastActivityAt: refreshed.state.lastActivityAt || 0,
      cursor: refreshed.state.cursor || 0
    };

    // Only idle panes: a pane still producing output cannot be parked on a
    // modal, so this keeps the extra capture off the busy path entirely.
    if (pane.state === 'idle') {
      const dialog = await readPaneDialog(refreshed.state.target || pane.paneId);
      if (dialog) {
        pane.state = 'blocked';
        pane.dialog = dialog;
      }
    }

    panes.push(pane);
  }
  const summary = summarizeSession(panes);
  return {
    session,
    state: summary.state,
    completionCount: summary.completionCount,
    lastDoneAt: summary.lastDoneAt,
    ...(summary.dialog ? { dialog: summary.dialog } : {}),
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
          lastDoneAt: status.lastDoneAt,
          // Carried into the compact shape too: a caller checking whether a
          // session needs attention should not have to ask for --all-panes.
          ...(status.dialog ? { dialog: status.dialog } : {})
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

// A consumer that stops reading (a pipe into `head`, a killed parent) otherwise
// takes this process down with an unhandled 'error' event mid-write.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

main().catch((err) => {
  const message = err?.message || String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
