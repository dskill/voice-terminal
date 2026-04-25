import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import express from 'express';
import formidable from 'formidable';
import { spawn, execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'fs';
import { createInterface } from 'readline';
import { homedir, tmpdir } from 'os';
import { loadTTSModel, isTTSReady, synthesizeStream } from './tts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

const ORCHESTRATOR_CONFIG = {
  claude: {
    kind: 'claude',
    label: 'Claude Opus 4.7',
    defaultModel: 'claude-code'
  },
  'claude-sonnet-4-6': {
    kind: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    defaultModel: 'claude-sonnet-4-6'
  },
  codex: {
    kind: 'codex',
    label: 'Codex (Spark)',
    defaultModel: 'gpt-5.3-codex-spark'
  }
};

const SUPPORTED_ORCHESTRATORS = Object.keys(ORCHESTRATOR_CONFIG);

function normalizeOrchestratorKind(kind) {
  if (kind === 'codex') return 'codex';
  if (kind === 'claude') return 'claude';
  if (kind === 'claude-sonnet-4-6') return 'claude-sonnet-4-6';
  return 'claude';
}

function orchestratorLabel(kind) {
  return ORCHESTRATOR_CONFIG[normalizeOrchestratorKind(kind)].label;
}

// Serve static files
const distPath = join(__dirname, '../dist');
const publicPath = join(__dirname, '../public');
const systemPromptPath = join(__dirname, '../orchestrator-system-prompt.md');
const staticPath = existsSync(distPath) ? distPath : publicPath;
const uploadsDir = join(homedir(), 'voice-terminal', 'uploads');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
console.log(`Serving static files from: ${staticPath}`);
app.use(express.static(staticPath));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ============================================
// Orchestrator Session State
// ============================================

let activeOrchestratorKind = normalizeOrchestratorKind(process.env.ORCHESTRATOR || 'claude-sonnet-4-6');
let orchestrator = null;
let sessionReady = false;
let sessionInitialized = false;
let responseBuffer = '';
let connectedClients = new Set();
let conversationHistory = [];
let sessionMetadata = {};
let currentTurnEvents = [];
let cancelledTurn = false;
let currentTurnToolCalls = [];
let currentTurnTimeline = [];
let currentTurnSeq = 0;
let inFlightTurn = null;
let nextMessageId = 1;
let sttWorkerProcess = null;
let sttReady = false;
let sttPending = new Map();
let tmuxStatusInterval = null;
let lastTmuxStatusJson = '';
let activeTmuxSessionName = '';
const activeTTSStreams = new Map();
const activeVmUpdateRuns = new Map();

function cloneToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => ({
    toolName: tc?.toolName,
    input: tc?.input
  }));
}

function cloneTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline.map((event) => ({ ...event }));
}

function snapshotCurrentTurn() {
  return {
    fullResponse: responseBuffer || '',
    toolCalls: cloneToolCalls(currentTurnToolCalls),
    timeline: cloneTimeline(currentTurnTimeline)
  };
}

function hasVisibleTurnContent(snapshot) {
  if (!snapshot) return false;
  if (Array.isArray(snapshot.timeline) && snapshot.timeline.length > 0) return true;
  if (Array.isArray(snapshot.toolCalls) && snapshot.toolCalls.length > 0) return true;
  return typeof snapshot.fullResponse === 'string' && snapshot.fullResponse.trim().length > 0;
}

function getTTSEnabledClients(targetClient = null) {
  if (targetClient) {
    return targetClient.readyState === 1 && targetClient.ttsEnabled !== false ? [targetClient] : [];
  }
  const clients = [];
  for (const client of connectedClients) {
    if (client.readyState === 1 && client.ttsEnabled !== false) {
      clients.push(client);
    }
  }
  return clients;
}

function buildTTSTargetSet(targetClient = null) {
  return new Set(getTTSEnabledClients(targetClient));
}

function sendJsonToClients(clients, payload) {
  const json = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(json);
    }
  }
}

function sendBinaryToClients(clients, buffer) {
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(buffer);
    }
  }
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '').trim()));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

function execFileDetailed(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30 * 60 * 1000
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? (error.message || 'command failed') : ''
      });
      });
  });
}

function execFileStreamed(command, args, onLine, options = {}) {
  const { signal } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      encoding: 'utf8'
    });

    let stdout = '';
    let stderr = '';

    const stdoutInterface = createInterface({ input: child.stdout });
    const stderrInterface = createInterface({ input: child.stderr });

    let wasAborted = false;

    function handleLine(raw, stream) {
      const trimmed = String(raw || '').replace(/\r$/, '').trimEnd();
      if (!trimmed) return;
      if (stream === 'stderr') {
        stderr += `${trimmed}\n`;
      } else {
        stdout += `${trimmed}\n`;
      }
      if (typeof onLine === 'function') {
        onLine({ stream, line: trimmed });
      }
    }

    function onAbort() {
      wasAborted = true;
      if (child.pid) {
        child.kill('SIGTERM');
      }
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    stdoutInterface.on('line', (line) => {
      handleLine(line, 'stdout');
    });

    stderrInterface.on('line', (line) => {
      handleLine(line, 'stderr');
    });

    child.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve({
        ok: false,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: error.message || 'command failed to start'
      });
    });

    child.on('close', (code) => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (signal?.aborted) {
        wasAborted = true;
      }
      resolve({
        ok: !wasAborted && code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: code === 0 && !wasAborted
          ? ''
          : (wasAborted ? 'Update cancelled' : (stderr.trim() || `Command exited with code ${code}`))
      });
    });
  });
}

function getHostFromVmName(vmName) {
  return `${vmName}.exe.xyz`;
}

function isValidVmName(vmName) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(vmName || '').trim().toLowerCase());
}

function createVmUpdateRun(runId, mode, metadata = {}) {
  const run = {
    runId,
    mode,
    cancelled: false,
    metadata,
    controllers: new Set()
  };
  activeVmUpdateRuns.set(runId, run);
  return run;
}

function getVmUpdateRun(runId) {
  return activeVmUpdateRuns.get(runId);
}

function finalizeVmUpdateRun(runId) {
  const run = activeVmUpdateRuns.get(runId);
  if (!run) return;
  if (run.controllers.size > 0) {
    for (const controller of run.controllers) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }
  activeVmUpdateRuns.delete(runId);
}

function cancelVmUpdateRun(runId) {
  const run = getVmUpdateRun(runId);
  if (!run || run.cancelled) return false;
  run.cancelled = true;
  if (run.controllers.size > 0) {
    for (const controller of run.controllers) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }
  return true;
}

function runVmSetupOnHost(hostname, onLine, runId) {
  const run = getVmUpdateRun(runId);
  if (!run) {
    return Promise.resolve({ ok: false, error: 'Update run not found' });
  }
  const controller = new AbortController();
  run.controllers.add(controller);
  return execFileStreamed('node', [join(__dirname, '../bin/vm-setup.js'), hostname], onLine, { signal: controller.signal })
    .finally(() => {
      run.controllers.delete(controller);
    })
    .then((result) => ({
      success: result.ok,
      error: result.ok ? '' : (result.error || 'update failed'),
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    }));
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function runVmAuthSyncOnHost(hostname, onLine, runId) {
  const run = getVmUpdateRun(runId);
  if (!run) {
    return Promise.resolve({ ok: false, error: 'Update run not found' });
  }

  const localHome = homedir();
  const controller = new AbortController();
  run.controllers.add(controller);

  const script = `
set -euo pipefail
HOST=${shellQuote(hostname)}
LOCAL_HOME=${shellQuote(localHome)}
SSH_OPTS=(-o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
SCP_FILE_TIMEOUT=10
SCP_DIR_TIMEOUT=30
SSH_CMD_TIMEOUT=5
GH_STATUS_TIMEOUT=5

copy_file_if_exists() {
  local src="$1"
  local dest="$2"
  if [ -f "$src" ]; then
    echo "copy:file $src -> $dest"
    timeout "$SCP_FILE_TIMEOUT" scp "\${SSH_OPTS[@]}" "$src" "$HOST:$dest"
  else
    echo "skip:file-missing $src"
  fi
}

echo "prepare:remote-dirs"
timeout "$SSH_CMD_TIMEOUT" ssh "\${SSH_OPTS[@]}" "$HOST" 'mkdir -p ~/.claude ~/.codex ~/.config/gh'

copy_file_if_exists "$LOCAL_HOME/.claude.json" "~/.claude.json"
copy_file_if_exists "$LOCAL_HOME/.claude/.credentials.json" "~/.claude/.credentials.json"

if [ -d "$LOCAL_HOME/.codex" ]; then
  echo "copy:dir $LOCAL_HOME/.codex -> ~/.codex/"
  timeout "$SCP_DIR_TIMEOUT" scp -r "\${SSH_OPTS[@]}" "$LOCAL_HOME/.codex/." "$HOST:~/.codex/"
else
  echo "skip:dir-missing $LOCAL_HOME/.codex"
fi

if [ -f "$LOCAL_HOME/.config/gh/hosts.yml" ]; then
  echo "copy:file $LOCAL_HOME/.config/gh/hosts.yml -> ~/.config/gh/hosts.yml"
  timeout "$SCP_FILE_TIMEOUT" scp "\${SSH_OPTS[@]}" "$LOCAL_HOME/.config/gh/hosts.yml" "$HOST:~/.config/gh/hosts.yml"
elif command -v gh >/dev/null 2>&1 && timeout "$GH_STATUS_TIMEOUT" gh auth status >/dev/null 2>&1 && [ -f "$LOCAL_HOME/.local/share/gh/hosts.yml" ]; then
  echo "copy:file $LOCAL_HOME/.local/share/gh/hosts.yml -> ~/.config/gh/hosts.yml"
  timeout "$SCP_FILE_TIMEOUT" scp "\${SSH_OPTS[@]}" "$LOCAL_HOME/.local/share/gh/hosts.yml" "$HOST:~/.config/gh/hosts.yml"
else
  echo "skip:github-token-not-found"
fi

copy_file_if_exists "$LOCAL_HOME/.gitconfig" "~/.gitconfig"
copy_file_if_exists "$LOCAL_HOME/.git-credentials" "~/.git-credentials"

echo "done:auth-sync"
`;

  return execFileStreamed('bash', ['-lc', script], onLine, { signal: controller.signal })
    .finally(() => {
      run.controllers.delete(controller);
    })
    .then((result) => ({
      success: result.ok,
      error: result.ok ? '' : (result.error || 'auth update failed'),
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    }));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listVmSessions() {
  const rawList = await execFileAsync('ssh', ['exe.dev', 'ls']);
  const vmNames = parseVmNamesFromExeList(rawList);
  return mapWithConcurrency(vmNames, 1, async (name) => {
    const url = `https://${name}.exe.xyz:${PORT}/`;
    const hasVoiceTerminal = await vmHasVoiceTerminal(`${name}.exe.xyz`);
    return { name, url, hasVoiceTerminal };
  });
}

function buildVmUpdateSessionsPayload(sessions, updateByName) {
  return sessions.map((session) => ({
    ...session,
    update: session.hasVoiceTerminal ? (updateByName?.[session.name] || null) : null
  }));
}

const HIDDEN_SESSIONS = new Set(['voice-terminal', 'claude-code-sdk']);

async function listTmuxSessions() {
  const output = await execFileAsync('tmux', ['list-sessions']);
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      const name = colon > 0 ? line.slice(0, colon) : line;
      return { name, label: line };
    })
    .filter((s) => !HIDDEN_SESSIONS.has(s.name));
}

function buildSessionName(kind) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const prefix = kind === 'codex' ? 'codex' : 'claude';
  return `${prefix}-${stamp}`;
}

async function createTmuxSession(kind) {
  const safeKind = kind === 'codex' ? 'codex' : 'claude';
  const sessionName = buildSessionName(safeKind);
  const command = safeKind === 'codex'
    ? 'codex --sandbox danger-full-access --ask-for-approval never'
    : 'claude --dangerously-skip-permissions --model claude-opus-4-7';
  await execFileAsync('tmux', ['new-session', '-d', '-s', sessionName, '-c', process.env.HOME, command]);
  return { name: sessionName, kind: safeKind, command };
}

function appendTurnTimeline(event) {
  const last = currentTurnTimeline[currentTurnTimeline.length - 1];
  if (event.type === 'text' && last?.type === 'text') {
    last.text = `${last.text || ''}${event.text || ''}`;
    last.seq = event.seq ?? last.seq;
    return;
  }
  currentTurnTimeline.push(event);
}

function extractSpokenSummary(response) {
  const matches = [...response.matchAll(/\[SPOKEN:\s*([\s\S]*?)\]/gi)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  const paragraphs = response.trim().split('\n\n');
  return paragraphs[paragraphs.length - 1].slice(0, 500);
}

function broadcastToClients(message) {
  const json = JSON.stringify(message);
  for (const client of connectedClients) {
    if (client.readyState === 1) {
      client.send(json);
    }
  }
}

function broadcastSessionStatus(targetClient = null) {
  const payload = {
    type: 'session-status',
    running: sessionReady,
    hasProcess: !!orchestrator,
    orchestrator: activeOrchestratorKind,
    supportedOrchestrators: SUPPORTED_ORCHESTRATORS
  };

  if (targetClient) {
    if (targetClient.readyState === 1) targetClient.send(JSON.stringify(payload));
    return;
  }
  broadcastToClients(payload);
}

function sendTTSEnabledState(client, source = 'server') {
  if (!client || client.readyState !== 1) return;
  client.send(JSON.stringify({
    type: 'tts-enabled-state',
    enabled: client.ttsEnabled !== false,
    source
  }));
}

function switchActiveSession(sessionName, source = 'api') {
  const normalized = String(sessionName || '').trim();
  activeTmuxSessionName = normalized;
  broadcastToClients({
    type: 'active-tmux-session-changed',
    sessionName: activeTmuxSessionName,
    source
  });
  return { success: true, sessionName: activeTmuxSessionName };
}

function parseControlToolCalls(text) {
  if (typeof text !== 'string' || !text) return { cleaned: '', calls: [] };
  const calls = [];

  const lines = text.split('\n');
  const kept = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      kept.push(rawLine);
      continue;
    }

    // Accept common model formatting wrappers for standalone control calls:
    // - bullets: "- switchActiveSession(...)"
    // - inline code: "`switchActiveSession(...)`"
    // - trailing semicolon / period
    let candidate = trimmed.replace(/^[-*+]\s+/, '');
    if (candidate.startsWith('`') && candidate.endsWith('`') && candidate.length >= 2) {
      candidate = candidate.slice(1, -1).trim();
    }
    candidate = candidate.replace(/[;.]$/, '').trim();

    const match = candidate.match(/^switchActiveSession\(\s*(['"])(.*?)\1\s*\)$/);
    if (match) {
      calls.push({
        toolName: 'switchActiveSession',
        input: { sessionName: String(match[2] || '').trim() }
      });
      continue;
    }

    kept.push(rawLine);
  }

  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { cleaned, calls };
}

function applyTmuxSessionContext(transcript) {
  const text = String(transcript || '');
  let contextLines = [];

  // Include current session list from cached status
  try {
    const parsed = lastTmuxStatusJson ? JSON.parse(lastTmuxStatusJson) : null;
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    if (sessions.length > 0) {
      const sessionList = sessions.map((s) => {
        const marker = s.session === activeTmuxSessionName ? ' (active)' : '';
        return `- ${s.session} [${s.state}]${marker}`;
      }).join('\n');
      contextLines.push(`Available tmux sessions:\n${sessionList}`);
    }
  } catch (_) { /* ignore parse errors */ }

  if (activeTmuxSessionName) {
    contextLines.push(`this speech command is intended for use with tmux session ${activeTmuxSessionName}`);
  }

  if (contextLines.length === 0) return text;
  return `${contextLines.join('\n\n')}\n\n${text}`;
}

function resetTurnTracking() {
  responseBuffer = '';
  currentTurnToolCalls = [];
  currentTurnTimeline = [];
  currentTurnSeq = 0;
  inFlightTurn = null;
  cancelledTurn = false;
}

function resetConversationState() {
  conversationHistory = [];
  currentTurnToolCalls = [];
  currentTurnTimeline = [];
  currentTurnSeq = 0;
  inFlightTurn = null;
  nextMessageId = 1;
  responseBuffer = '';
  cancelledTurn = false;
}

function handleOrchestratorEvent(event) {
  if (!event || typeof event !== 'object') return;
  const type = event.type;

  currentTurnEvents.push(event);

  if (type === 'session-init') {
    sessionMetadata = {
      ...sessionMetadata,
      model: event.model || sessionMetadata.model,
      tools: event.tools || sessionMetadata.tools,
      sessionId: event.sessionId || sessionMetadata.sessionId,
      version: event.version || sessionMetadata.version,
      orchestrator: activeOrchestratorKind
    };
    sessionReady = true;

    if (!sessionInitialized) {
      sessionInitialized = true;
      broadcastToClients({
        type: 'session-init',
        model: sessionMetadata.model,
        version: sessionMetadata.version,
        orchestrator: activeOrchestratorKind
      });
    } else {
      broadcastToClients({
        type: 'session-reinit',
        model: sessionMetadata.model,
        version: sessionMetadata.version,
        orchestrator: activeOrchestratorKind
      });
    }
    broadcastSessionStatus();
    return;
  }

  if (type === 'partial') {
    if (cancelledTurn) return;
    const text = String(event.text || '');
    if (!text) return;

    responseBuffer += text;
    const timelineEvent = {
      type: 'text',
      seq: ++currentTurnSeq,
      text
    };
    appendTurnTimeline(timelineEvent);

    if (inFlightTurn) {
      inFlightTurn.partialText += text;
      const timelineLast = inFlightTurn.timeline[inFlightTurn.timeline.length - 1];
      if (timelineLast?.type === 'text') {
        timelineLast.text = `${timelineLast.text || ''}${text}`;
        timelineLast.seq = timelineEvent.seq;
      } else {
        inFlightTurn.timeline.push({ ...timelineEvent });
      }
    }

    broadcastToClients({ type: 'partial', seq: timelineEvent.seq, text });
    return;
  }

  if (type === 'tool-call') {
    if (cancelledTurn) return;
    const timelineEvent = {
      type: 'tool',
      seq: ++currentTurnSeq,
      toolName: event.toolName,
      input: event.input
    };
    currentTurnToolCalls.push({ toolName: event.toolName, input: event.input });
    appendTurnTimeline(timelineEvent);

    if (inFlightTurn) {
      inFlightTurn.toolCalls.push({ toolName: event.toolName, input: event.input });
      inFlightTurn.timeline.push(timelineEvent);
    }

    broadcastToClients({
      type: 'tool-call',
      seq: timelineEvent.seq,
      toolName: event.toolName,
      toolId: event.toolId,
      input: event.input
    });
    return;
  }

  if (type === 'response') {
    const wasCancelled = cancelledTurn;
    cancelledTurn = false;
    currentTurnEvents = [];

    if (wasCancelled) {
      responseBuffer = '';
      currentTurnToolCalls = [];
      currentTurnTimeline = [];
      currentTurnSeq = 0;
      inFlightTurn = null;
      return;
    }

    const rawResponse = typeof event.fullResponse === 'string' ? event.fullResponse : responseBuffer;
    const parsedControlCalls = parseControlToolCalls(rawResponse);
    if (parsedControlCalls.calls.length > 0) {
      for (const call of parsedControlCalls.calls) {
        const timelineEvent = {
          type: 'tool',
          seq: ++currentTurnSeq,
          toolName: call.toolName,
          input: call.input
        };
        currentTurnToolCalls.push({ toolName: call.toolName, input: call.input });
        appendTurnTimeline(timelineEvent);

        if (inFlightTurn) {
          inFlightTurn.toolCalls.push({ toolName: call.toolName, input: call.input });
          inFlightTurn.timeline.push(timelineEvent);
        }

        broadcastToClients({
          type: 'tool-call',
          seq: timelineEvent.seq,
          toolName: timelineEvent.toolName,
          input: timelineEvent.input
        });

        if (call.toolName === 'switchActiveSession') {
          switchActiveSession(call.input?.sessionName || '', 'orchestrator-tool');
        }
      }
    }

    const fullResponse = parsedControlCalls.cleaned;
    responseBuffer = '';
    const spokenSummary = extractSpokenSummary(fullResponse);

    const metadata = {
      ...(event.metadata || {}),
      model: sessionMetadata.model || event.model,
      orchestrator: activeOrchestratorKind
    };

    const assistantMessage = {
      id: nextMessageId++,
      type: 'assistant',
      content: fullResponse,
      spokenSummary,
      toolCalls: currentTurnToolCalls,
      timeline: currentTurnTimeline,
      spokenDelivered: !spokenSummary,
      metadata,
      timestamp: Date.now()
    };
    conversationHistory.push(assistantMessage);
    currentTurnToolCalls = [];
    currentTurnTimeline = [];
    currentTurnSeq = 0;
    inFlightTurn = null;

    let ttsSkipReason = null;
    if (!spokenSummary) {
      ttsSkipReason = 'no-spoken-summary';
    } else if (!isTTSReady()) {
      ttsSkipReason = 'tts-not-ready';
    } else if (getTTSEnabledClients().length === 0) {
      ttsSkipReason = 'no-tts-enabled-clients';
    }
    const ttsScheduled = ttsSkipReason == null;

    broadcastToClients({
      type: 'response',
      fullResponse,
      spokenSummary,
      ttsScheduled,
      ttsSkipReason,
      toolCalls: assistantMessage.toolCalls,
      timeline: assistantMessage.timeline,
      model: sessionMetadata.model,
      orchestrator: activeOrchestratorKind,
      metadata
    });

    if (ttsScheduled) {
      synthesizeAndBroadcastAudio(spokenSummary, assistantMessage.id);
    }
    return;
  }

  if (type === 'error') {
    broadcastToClients({
      type: 'error',
      message: event.message || 'Unknown error',
      orchestrator: activeOrchestratorKind
    });
    return;
  }

  if (type === 'session-ended') {
    sessionReady = false;
    sessionInitialized = false;
    broadcastToClients({
      type: 'session-ended',
      code: event.code,
      orchestrator: activeOrchestratorKind
    });
    broadcastSessionStatus();
  }
}

function createClaudeAdapter(emit, modelName) {
  let claudeProcess = null;
  let ready = false;

  function start() {
    if (claudeProcess) {
      return;
    }

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--append-system-prompt-file', systemPromptPath,
      '--dangerously-skip-permissions'
    ];
    if (modelName && modelName !== 'claude-code') {
      args.push('--model', modelName);
    }

    const projectBinDir = join(__dirname, '..');

    const processRef = spawn('claude', args, {
      cwd: process.env.HOME,
      env: {
        ...process.env,
        PATH: `${projectBinDir}:${process.env.PATH || ''}`
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    claudeProcess = processRef;

    const rl = createInterface({ input: processRef.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.type === 'system' && msg.subtype === 'init') {
        emit({
          type: 'session-init',
          model: msg.model,
          tools: msg.tools,
          sessionId: msg.session_id,
          version: msg.claude_code_version
        });
        return;
      }

      if (msg.type === 'assistant') {
        const content = msg?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use') {
              emit({
                type: 'tool-call',
                toolName: block.name,
                toolId: block.id,
                input: block.input
              });
            }
          }
        }
        return;
      }

      if (msg.type === 'stream_event') {
        const event = msg?.event;
        if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
          emit({ type: 'partial', text: event.delta.text || '' });
        }
        return;
      }

      if (msg.type === 'result') {
        emit({
          type: 'response',
          metadata: {
            durationMs: msg.duration_ms,
            durationApiMs: msg.duration_api_ms,
            numTurns: msg.num_turns,
            totalCostUsd: msg.total_cost_usd,
            usage: msg.usage,
            modelUsage: msg.modelUsage,
            isError: msg.is_error
          }
        });
        return;
      }

      if (msg.type === 'error') {
        emit({ type: 'error', message: msg.error?.message || msg.message || 'Unknown Claude error' });
      }
    });

    processRef.stderr.on('data', (data) => {
      console.log('Claude stderr:', data.toString());
    });

    processRef.on('close', (code) => {
      if (claudeProcess !== processRef) return;
      claudeProcess = null;
      ready = false;
      emit({ type: 'session-ended', code });
    });

    processRef.on('error', (err) => {
      if (claudeProcess !== processRef) return;
      claudeProcess = null;
      ready = false;
      emit({ type: 'error', message: `Claude process error: ${err.message}` });
    });

    try {
      const initMessage = {
        type: 'control_request',
        request_id: `init-${Date.now()}`,
        request: { subtype: 'initialize' }
      };
      processRef.stdin.write(`${JSON.stringify(initMessage)}\n`);
    } catch (err) {
      emit({ type: 'error', message: `Failed to initialize Claude stream: ${err.message}` });
    }

    ready = true;
  }

  function stop() {
    if (!claudeProcess) {
      ready = false;
      return;
    }
    claudeProcess.kill('SIGTERM');
    claudeProcess = null;
    ready = false;
  }

  function sendUserMessage(userMessage) {
    if (!claudeProcess || !ready) {
      return { error: 'Claude session not running' };
    }

    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: userMessage
      }
    };

    try {
      claudeProcess.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      return { error: `Failed to send message to Claude: ${err.message}` };
    }

    return { success: true };
  }

  function cancel() {
    if (!claudeProcess || !ready) {
      return { terminated: false };
    }

    const interruptMessage = {
      type: 'control_request',
      request_id: `interrupt-${Date.now()}`,
      request: { subtype: 'interrupt' }
    };

    try {
      claudeProcess.stdin.write(`${JSON.stringify(interruptMessage)}\n`);
      return { terminated: true };
    } catch (err) {
      console.warn(`Failed to send Claude interrupt control request: ${err.message}`);
    }

    try {
      claudeProcess.kill('SIGINT');
      return { terminated: true };
    } catch (err) {
      console.warn(`Failed to send SIGINT to Claude process: ${err.message}`);
    }

    return { terminated: false };
  }

  function isReady() {
    return !!claudeProcess && ready;
  }

  return {
    kind: 'claude',
    start,
    stop,
    sendUserMessage,
    cancel,
    isReady
  };
}

function createCodexAdapter(emit) {
  let ready = false;
  let activeProcess = null;
  let lastStartedThreadId = null;
  let hasSessionHistory = false;

  function parseCodexItem(item) {
    if (!item || typeof item !== 'object') return;
    const type = item.type;

    if (type === 'agent_message' || type === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) emit({ type: 'partial', text });
      return;
    }

    if (type === 'command_execution' || type === 'commandExecution') {
      emit({
        type: 'tool-call',
        toolName: 'exec_command',
        toolId: item.id,
        input: {
          command: item.command,
          cwd: item.cwd,
          status: item.status
        }
      });
      return;
    }

    if (type === 'file_change' || type === 'fileChange') {
      emit({
        type: 'tool-call',
        toolName: 'apply_patch',
        toolId: item.id,
        input: {
          status: item.status,
          changes: item.changes
        }
      });
    }
  }

  function start() {
    if (ready) return;
    lastStartedThreadId = null;
    hasSessionHistory = false;
    ready = true;
    emit({
      type: 'session-init',
      model: ORCHESTRATOR_CONFIG.codex.defaultModel,
      version: 'codex-exec-json'
    });
  }

  function stop() {
    ready = false;
    lastStartedThreadId = null;
    hasSessionHistory = false;
    if (activeProcess) {
      activeProcess.kill('SIGTERM');
      activeProcess = null;
    }
  }

  function sendUserMessage(userMessage) {
    if (!ready) {
      return { error: 'Codex session not running' };
    }
    if (activeProcess) {
      return { error: 'Codex is still processing the previous request' };
    }

    const args = [
      '--dangerously-bypass-approvals-and-sandbox',
      '--config', `model_instructions_file="${systemPromptPath}"`,
      'exec'
    ];

    if (hasSessionHistory) {
      args.push('resume', '--last');
    }

    args.push(
      '--json',
      '--skip-git-repo-check',
      '--model', ORCHESTRATOR_CONFIG.codex.defaultModel,
      userMessage
    );

    const processRef = spawn('codex', args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeProcess = processRef;

    const rl = createInterface({ input: processRef.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.type === 'thread.started') {
        lastStartedThreadId = msg.thread_id;
        hasSessionHistory = true;
        if (!sessionInitialized) {
          emit({
            type: 'session-init',
            model: ORCHESTRATOR_CONFIG.codex.defaultModel,
            sessionId: msg.thread_id,
            version: 'codex-exec-json'
          });
        }
        return;
      }

      if (msg.type === 'item.completed') {
        parseCodexItem(msg.item);
        return;
      }

      if (msg.type === 'item.started') {
        parseCodexItem(msg.item);
        return;
      }

      if (msg.type === 'error') {
        emit({ type: 'error', message: msg.message || msg.error?.message || 'Codex execution error' });
      }

      if (msg.type === 'turn.completed') {
        emit({
          type: 'response',
          metadata: {
            usage: msg.usage || null,
            threadId: lastStartedThreadId,
            model: ORCHESTRATOR_CONFIG.codex.defaultModel
          }
        });
      }
    });

    processRef.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return;
      console.log('Codex stderr:', text);
    });

    processRef.on('error', (err) => {
      if (activeProcess !== processRef) return;
      activeProcess = null;
      emit({ type: 'error', message: `Codex process error: ${err.message}` });
    });

    processRef.on('close', (code) => {
      if (activeProcess !== processRef) return;
      activeProcess = null;
      if (code !== 0) {
        emit({ type: 'error', message: `Codex exited with code ${code}` });
      }
    });

    return { success: true };
  }

  function cancel() {
    if (!activeProcess) return { terminated: false };
    activeProcess.kill('SIGTERM');
    activeProcess = null;
    return { terminated: true };
  }

  function isReady() {
    return ready;
  }

  return {
    kind: 'codex',
    start,
    stop,
    sendUserMessage,
    cancel,
    isReady
  };
}

function createOrchestrator(kind, emit) {
  const normalized = normalizeOrchestratorKind(kind);
  if (normalized === 'codex') {
    return createCodexAdapter(emit);
  }
  return createClaudeAdapter(emit, ORCHESTRATOR_CONFIG[normalized].defaultModel);
}

function setActiveOrchestrator(kind) {
  const next = normalizeOrchestratorKind(kind);
  activeOrchestratorKind = next;
  orchestrator = createOrchestrator(next, handleOrchestratorEvent);
  sessionReady = false;
  sessionInitialized = false;
  sessionMetadata = { orchestrator: next, model: ORCHESTRATOR_CONFIG[next].defaultModel };
}

function startSession() {
  if (!orchestrator) {
    setActiveOrchestrator(activeOrchestratorKind);
  }
  if (orchestrator?.isReady()) {
    sessionReady = true;
    return;
  }

  resetConversationState();
  orchestrator.start();
  sessionReady = orchestrator.isReady();
}

function stopSession() {
  stopAllTTSStreams('session-stopped');
  if (orchestrator) {
    orchestrator.stop();
  }
  sessionReady = false;
  sessionInitialized = false;
  resetConversationState();
}

function restartSession() {
  stopSession();
  startSession();
}

function switchOrchestrator(kind) {
  const next = normalizeOrchestratorKind(kind);
  if (next === activeOrchestratorKind && orchestrator?.isReady()) {
    return { success: true, orchestrator: activeOrchestratorKind };
  }

  if (orchestrator) {
    stopAllTTSStreams('orchestrator-switched');
    orchestrator.stop();
  }
  resetConversationState();
  setActiveOrchestrator(next);
  orchestrator.start();
  sessionReady = orchestrator.isReady();

  broadcastToClients({
    type: 'orchestrator-changed',
    orchestrator: activeOrchestratorKind,
    label: orchestratorLabel(activeOrchestratorKind)
  });
  broadcastSessionStatus();

  return { success: true, orchestrator: activeOrchestratorKind };
}

function sendToOrchestrator(userMessage) {
  if (!orchestrator || !orchestrator.isReady()) {
    return { error: `${orchestratorLabel(activeOrchestratorKind)} session not running` };
  }
  if (inFlightTurn) {
    return { error: `${orchestratorLabel(activeOrchestratorKind)} is still processing the previous request` };
  }

  cancelledTurn = false;
  responseBuffer = '';
  currentTurnToolCalls = [];
  currentTurnTimeline = [];
  currentTurnSeq = 0;
  inFlightTurn = {
    userMessage,
    startedAt: Date.now(),
    partialText: '',
    toolCalls: [],
    timeline: []
  };

  const result = orchestrator.sendUserMessage(userMessage);
  if (result?.error) {
    inFlightTurn = null;
    return result;
  }
  return { success: true };
}

function dispatchUserMessage(userMessage) {
  const content = String(userMessage || '').trim();
  if (!content) {
    return { error: 'Missing message content' };
  }

  conversationHistory.push({
    id: nextMessageId++,
    type: 'user',
    content,
    timestamp: Date.now()
  });

  const result = sendToOrchestrator(content);
  if (result?.error) {
    conversationHistory.pop();
    return result;
  }

  return { success: true };
}

function interruptSession() {
  if (!orchestrator || !orchestrator.isReady()) {
    return { success: false };
  }

  let cancelledSnapshot = null;
  if (inFlightTurn && !inFlightTurn.cancelledSnapshotSaved) {
    const snapshot = snapshotCurrentTurn();
    if (hasVisibleTurnContent(snapshot)) {
      const assistantMessage = {
        id: nextMessageId++,
        type: 'assistant',
        content: snapshot.fullResponse,
        spokenSummary: '',
        toolCalls: snapshot.toolCalls,
        timeline: snapshot.timeline,
        spokenDelivered: true,
        metadata: {
          interrupted: true,
          cancelled: true,
          partial: true,
          orchestrator: activeOrchestratorKind
        },
        timestamp: Date.now()
      };
      conversationHistory.push(assistantMessage);
      cancelledSnapshot = {
        fullResponse: assistantMessage.content,
        toolCalls: assistantMessage.toolCalls,
        timeline: assistantMessage.timeline
      };
      inFlightTurn.cancelledSnapshotSaved = true;
      inFlightTurn.cancelled = true;
    }
  }

  const cancelResult = orchestrator.cancel();
  if (cancelResult?.terminated) {
    resetTurnTracking();
    return { success: true, cancelledSnapshot };
  }

  cancelledTurn = true;
  responseBuffer = '';
  currentTurnToolCalls = [];
  currentTurnTimeline = [];
  currentTurnSeq = 0;
  if (inFlightTurn) inFlightTurn.cancelled = true;

  return { success: true, cancelledSnapshot };
}

function cleanupTTSStream(requestId) {
  const active = activeTTSStreams.get(requestId);
  if (!active) return null;
  activeTTSStreams.delete(requestId);
  return active;
}

function markMessageSpeechDelivered(messageId) {
  if (messageId == null) return;
  const msg = conversationHistory.find((entry) => entry.id === messageId);
  if (msg) {
    msg.spokenDelivered = true;
  }
}

function parseMultipartForm(req) {
  const form = formidable({
    multiples: false,
    uploadDir: tmpdir(),
    keepExtensions: true,
    maxFileSize: MAX_UPLOAD_BYTES,
    maxTotalFileSize: MAX_UPLOAD_BYTES
  });

  return form.parse(req);
}

function parseVmNamesFromExeList(rawOutput) {
  const text = String(rawOutput || '');
  const names = new Set();

  const fqdnRegex = /([a-z0-9][a-z0-9-]*)\.exe\.xyz\b/gi;
  let match;
  while ((match = fqdnRegex.exec(text)) !== null) {
    if (match[1]) names.add(match[1].toLowerCase());
  }

  if (names.size > 0) return [...names];

  const blocked = new Set(['your', 'vms', 'name', 'status', 'image', 'running', 'stopped']);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstCol = trimmed.split(/\s+/)[0] || '';
    const normalized = firstCol.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!normalized || blocked.has(normalized)) continue;
    if (/^[a-z0-9][a-z0-9-]*$/.test(normalized)) names.add(normalized);
  }

  return [...names];
}

async function vmHasVoiceTerminal(hostname) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await execFileAsync('ssh', [
        '-o', 'ConnectTimeout=5',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        hostname,
        'test -d ~/voice-terminal && test -f ~/voice-terminal/package.json && echo yes || echo no'
      ]);
      return String(output).split('\n').some((line) => line.trim().toLowerCase() === 'yes');
    } catch {
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  return null;
}

async function readVmUpdateStatus(hostname) {
  try {
    const statusCommand = `cd ~/voice-terminal >/dev/null 2>&1 || { echo "ERROR:missing-repo"; exit 0; }
if pgrep -f "node src/server.js|node --watch src/server.js|npm run dev" >/dev/null 2>&1; then echo "SERVER:running"; else echo "SERVER:down"; fi
git fetch --quiet origin >/dev/null 2>&1 || true
LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
UPSTREAM=$(git rev-parse @{u} 2>/dev/null || echo "")
if [ -z "$UPSTREAM" ]; then UPSTREAM=$(git rev-parse origin/HEAD 2>/dev/null || echo ""); fi
if [ -z "$LOCAL" ] || [ -z "$UPSTREAM" ]; then
  echo "GIT:unknown"
  echo "AHEAD:0"
  echo "BEHIND:0"
else
  AHEAD=$(git rev-list --count "$UPSTREAM..$LOCAL" 2>/dev/null || echo "0")
  BEHIND=$(git rev-list --count "$LOCAL..$UPSTREAM" 2>/dev/null || echo "0")
  if [ "$AHEAD" = "0" ] && [ "$BEHIND" = "0" ]; then STATE="up-to-date";
  elif [ "$AHEAD" = "0" ]; then STATE="behind";
  elif [ "$BEHIND" = "0" ]; then STATE="ahead";
  else STATE="diverged"; fi
  echo "GIT:$STATE"
  echo "AHEAD:$AHEAD"
  echo "BEHIND:$BEHIND"
fi
if [ -s models/piper/en_US-lessac-medium.onnx ]; then echo "TTS_MODEL:ok"; else echo "TTS_MODEL:missing"; fi
if [ -s models/piper/en_US-lessac-medium.onnx.json ]; then echo "TTS_CONFIG:ok"; else echo "TTS_CONFIG:missing"; fi
if [ -x .venv/bin/piper ]; then echo "TTS_PIPER_BIN:ok"; else echo "TTS_PIPER_BIN:missing"; fi
if [ -x .venv/bin/python ]; then
  IMPORT_STATUS=$(.venv/bin/python - <<'PY'
import importlib.util
mods=["piper", "pathvalidate", "onnxruntime"]
missing=[m for m in mods if importlib.util.find_spec(m) is None]
print("ok" if not missing else "missing:" + ",".join(missing))
PY
)
  echo "TTS_IMPORT:$IMPORT_STATUS"
else
  echo "TTS_IMPORT:missing-python"
fi
if [ -x .venv/bin/piper ]; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 .venv/bin/piper --help >/dev/null 2>&1 && echo "TTS_CLI:ok" || echo "TTS_CLI:fail"
  else
    .venv/bin/piper --help >/dev/null 2>&1 && echo "TTS_CLI:ok" || echo "TTS_CLI:fail"
  fi
else
  echo "TTS_CLI:missing"
fi`;

    const output = await execFileAsync('ssh', [
      '-o',
      'ConnectTimeout=5',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      hostname,
      statusCommand
    ]);

    const result = {
      serverRunning: false,
      gitState: 'unknown',
      aheadCount: 0,
      behindCount: 0,
      error: '',
      ttsHealthy: false,
      ttsIssue: '',
      ttsChecks: {
        model: false,
        config: false,
        piperBin: false,
        importsOk: false,
        cliOk: false
      }
    };

    for (const line of String(output || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'SERVER:running') result.serverRunning = true;
      else if (trimmed === 'SERVER:down') result.serverRunning = false;
      else if (trimmed.startsWith('GIT:')) result.gitState = trimmed.slice(4).trim() || 'unknown';
      else if (trimmed.startsWith('AHEAD:')) result.aheadCount = Number(trimmed.slice(6).trim() || 0);
      else if (trimmed.startsWith('BEHIND:')) result.behindCount = Number(trimmed.slice(7).trim() || 0);
      else if (trimmed === 'TTS_MODEL:ok') result.ttsChecks.model = true;
      else if (trimmed === 'TTS_CONFIG:ok') result.ttsChecks.config = true;
      else if (trimmed === 'TTS_PIPER_BIN:ok') result.ttsChecks.piperBin = true;
      else if (trimmed === 'TTS_IMPORT:ok') result.ttsChecks.importsOk = true;
      else if (trimmed === 'TTS_CLI:ok') result.ttsChecks.cliOk = true;
      else if (trimmed.startsWith('TTS_IMPORT:') && trimmed !== 'TTS_IMPORT:ok') {
        result.ttsIssue = trimmed.slice('TTS_IMPORT:'.length).trim();
      }
      else if (trimmed.startsWith('ERROR:')) result.error = trimmed.slice(6).trim() || 'unknown error';
    }

    const ttsIssues = [];
    if (!result.ttsChecks.model) ttsIssues.push('model missing');
    if (!result.ttsChecks.config) ttsIssues.push('model config missing');
    if (!result.ttsChecks.piperBin) ttsIssues.push('piper binary missing');
    if (!result.ttsChecks.importsOk) {
      ttsIssues.push(result.ttsIssue ? `imports ${result.ttsIssue}` : 'python deps missing');
    }
    if (!result.ttsChecks.cliOk) ttsIssues.push('piper CLI check failed');
    result.ttsHealthy = ttsIssues.length === 0;
    result.ttsIssue = ttsIssues.join(', ');

    return result;
  } catch (err) {
    return {
      serverRunning: false,
      gitState: 'unknown',
      aheadCount: 0,
      behindCount: 0,
      error: err.message || 'ssh check failed',
      ttsHealthy: false,
      ttsIssue: 'health check failed',
      ttsChecks: {
        model: false,
        config: false,
        piperBin: false,
        importsOk: false,
        cliOk: false
      }
    };
  }
}

app.get('/api/vm-sessions', async (_req, res) => {
  try {
    const sessions = await listVmSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Failed to list VM sessions'
    });
  }
});

app.get('/api/vm-sessions/updates', async (_req, res) => {
  try {
    const sessions = await listVmSessions();

    const installed = sessions.filter((session) => session.hasVoiceTerminal === true);
    const checked = await Promise.all(installed.map(async (session) => ({
      name: session.name,
      update: await readVmUpdateStatus(`${session.name}.exe.xyz`)
    })));
    const updateByName = Object.fromEntries(checked.map((entry) => [entry.name, entry.update]));

    res.json(buildVmUpdateSessionsPayload(sessions, updateByName));
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Failed to check VM updates'
    });
  }
});

app.post('/api/vm-sessions/update-all', async (_req, res) => {
  const runId = String(_req?.query?.runId || _req?.body?.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const run = createVmUpdateRun(runId, 'all');

  try {
    const sessions = await listVmSessions();
    const installed = sessions.filter((session) => session.hasVoiceTerminal === true);
    const updated = [];
    const totalSessions = installed.length;
    run.metadata.totalSessions = totalSessions;
    run.metadata.completedSessions = 0;

    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'start',
      totalSessions,
      completedSessions: 0,
      message: `Starting update all run for ${totalSessions} VM(s) with Voice Boss.`
    });

    for (let index = 0; index < installed.length; index += 1) {
      const session = installed[index];
      run.metadata.currentSession = session.name;
      run.metadata.currentIndex = index + 1;

      if (run.cancelled) break;

      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'session-start',
        sessionName: session.name,
        totalSessions,
        currentIndex: index + 1,
        completedSessions: updated.length,
        message: `Starting update for ${session.name}`
      });

      const result = await runVmSetupOnHost(`${session.name}.exe.xyz`, (payload) => {
        broadcastToClients({
          type: 'vm-update-progress',
          runId,
          phase: 'session-log',
          sessionName: session.name,
          stream: payload.stream,
          line: payload.line
        });
      }, runId);

      updated.push({ name: session.name, result });
      run.metadata.completedSessions = updated.length;
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'session-complete',
        sessionName: session.name,
        totalSessions,
        currentIndex: index + 1,
        completedSessions: updated.length,
        message: result.success ? 'Update completed' : (result.error || 'Update failed'),
        success: !!result.success,
        error: result.success ? '' : (result.error || 'update failed')
      });

      if (run.cancelled) {
        break;
      }
    }

    if (run.cancelled) {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'cancelled',
        totalSessions,
        completedSessions: updated.length,
        currentSession: run.metadata.currentSession || '',
        message: `Update all cancelled after ${updated.length}/${totalSessions} VM(s).`
      });
    } else {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'complete',
        totalSessions,
        completedSessions: updated.length,
        message: `Update all complete for ${totalSessions} VM(s).`
      });
    }

    const resultByName = Object.fromEntries(updated.map((entry) => [entry.name, entry.result]));

    res.json(sessions.map((session) => ({
      ...session,
      updateAll: session.hasVoiceTerminal ? (resultByName[session.name] || null) : null
    })));
  } catch (err) {
    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'error',
      message: err.message || 'Failed to update VM sessions'
    });
    res.status(500).json({
      error: err.message || 'Failed to update VM sessions'
    });
  } finally {
    finalizeVmUpdateRun(runId);
  }
});

app.post('/api/vm-sessions/:vmName/update', async (_req, res) => {
  const vmName = String(_req?.params?.vmName || '').trim().toLowerCase();
  if (!isValidVmName(vmName)) {
    res.status(400).json({
      error: 'Invalid VM name'
    });
    return;
  }

  const runId = String(_req?.query?.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const run = createVmUpdateRun(runId, 'single', { vmName });

  try {
    const sessions = await listVmSessions();
    const session = sessions.find((entry) => entry.name === vmName);
    if (!session) {
      res.status(404).json({ error: 'VM not found' });
      return;
    }

    if (session.hasVoiceTerminal !== true) {
      res.status(409).json({
        error: 'Selected VM does not appear to be running Voice Terminal'
      });
      return;
    }

    run.metadata.totalSessions = 1;
    run.metadata.currentSession = vmName;
    run.metadata.currentIndex = 1;
    run.metadata.completedSessions = 0;

    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'start',
      totalSessions: 1,
      completedSessions: 0,
      message: `Starting update for ${vmName}`
    });

    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'session-start',
      sessionName: vmName,
      totalSessions: 1,
      currentIndex: 1,
      completedSessions: 0,
      message: `Starting update for ${vmName}`
    });

    const result = await runVmSetupOnHost(`${vmName}.exe.xyz`, (payload) => {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'session-log',
        sessionName: vmName,
        stream: payload.stream,
        line: payload.line
      });
    }, runId);

    run.metadata.completedSessions = 1;
    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'session-complete',
      sessionName: vmName,
      totalSessions: 1,
      currentIndex: 1,
      completedSessions: 1,
      message: result.success ? 'Update completed' : (result.error || 'Update failed'),
      success: !!result.success,
      error: result.success ? '' : (result.error || 'update failed')
    });

    if (run.cancelled) {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'cancelled',
        totalSessions: 1,
        completedSessions: 1,
        currentSession: vmName,
        message: `Update for ${vmName} was cancelled.`
      });
    } else {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'complete',
        totalSessions: 1,
        completedSessions: 1,
        currentSession: vmName,
        message: `Update complete for ${vmName}.`
      });
    }

    res.json({
      ...session,
      updateAll: result
    });
  } catch (err) {
    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'error',
      message: err.message || 'Failed to update VM session'
    });
    res.status(500).json({
      error: err.message || 'Failed to update VM session'
    });
  } finally {
    finalizeVmUpdateRun(runId);
  }
});

app.post('/api/vm-sessions/:vmName/update-auth', async (_req, res) => {
  const vmName = String(_req?.params?.vmName || '').trim().toLowerCase();
  if (!isValidVmName(vmName)) {
    res.status(400).json({
      error: 'Invalid VM name'
    });
    return;
  }

  const runId = String(_req?.query?.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const run = createVmUpdateRun(runId, 'auth', { vmName });

  try {
    const sessions = await listVmSessions();
    const session = sessions.find((entry) => entry.name === vmName);
    if (!session) {
      res.status(404).json({ error: 'VM not found' });
      return;
    }

    run.metadata.totalSessions = 1;
    run.metadata.currentSession = vmName;
    run.metadata.currentIndex = 1;
    run.metadata.completedSessions = 0;

    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'start',
      totalSessions: 1,
      completedSessions: 0,
      message: `Starting auth update for ${vmName}`
    });

    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'session-start',
      sessionName: vmName,
      totalSessions: 1,
      currentIndex: 1,
      completedSessions: 0,
      message: `Syncing auth files for ${vmName}`
    });

    const result = await runVmAuthSyncOnHost(`${vmName}.exe.xyz`, (payload) => {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'session-log',
        sessionName: vmName,
        stream: payload.stream,
        line: payload.line
      });
    }, runId);

    run.metadata.completedSessions = 1;
    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'session-complete',
      sessionName: vmName,
      totalSessions: 1,
      currentIndex: 1,
      completedSessions: 1,
      message: result.success ? 'Auth update completed' : (result.error || 'Auth update failed'),
      success: !!result.success,
      error: result.success ? '' : (result.error || 'auth update failed')
    });

    if (run.cancelled) {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'cancelled',
        totalSessions: 1,
        completedSessions: 1,
        currentSession: vmName,
        message: `Auth update for ${vmName} was cancelled.`
      });
    } else {
      broadcastToClients({
        type: 'vm-update-progress',
        runId,
        phase: 'complete',
        totalSessions: 1,
        completedSessions: 1,
        currentSession: vmName,
        message: `Auth update complete for ${vmName}.`
      });
    }

    res.json({
      ...session,
      updateAuth: result
    });
  } catch (err) {
    broadcastToClients({
      type: 'vm-update-progress',
      runId,
      phase: 'error',
      message: err.message || 'Failed to update VM auth'
    });
    res.status(500).json({
      error: err.message || 'Failed to update VM auth'
    });
  } finally {
    finalizeVmUpdateRun(runId);
  }
});

app.post('/api/vm-sessions/update/cancel', (_req, res) => {
  const runId = String(_req?.query?.runId || '').trim();
  if (!runId) {
    res.status(400).json({ error: 'runId is required' });
    return;
  }

  const run = getVmUpdateRun(runId);
  if (!run) {
    res.status(404).json({ error: 'No running VM update found for this runId' });
    return;
  }

  const cancelled = cancelVmUpdateRun(runId);
  if (!cancelled) {
    res.status(409).json({ error: 'VM update already cancelled' });
    return;
  }

  broadcastToClients({
    type: 'vm-update-progress',
    runId,
    phase: 'cancelled',
    totalSessions: run.metadata?.totalSessions || 0,
    completedSessions: run.metadata?.completedSessions || 0,
    currentSession: run.metadata?.currentSession || '',
    message: 'Update cancel requested.'
  });

  res.json({ success: true, runId });
});

app.post('/upload', async (req, res) => {
  try {
    const [, files] = await parseMultipartForm(req);
    const uploadedValue = files.file;
    const uploadedFile = Array.isArray(uploadedValue) ? uploadedValue[0] : uploadedValue;

    if (!uploadedFile?.filepath) {
      res.status(400).json({ success: false, error: 'No file was attached to the upload request.' });
      return;
    }

    mkdirSync(uploadsDir, { recursive: true });

    const originalName = basename(String(uploadedFile.originalFilename || 'upload.bin')) || 'upload.bin';
    const filename = `${Date.now()}-${originalName}`;
    const absolutePath = join(uploadsDir, filename);
    const displayPath = `~/voice-terminal/uploads/${filename}`;

    renameSync(uploadedFile.filepath, absolutePath);

    const injectedMessage = `📎 User uploaded a file: ${displayPath}`;
    const result = dispatchUserMessage(injectedMessage);
    if (result?.error) {
      res.status(409).json({
        success: false,
        saved: true,
        filename,
        path: displayPath,
        size: Number(uploadedFile.size || 0),
        error: `File saved, but the agent could not accept it right now: ${result.error}`
      });
      return;
    }

    res.json({
      success: true,
      filename,
      path: displayPath,
      size: Number(uploadedFile.size || 0),
      mimetype: uploadedFile.mimetype || ''
    });
  } catch (err) {
    if (err?.code === 1016) {
      res.status(413).json({
        success: false,
        error: `File is too large. The current upload limit is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024 * 1024))} GB.`
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: err.message || 'Upload failed'
    });
  }
});

function removeClientFromTTSStreams(client, reason = 'client-disconnected') {
  for (const [requestId, active] of activeTTSStreams.entries()) {
    if (!active.clients.has(client)) continue;
    active.clients.delete(client);
    if (active.clients.size === 0) {
      active.controller.abort(reason);
    }
  }
}

function stopAllTTSStreams(reason = 'cancelled') {
  for (const active of activeTTSStreams.values()) {
    active.controller.abort(reason);
  }
}

function stopTTSForClient(client, reason = 'tts-disabled') {
  for (const active of activeTTSStreams.values()) {
    if (!active.clients.has(client)) continue;
    active.clients.delete(client);
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'tts-cancelled', requestId: active.requestId, reason }));
    }
    if (active.clients.size === 0) {
      active.controller.abort(reason);
    }
  }
}

async function synthesizeAndBroadcastAudio(text, messageId = null, targetClient = null) {
  const clients = buildTTSTargetSet(targetClient);
  if (clients.size === 0) {
    return false;
  }

  const requestId = randomUUID();
  const controller = new AbortController();
  const active = {
    requestId,
    clients,
    controller,
    messageId,
    targetClient,
    chunkSeq: 0,
    sampleRate: null,
  };
  activeTTSStreams.set(requestId, active);

  try {
    console.log(`[TTS] Streaming with Piper: "${text.slice(0, 80)}..."`);
    await synthesizeStream(text, {
      signal: controller.signal,
      onStart: (meta) => {
        active.sampleRate = meta.sampleRate;
        sendJsonToClients(active.clients, {
          type: 'tts-start',
          requestId,
          sampleRate: meta.sampleRate,
          channels: meta.channels,
          format: meta.format,
          textChunkCount: meta.textChunkCount,
        });
      },
      onChunk: (buffer) => {
        if (active.clients.size === 0) {
          controller.abort('no-clients');
          return;
        }
        active.chunkSeq += 1;
        sendJsonToClients(active.clients, {
          type: 'tts-chunk',
          requestId,
          seq: active.chunkSeq,
          byteLength: buffer.length,
          sampleRate: active.sampleRate,
        });
        sendBinaryToClients(active.clients, buffer);
      },
      onEnd: ({ chunkCount }) => {
        sendJsonToClients(active.clients, {
          type: 'tts-end',
          requestId,
          chunkCount,
        });
      },
    });

    markMessageSpeechDelivered(messageId);
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const abortReason = controller.signal.reason || 'cancelled';
      if (abortReason !== 'no-clients' && abortReason !== 'client-disconnected') {
        markMessageSpeechDelivered(messageId);
      }
      sendJsonToClients(active.clients, {
        type: 'tts-cancelled',
        requestId,
        reason: abortReason,
      });
      return false;
    }

    console.error('[TTS] Synthesis error:', err);
    sendJsonToClients(active.clients, {
      type: 'tts-error',
      requestId,
      message: err.message,
    });
    return false;
  } finally {
    cleanupTTSStream(requestId);
  }
}

function startSTTWorker() {
  if (sttWorkerProcess) {
    return;
  }

  const workerPath = join(__dirname, 'stt_worker.py');
  const modelName = process.env.STT_MODEL || 'distil-small.en';
  const computeType = process.env.STT_COMPUTE_TYPE || 'int8';

  console.log(`[STT] Starting worker with model=${modelName}, compute_type=${computeType}`);
  sttWorkerProcess = spawn('python3', [workerPath], {
    cwd: process.env.HOME,
    env: {
      ...process.env,
      STT_MODEL: modelName,
      STT_COMPUTE_TYPE: computeType
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = createInterface({ input: sttWorkerProcess.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('[STT] Non-JSON output:', line);
      return;
    }

    if (msg.type === 'ready') {
      sttReady = !msg.error;
      if (msg.error) {
        console.error(`[STT] Worker failed: ${msg.error}`);
      } else {
        console.log(`[STT] Worker ready (${msg.model || 'unknown model'})`);
      }
      return;
    }

    if (!msg.id) return;
    const pending = sttPending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    sttPending.delete(msg.id);

    try {
      unlinkSync(pending.audioPath);
    } catch {
      // Ignore cleanup errors
    }

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve((msg.text || '').trim());
    }
  });

  sttWorkerProcess.stderr.on('data', (data) => {
    console.log('[STT] stderr:', data.toString().trim());
  });

  sttWorkerProcess.on('close', (code) => {
    console.log(`[STT] Worker exited with code ${code}`);
    sttWorkerProcess = null;
    sttReady = false;
    for (const [id, pending] of sttPending.entries()) {
      clearTimeout(pending.timeout);
      try {
        unlinkSync(pending.audioPath);
      } catch {
        // Ignore cleanup errors
      }
      pending.reject(new Error('STT worker exited'));
      sttPending.delete(id);
    }
  });

  sttWorkerProcess.on('error', (err) => {
    console.error('[STT] Worker failed to start:', err);
    sttWorkerProcess = null;
    sttReady = false;
  });
}

function stopSTTWorker() {
  if (!sttWorkerProcess) return;
  console.log('[STT] Stopping worker...');
  sttWorkerProcess.kill('SIGTERM');
  sttWorkerProcess = null;
  sttReady = false;
}

function mimeTypeToExtension(mimeType) {
  if (!mimeType) return 'webm';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  return 'webm';
}

function transcribeAudioBuffer(audioBuffer, mimeType) {
  if (!sttWorkerProcess || !sttReady) {
    return Promise.reject(new Error('STT worker not ready'));
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ext = mimeTypeToExtension(mimeType);
  const audioPath = join(tmpdir(), `voice-terminal-stt-${process.pid}-${requestId}.${ext}`);
  writeFileSync(audioPath, audioBuffer);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sttPending.delete(requestId);
      try {
        unlinkSync(audioPath);
      } catch {
        // Ignore cleanup errors
      }
      reject(new Error('STT request timed out'));
    }, 60000);

    sttPending.set(requestId, {
      resolve,
      reject,
      timeout,
      audioPath
    });

    sttWorkerProcess.stdin.write(`${JSON.stringify({ id: requestId, audioPath })}\n`);
  });
}

async function readTmuxAgentStatus() {
  try {
    const brokerScript = join(__dirname, 'tmux-broker.js');
    const raw = await execFileAsync('node', [
      brokerScript,
      'status',
      '--all',
      '--all-panes',
      '--json'
    ]);
    const parsed = JSON.parse(raw || '{}');
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    return sessions.filter((s) => !HIDDEN_SESSIONS.has(s.session)).map((session) => ({
      session: session.session,
      state: session.state === 'working' ? 'working' : 'idle',
      completionCount: Number(session.completionCount || 0),
      lastDoneAt: Number(session.lastDoneAt || 0),
      panes: Array.isArray(session.panes) ? session.panes.map((pane) => ({
        paneId: pane.paneId,
        state: pane.state === 'working' ? 'working' : 'idle',
        completionCount: Number(pane.completionCount || 0),
        lastDoneAt: Number(pane.lastDoneAt || 0),
        lastActivityAt: Number(pane.lastActivityAt || 0)
      })) : []
    }));
  } catch (err) {
    console.warn(`[tmux-status] Failed to get broker status: ${err.message}`);
    return [];
  }
}

async function publishTmuxAgentStatus(force = false) {
  const sessions = await readTmuxAgentStatus();
  const payload = { type: 'tmux-agent-status', sessions };
  const json = JSON.stringify(payload);
  if (!force && json === lastTmuxStatusJson) return;
  lastTmuxStatusJson = json;
  broadcastToClients(payload);
}

function startTmuxStatusPolling() {
  if (tmuxStatusInterval) return;
  publishTmuxAgentStatus(true).catch(() => {});
  tmuxStatusInterval = setInterval(() => {
    publishTmuxAgentStatus(false).catch(() => {});
  }, 2000);
}

function stopTmuxStatusPolling() {
  if (!tmuxStatusInterval) return;
  clearInterval(tmuxStatusInterval);
  tmuxStatusInterval = null;
}

// ============================================
// WebSocket Handlers
// ============================================

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.ttsEnabled = true;
  connectedClients.add(ws);

  broadcastSessionStatus(ws);
  ws.send(JSON.stringify({
    type: 'active-tmux-session-changed',
    sessionName: activeTmuxSessionName,
    source: 'server'
  }));
  sendTTSEnabledState(ws, 'server-init');
  publishTmuxAgentStatus(true).catch(() => {});

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'start-session') {
        startSession();
        broadcastSessionStatus(ws);

      } else if (message.type === 'stop-session') {
        stopSession();
        broadcastSessionStatus(ws);

      } else if (message.type === 'restart-session') {
        restartSession();
        broadcastSessionStatus(ws);

      } else if (message.type === 'set-orchestrator') {
        const kind = normalizeOrchestratorKind(message.orchestrator);
        const result = switchOrchestrator(kind);
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: result.error || 'Failed to switch orchestrator' }));
        }

      } else if (message.type === 'get-orchestrator') {
        ws.send(JSON.stringify({
          type: 'orchestrator-changed',
          orchestrator: activeOrchestratorKind,
          label: orchestratorLabel(activeOrchestratorKind),
          supportedOrchestrators: SUPPORTED_ORCHESTRATORS
        }));

      } else if (message.type === 'get-history') {
        const activeTurn = inFlightTurn && !inFlightTurn.cancelled ? inFlightTurn : null;
        ws.send(JSON.stringify({
          type: 'history',
          messages: conversationHistory,
          inFlightTurn: activeTurn
        }));

        const pendingSpeech = conversationHistory.filter(
          (m) => m.type === 'assistant' && m.spokenSummary && !m.spokenDelivered
        );
        for (const pending of pendingSpeech) {
          synthesizeAndBroadcastAudio(pending.spokenSummary, pending.id, ws);
        }

      } else if (message.type === 'clear-history') {
        conversationHistory = [];
        ws.send(JSON.stringify({ type: 'history-cleared' }));

      } else if (message.type === 'cancel-request') {
        const interruptResult = interruptSession();
        stopAllTTSStreams('request-cancelled');
        broadcastToClients({
          type: 'request-cancelled',
          success: interruptResult.success,
          fullResponse: interruptResult.cancelledSnapshot?.fullResponse || '',
          toolCalls: interruptResult.cancelledSnapshot?.toolCalls || [],
          timeline: interruptResult.cancelledSnapshot?.timeline || []
        });

      } else if (message.type === 'stop-tts') {
        stopTTSForClient(ws, 'stopped-by-client');

      } else if (message.type === 'set-tts-enabled') {
        ws.ttsEnabled = message.enabled !== false;
        if (!ws.ttsEnabled) {
          stopTTSForClient(ws, 'tts-disabled');
        }
        sendTTSEnabledState(ws, 'server-ack');

      } else if (message.type === 'list-tmux-sessions') {
        listTmuxSessions()
          .then((sessions) => {
            ws.send(JSON.stringify({ type: 'tmux-sessions', sessions }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to list tmux sessions: ${err.message}` }));
          });

      } else if (message.type === 'create-tmux-session') {
        createTmuxSession(message.kind)
          .then((session) => {
            ws.send(JSON.stringify({
              type: 'tmux-session-created',
              name: session.name,
              kind: session.kind
            }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to create tmux session: ${err.message}` }));
          });

      } else if (message.type === 'summarize-tmux-session') {
        const sessionName = String(message.sessionName || '').trim();
        if (!sessionName) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing tmux session name to summarize' }));
          return;
        }

        const summaryPrompt = [
          `The user switched context to tmux session "${sessionName}".`,
          'Review recent activity in this session now.',
          'Use tmux-broker commands (read-stream/read-snapshot/status) to understand what happened most recently.',
          'Then provide a concise summary suitable for speech output and include [SPOKEN: ...].'
        ].join(' ');

        ws.send(JSON.stringify({
          type: 'status',
          message: `Reviewing tmux session ${sessionName}...`
        }));

        const result = sendToOrchestrator(summaryPrompt);
        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        }

      } else if (message.type === 'switch-active-tmux-session') {
        const nextSession = String(message.sessionName || '').trim();
        const result = switchActiveSession(nextSession, message.source || 'ui');
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to switch active tmux session' }));
        }

      } else if (message.type === 'voice-command') {
        const transcript = applyTmuxSessionContext(message.transcript);

        conversationHistory.push({
          id: nextMessageId++,
          type: 'user',
          content: transcript,
          timestamp: Date.now()
        });

        if (!sessionReady || !orchestrator?.isReady()) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `${orchestratorLabel(activeOrchestratorKind)} session not running. Start session first.`
          }));
          return;
        }


        const result = sendToOrchestrator(transcript);
        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        }

      } else if (message.type === 'transcribe-audio') {
        const { requestId, audioBase64, mimeType } = message;

        if (!requestId || !audioBase64) {
          ws.send(JSON.stringify({
            type: 'stt-result',
            requestId,
            error: 'Missing requestId or audio payload'
          }));
          return;
        }

        if (!sttReady) {
          ws.send(JSON.stringify({
            type: 'stt-result',
            requestId,
            error: 'STT worker not ready'
          }));
          return;
        }

        const audioBuffer = Buffer.from(audioBase64, 'base64');
        transcribeAudioBuffer(audioBuffer, mimeType)
          .then((text) => {
            ws.send(JSON.stringify({ type: 'stt-result', requestId, text }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({
              type: 'stt-result',
              requestId,
              error: err.message || 'Failed to transcribe audio'
            }));
          });
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: `Invalid message: ${err.message}` }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    connectedClients.delete(ws);
    removeClientFromTTSStreams(ws);
  });
});

// ============================================
// Start Server
// ============================================

server.listen(PORT, () => {
  console.log(`Voice terminal server running on port ${PORT}`);
  console.log(`Access at: https://${process.env.VM_NAME || 'your-vm'}.exe.xyz:${PORT}/`);

  setActiveOrchestrator(activeOrchestratorKind);
  startSession();
  startSTTWorker();
  startTmuxStatusPolling();
  loadTTSModel();
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  stopSession();
  stopSTTWorker();
  stopTmuxStatusPolling();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  stopSession();
  stopSTTWorker();
  stopTmuxStatusPolling();
  process.exit(0);
});
