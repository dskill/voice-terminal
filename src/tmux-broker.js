import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const TMUX_MAX_BUFFER = 10 * 1024 * 1024;
const TMUX_TIMEOUT_MS = 15000;
const DEFAULT_SNAPSHOT_LINES = 200;
const MAX_SNAPSHOT_LINES = 50000;
const LOG_DIR = join(tmpdir(), 'voice-terminal-tmux-broker');

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function shellEscapeSingleQuoted(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function sanitizePaneId(paneId) {
  return paneId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

class TmuxBroker {
  constructor() {
    this.paneQueues = new Map();
    this.paneCursors = new Map();
    this.paneStreams = new Map();
    this.ready = fs.mkdir(LOG_DIR, { recursive: true });
  }

  async _runTmux(args, options = {}) {
    if (!options.input) {
      const { stdout } = await execFileAsync('tmux', args, {
        encoding: 'utf8',
        maxBuffer: TMUX_MAX_BUFFER,
        timeout: TMUX_TIMEOUT_MS
      });
      return (stdout || '').trimEnd();
    }

    return new Promise((resolve, reject) => {
      const tmux = spawn('tmux', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        tmux.kill('SIGTERM');
      }, TMUX_TIMEOUT_MS);

      tmux.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      tmux.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      tmux.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      tmux.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trimEnd());
          return;
        }
        const detail = (stderr || '').trim() || `tmux exited with code ${code}`;
        reject(new Error(detail));
      });

      tmux.stdin.end(options.input);
    });
  }

  async _assertSessionExists(sessionName) {
    const session = assertNonEmpty(sessionName, 'session');
    try {
      await this._runTmux(['has-session', '-t', session]);
      return session;
    } catch {
      throw new Error(`tmux session not found: ${session}`);
    }
  }

  async _resolvePane(sessionName, paneTarget) {
    const session = await this._assertSessionExists(sessionName);
    const requestedTarget = (paneTarget && String(paneTarget).trim()) || session;
    const paneId = (await this._runTmux([
      'display-message',
      '-p',
      '-t',
      requestedTarget,
      '#{pane_id}'
    ])).trim();

    if (!paneId) {
      throw new Error(`unable to resolve pane for target: ${requestedTarget}`);
    }

    const resolvedSession = (await this._runTmux([
      'display-message',
      '-p',
      '-t',
      paneId,
      '#{session_name}'
    ])).trim() || session;

    return {
      session: resolvedSession,
      paneId,
      target: paneId
    };
  }

  _enqueuePane(paneId, task) {
    const prev = this.paneQueues.get(paneId) || Promise.resolve();
    const run = prev.catch(() => {}).then(task);
    this.paneQueues.set(paneId, run);
    return run.finally(() => {
      if (this.paneQueues.get(paneId) === run) {
        this.paneQueues.delete(paneId);
      }
    });
  }

  _logPathForPane(paneId) {
    return join(LOG_DIR, `${sanitizePaneId(paneId)}.log`);
  }

  async setupReadStream(sessionName, paneTarget) {
    await this.ready;
    const resolved = await this._resolvePane(sessionName, paneTarget);
    const logPath = this._logPathForPane(resolved.paneId);

    await fs.appendFile(logPath, '');
    const appendCommand = `cat >> ${shellEscapeSingleQuoted(logPath)}`;
    await this._runTmux(['pipe-pane', '-O', '-t', resolved.target, appendCommand]);

    let size = 0;
    try {
      const stat = await fs.stat(logPath);
      size = stat.size;
    } catch {
      size = 0;
    }

    this.paneStreams.set(resolved.paneId, {
      session: resolved.session,
      paneId: resolved.paneId,
      logPath
    });
    if (!this.paneCursors.has(resolved.paneId)) {
      this.paneCursors.set(resolved.paneId, size);
    }

    return {
      session: resolved.session,
      paneId: resolved.paneId,
      logPath,
      cursor: this.paneCursors.get(resolved.paneId) || 0
    };
  }

  async setupSessionLogging(sessionName) {
    const session = await this._assertSessionExists(sessionName);
    const output = await this._runTmux(['list-panes', '-t', session, '-F', '#{pane_id}']);
    const paneIds = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const results = [];
    for (const paneId of paneIds) {
      results.push(await this.setupReadStream(session, paneId));
    }
    return results;
  }

  async sendInput(sessionName, paneTarget, text, pressEnter = true) {
    const payload = String(text ?? '');
    const resolved = await this._resolvePane(sessionName, paneTarget);
    await this.setupReadStream(resolved.session, resolved.paneId);

    return this._enqueuePane(resolved.paneId, async () => {
      const bufferName = `voice_terminal_${randomUUID().replace(/-/g, '')}`;
      await this._runTmux(['load-buffer', '-b', bufferName, '-'], { input: payload });
      await this._runTmux(['paste-buffer', '-d', '-b', bufferName, '-t', resolved.target]);
      if (pressEnter) {
        await this._runTmux(['send-keys', '-t', resolved.target, 'Enter']);
      }
      return {
        session: resolved.session,
        paneId: resolved.paneId,
        bytes: Buffer.byteLength(payload),
        pressEnter: !!pressEnter
      };
    });
  }

  async readSnapshot(sessionName, paneTarget, lines = DEFAULT_SNAPSHOT_LINES) {
    const resolved = await this._resolvePane(sessionName, paneTarget);
    const lineCount = Number.isFinite(lines)
      ? Math.max(1, Math.min(Math.trunc(lines), MAX_SNAPSHOT_LINES))
      : DEFAULT_SNAPSHOT_LINES;
    const text = await this._runTmux([
      'capture-pane',
      '-p',
      '-J',
      '-t',
      resolved.target,
      '-S',
      `-${lineCount}`,
      '-E',
      '-'
    ]);

    return {
      session: resolved.session,
      paneId: resolved.paneId,
      lines: lineCount,
      text
    };
  }

  async readStream(sessionName, paneTarget, cursor = null) {
    const stream = await this.setupReadStream(sessionName, paneTarget);
    const raw = await fs.readFile(stream.logPath);
    let start = Number.isInteger(cursor) && cursor >= 0
      ? cursor
      : (this.paneCursors.get(stream.paneId) || 0);
    if (start > raw.length) {
      start = raw.length;
    }

    const chunk = raw.subarray(start);
    const nextCursor = raw.length;
    this.paneCursors.set(stream.paneId, nextCursor);

    return {
      session: stream.session,
      paneId: stream.paneId,
      cursor: nextCursor,
      fromCursor: start,
      text: chunk.toString('utf8'),
      bytes: chunk.length
    };
  }
}

const broker = new TmuxBroker();

export function tmuxSendInput(session, pane, text, pressEnter = true) {
  return broker.sendInput(session, pane, text, pressEnter);
}

export function tmuxReadSnapshot(session, pane, lines = DEFAULT_SNAPSHOT_LINES) {
  return broker.readSnapshot(session, pane, lines);
}

export function tmuxSetupReadStream(session, pane) {
  return broker.setupReadStream(session, pane);
}

export function tmuxReadStream(session, pane, cursor = null) {
  return broker.readStream(session, pane, cursor);
}

export function tmuxSetupSessionLogging(session) {
  return broker.setupSessionLogging(session);
}
