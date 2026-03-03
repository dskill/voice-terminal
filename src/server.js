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
// Persistent Claude Session
// ============================================

let claudeProcess = null;
let claudeReady = false;
let sessionInitialized = false;
let responseBuffer = '';
let connectedClients = new Set();
let conversationHistory = []; // Store conversation for reconnecting clients
let sessionMetadata = {}; // Store session info from init message
let currentTurnEvents = []; // Collect all events for current turn
let cancelledTurn = false; // Soft-cancel: ignore remaining output for this turn
let currentTurnToolCalls = [];
let inFlightTurn = null;
let nextMessageId = 1;
let sttWorkerProcess = null;
let sttReady = false;
let sttPending = new Map();
let tmuxStatusInterval = null;
let lastTmuxStatusJson = '';

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
    });
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

function startClaudeSession() {
  if (claudeProcess) {
    console.log('Claude session already running');
    return;
  }

  // Clear history when starting new session
  conversationHistory = [];
  currentTurnToolCalls = [];
  inFlightTurn = null;
  nextMessageId = 1;
  sessionInitialized = false;

  console.log('Starting Claude session with stream-json mode...');

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

  claudeProcess = spawn('claude', args, {
    cwd: process.env.HOME,
    env: {
      ...process.env,
      PATH: `${projectBinDir}:${process.env.PATH || ''}`
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Read stdout line by line (each line is a JSON message)
  const rl = createInterface({ input: claudeProcess.stdout });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line);
      handleClaudeMessage(msg);
    } catch (e) {
      console.log('Non-JSON output:', line);
    }
  });

  claudeProcess.stderr.on('data', (data) => {
    console.log('Claude stderr:', data.toString());
  });

  claudeProcess.on('close', (code) => {
    console.log(`Claude process exited with code ${code}`);
    claudeProcess = null;
    claudeReady = false;
    sessionInitialized = false;
    broadcastToClients({ type: 'session-ended', code });
  });

  claudeProcess.on('error', (err) => {
    console.error('Claude process error:', err);
    claudeProcess = null;
    claudeReady = false;
  });

  // Keep stream-json sessions alive by performing the control-protocol handshake
  // immediately after startup. Newer Claude CLI versions may exit quickly without this.
  try {
    const initMessage = {
      type: 'control_request',
      request_id: `init-${Date.now()}`,
      request: { subtype: 'initialize' }
    };
    claudeProcess.stdin.write(`${JSON.stringify(initMessage)}\n`);
  } catch (err) {
    console.warn('Failed to send Claude initialize handshake:', err.message);
  }

  claudeReady = true;
  console.log('Claude session started');
}

function interruptClaude() {
  if (!claudeProcess) {
    console.log('No Claude session to interrupt');
    return false;
  }
  console.log('Soft-cancelling current turn (session stays alive)...');
  cancelledTurn = true;
  responseBuffer = '';
  return true;
}

function stopClaudeSession() {
  if (!claudeProcess) {
    console.log('No Claude session running');
    return;
  }

  console.log('Stopping Claude session...');
  claudeProcess.kill('SIGTERM');
  claudeProcess = null;
  claudeReady = false;
  sessionInitialized = false;
  conversationHistory = [];
  currentTurnToolCalls = [];
  inFlightTurn = null;
}

function handleClaudeMessage(msg) {
  console.log('Claude message:', msg.type, msg.subtype || '');

  // Store all events for debugging/analysis
  currentTurnEvents.push(msg);

  if (msg.type === 'system' && msg.subtype === 'init') {
    // Session initialization - contains model, tools, etc.
    sessionMetadata = {
      model: msg.model,
      tools: msg.tools,
      sessionId: msg.session_id,
      claudeCodeVersion: msg.claude_code_version,
      agents: msg.agents
    };
    console.log('Session initialized:', sessionMetadata.model);
    if (!sessionInitialized) {
      sessionInitialized = true;
      broadcastToClients({
        type: 'session-init',
        model: msg.model,
        claudeCodeVersion: msg.claude_code_version
      });
    } else {
      broadcastToClients({
        type: 'session-reinit',
        model: msg.model,
        claudeCodeVersion: msg.claude_code_version
      });
    }
  } else if (msg.type === 'assistant') {
    if (cancelledTurn) return; // Silently drain until result
    // Assistant message with content - contains model and usage info
    const message = msg.message;
    if (message?.content) {
      for (const block of message.content) {
        if (block.type === 'text') {
          // Text already streamed via stream_event deltas; skip to avoid duplication
        } else if (block.type === 'tool_use') {
          // Tool call - broadcast it
          console.log('Tool call:', block.name, JSON.stringify(block.input).slice(0, 100));
          currentTurnToolCalls.push({ toolName: block.name, input: block.input });
          if (inFlightTurn) {
            inFlightTurn.toolCalls.push({ toolName: block.name, input: block.input });
          }
          broadcastToClients({
            type: 'tool-call',
            toolName: block.name,
            toolId: block.id,
            input: block.input
          });
        }
      }
    }
    // Update model info if present
    if (message?.model) {
      sessionMetadata.model = message.model;
    }
  } else if (msg.type === 'stream_event') {
    if (cancelledTurn) return; // Silently drain until result
    // Streaming events from --include-partial-messages
    const event = msg.event;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      responseBuffer += event.delta.text;
      if (inFlightTurn) {
        inFlightTurn.partialText += event.delta.text;
      }
      broadcastToClients({
        type: 'partial',
        text: event.delta.text
      });
    }
  } else if (msg.type === 'result') {
    // Final result - turn is done, reset cancel flag
    const wasCancelled = cancelledTurn;
    cancelledTurn = false;
    currentTurnEvents = [];

    if (wasCancelled) {
      responseBuffer = '';
      currentTurnToolCalls = [];
      inFlightTurn = null;
      console.log('Cancelled turn finished draining, session ready for next message');
      return;
    }

    const fullResponse = responseBuffer;
    responseBuffer = '';

    const spokenSummary = extractSpokenSummary(fullResponse);

    // Extract detailed metadata from result
    const metadata = {
      durationMs: msg.duration_ms,
      durationApiMs: msg.duration_api_ms,
      numTurns: msg.num_turns,
      totalCostUsd: msg.total_cost_usd,
      usage: msg.usage,
      modelUsage: msg.modelUsage,
      isError: msg.is_error
    };

    console.log('Result:', JSON.stringify({
      duration: metadata.durationMs,
      cost: metadata.totalCostUsd,
      turns: metadata.numTurns,
      models: Object.keys(metadata.modelUsage || {})
    }));

    // Store in history
    const assistantMessage = {
      id: nextMessageId++,
      type: 'assistant',
      content: fullResponse,
      spokenSummary,
      toolCalls: currentTurnToolCalls,
      spokenDelivered: !spokenSummary,
      metadata,
      timestamp: Date.now()
    };
    conversationHistory.push(assistantMessage);
    currentTurnToolCalls = [];
    inFlightTurn = null;

    broadcastToClients({
      type: 'response',
      fullResponse,
      spokenSummary,
      toolCalls: assistantMessage.toolCalls,
      model: sessionMetadata.model,
      metadata
    });

    // Synthesize TTS audio asynchronously
    if (spokenSummary && isTTSReady() && connectedClients.size > 0) {
      synthesizeAndBroadcastAudio(spokenSummary, assistantMessage.id);
    }
  } else if (msg.type === 'error') {
    broadcastToClients({
      type: 'error',
      message: msg.error?.message || msg.message || 'Unknown error'
    });
  }
}

function extractSpokenSummary(response) {
  const matches = [...response.matchAll(/\[SPOKEN:\s*([\s\S]*?)\]/gi)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  // Fallback: use last paragraph
  const paragraphs = response.trim().split('\n\n');
  return paragraphs[paragraphs.length - 1].slice(0, 500);
}

function sendToClaud(userMessage) {
  if (!claudeProcess || !claudeReady) {
    return { error: 'Claude session not running' };
  }

  // Format message for stream-json input
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: userMessage
    }
  };

  cancelledTurn = false;
  responseBuffer = '';
  currentTurnToolCalls = [];
  inFlightTurn = {
    userMessage,
    startedAt: Date.now(),
    partialText: '',
    toolCalls: []
  };
  claudeProcess.stdin.write(JSON.stringify(message) + '\n');

  return { success: true };
}

function broadcastToClients(message) {
  const json = JSON.stringify(message);
  for (const client of connectedClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(json);
    }
  }
}

async function synthesizeAndBroadcastAudio(text, messageId = null) {
  try {
    if (connectedClients.size === 0) {
      return;
    }

    console.log(`[TTS] Synthesizing: "${text.slice(0, 80)}..."`);
    const { audio, samplingRate } = await synthesize(text);
    console.log(`[TTS] Done: ${audio.length} samples @ ${samplingRate}Hz`);

    // Send metadata first
    broadcastToClients({ type: 'tts-audio', samplingRate, numSamples: audio.length });

    // Send raw PCM as binary
    const buffer = Buffer.from(audio.buffer);
    let delivered = 0;
    for (const client of connectedClients) {
      if (client.readyState === 1) {
        client.send(buffer);
        delivered += 1;
      }
    }

    if (delivered > 0 && messageId != null) {
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
    const HIDDEN_SESSIONS = new Set(['voice-terminal', 'claude-code-sdk']);
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
  connectedClients.add(ws);

  // Send current session status
  ws.send(JSON.stringify({
    type: 'session-status',
    running: claudeReady,
    hasProcess: !!claudeProcess
  }));
  publishTmuxAgentStatus(true).catch(() => {});

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('Received:', message.type);

      if (message.type === 'start-session') {
        startClaudeSession();
        ws.send(JSON.stringify({
          type: 'session-status',
          running: claudeReady,
          hasProcess: !!claudeProcess
        }));

      } else if (message.type === 'stop-session') {
        stopClaudeSession();
        ws.send(JSON.stringify({
          type: 'session-status',
          running: false,
          hasProcess: false
        }));

      } else if (message.type === 'get-history') {
        // Send conversation history to reconnecting client
        ws.send(JSON.stringify({
          type: 'history',
          messages: conversationHistory,
          inFlightTurn
        }));

        const pendingSpeech = conversationHistory.filter(
          (m) => m.type === 'assistant' && m.spokenSummary && !m.spokenDelivered
        );
        for (const pending of pendingSpeech) {
          synthesizeAndBroadcastAudio(pending.spokenSummary, pending.id);
        }

      } else if (message.type === 'clear-history') {
        // Clear conversation history
        conversationHistory = [];
        console.log('Conversation history cleared');
        ws.send(JSON.stringify({
          type: 'history-cleared'
        }));

      } else if (message.type === 'cancel-request') {
        const interrupted = interruptClaude();
        broadcastToClients({
          type: 'request-cancelled',
          success: interrupted
        });

      } else if (message.type === 'restart-session') {
        stopClaudeSession();
        startClaudeSession();
        ws.send(JSON.stringify({
          type: 'session-status',
          running: claudeReady,
          hasProcess: !!claudeProcess
        }));

      } else if (message.type === 'list-tmux-sessions') {
        listTmuxSessions()
          .then((sessions) => {
            ws.send(JSON.stringify({
              type: 'tmux-sessions',
              sessions
            }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Failed to list tmux sessions: ${err.message}`
            }));
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
            ws.send(JSON.stringify({
              type: 'error',
              message: `Failed to create tmux session: ${err.message}`
            }));
          });

      } else if (message.type === 'voice-command') {
        const transcript = message.transcript;
        console.log(`Voice command: "${transcript}"`);

        // Store user message in history
        conversationHistory.push({
          id: nextMessageId++,
          type: 'user',
          content: transcript,
          timestamp: Date.now()
        });

        if (!claudeReady) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Claude session not running. Start session first.'
          }));
          return;
        }

        ws.send(JSON.stringify({
          type: 'status',
          message: 'Processing...'
        }));

        const result = sendToClaud(transcript);
        if (result.error) {
          ws.send(JSON.stringify({
            type: 'error',
            message: result.error
          }));
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
            ws.send(JSON.stringify({
              type: 'stt-result',
              requestId,
              text
            }));
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
      ws.send(JSON.stringify({
        type: 'error',
        message: `Invalid message: ${err.message}`
      }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    connectedClients.delete(ws);
    // Note: Claude session stays running for reconnection
  });
});

// ============================================
// Start Server
// ============================================

server.listen(PORT, () => {
  console.log(`Voice terminal server running on port ${PORT}`);
  console.log(`Access at: https://${process.env.VM_NAME || 'your-vm'}.exe.xyz:${PORT}/`);

  // Auto-start Claude session
  startClaudeSession();
  startSTTWorker();
  startTmuxStatusPolling();

  // Fire-and-forget TTS model loading
  loadTTSModel();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  stopClaudeSession();
  stopSTTWorker();
  stopTmuxStatusPolling();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  stopClaudeSession();
  stopSTTWorker();
  stopTmuxStatusPolling();
  process.exit(0);
});
