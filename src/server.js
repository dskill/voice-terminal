import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import express from 'express';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { createInterface } from 'readline';
import { tmpdir } from 'os';
import { loadTTSModel, isTTSReady, synthesize } from './tts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

const ORCHESTRATOR_CONFIG = {
  claude: {
    kind: 'claude',
    label: 'Claude',
    defaultModel: 'claude-code'
  },
  codex: {
    kind: 'codex',
    label: 'Codex (Spark)',
    defaultModel: 'gpt-5.3-codex-spark'
  }
};

const SUPPORTED_ORCHESTRATORS = Object.keys(ORCHESTRATOR_CONFIG);

function normalizeOrchestratorKind(kind) {
  return kind === 'codex' ? 'codex' : 'claude';
}

function orchestratorLabel(kind) {
  return ORCHESTRATOR_CONFIG[normalizeOrchestratorKind(kind)].label;
}

// Serve static files
const distPath = join(__dirname, '../dist');
const publicPath = join(__dirname, '../public');
const systemPromptPath = join(__dirname, '../system-prompt.md');
const staticPath = existsSync(distPath) ? distPath : publicPath;
console.log(`Serving static files from: ${staticPath}`);
app.use(express.static(staticPath));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ============================================
// Orchestrator Session State
// ============================================

let activeOrchestratorKind = normalizeOrchestratorKind(process.env.ORCHESTRATOR || 'claude');
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
    : 'claude --dangerously-skip-permissions';
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

    const fullResponse = typeof event.fullResponse === 'string' ? event.fullResponse : responseBuffer;
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

    broadcastToClients({
      type: 'response',
      fullResponse,
      spokenSummary,
      toolCalls: assistantMessage.toolCalls,
      timeline: assistantMessage.timeline,
      model: sessionMetadata.model,
      orchestrator: activeOrchestratorKind,
      metadata
    });

    if (spokenSummary && isTTSReady() && getTTSEnabledClients().length > 0) {
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

function createClaudeAdapter(emit) {
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
  return createClaudeAdapter(emit);
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

async function synthesizeAndBroadcastAudio(text, messageId = null, targetClient = null) {
  try {
    const ttsClients = getTTSEnabledClients(targetClient);
    if (ttsClients.length === 0) {
      return;
    }

    console.log(`[TTS] Synthesizing: "${text.slice(0, 80)}..."`);
    const { audio, samplingRate } = await synthesize(text);
    console.log(`[TTS] Done: ${audio.length} samples @ ${samplingRate}Hz`);

    const meta = JSON.stringify({ type: 'tts-audio', samplingRate, numSamples: audio.length });
    for (const client of ttsClients) {
      client.send(meta);
    }

    const buffer = Buffer.from(audio.buffer);
    for (const client of ttsClients) {
      client.send(buffer);
    }

    if (messageId != null) {
      const msg = conversationHistory.find((m) => m.id === messageId);
      if (msg) {
        msg.spokenDelivered = true;
      }
    }
  } catch (err) {
    console.error('[TTS] Synthesis error:', err);
    broadcastToClients({ type: 'tts-error', message: err.message });
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
        broadcastToClients({
          type: 'request-cancelled',
          success: interruptResult.success,
          fullResponse: interruptResult.cancelledSnapshot?.fullResponse || '',
          toolCalls: interruptResult.cancelledSnapshot?.toolCalls || [],
          timeline: interruptResult.cancelledSnapshot?.timeline || []
        });

      } else if (message.type === 'set-tts-enabled') {
        ws.ttsEnabled = message.enabled !== false;

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

      } else if (message.type === 'voice-command') {
        const transcript = message.transcript;

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

        ws.send(JSON.stringify({ type: 'status', message: 'Processing...' }));

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
