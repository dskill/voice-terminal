import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

// System prompt for voice interface
const VOICE_SYSTEM_PROMPT = `You are being controlled via a voice interface. Be concise. After completing requests, end your response with a spoken summary in this format: [SPOKEN: your 1-2 sentence summary]. Keep it conversational - it will be read aloud.`;

// Serve static files
const distPath = join(__dirname, '../dist');
const publicPath = join(__dirname, '../public');
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
let responseBuffer = '';
let connectedClients = new Set();
let conversationHistory = []; // Store conversation for reconnecting clients
let sessionMetadata = {}; // Store session info from init message
let currentTurnEvents = []; // Collect all events for current turn

function startClaudeSession() {
  if (claudeProcess) {
    console.log('Claude session already running');
    return;
  }

  // Clear history when starting new session
  conversationHistory = [];

  console.log('Starting Claude session with stream-json mode...');

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
  ];

  claudeProcess = spawn('claude', args, {
    cwd: process.env.HOME,
    env: { ...process.env },
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
    broadcastToClients({ type: 'session-ended', code });
  });

  claudeProcess.on('error', (err) => {
    console.error('Claude process error:', err);
    claudeProcess = null;
    claudeReady = false;
  });

  claudeReady = true;
  console.log('Claude session started');
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
  conversationHistory = [];
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
    broadcastToClients({
      type: 'session-init',
      model: msg.model,
      claudeCodeVersion: msg.claude_code_version
    });
  } else if (msg.type === 'assistant') {
    // Assistant message with content - contains model and usage info
    const message = msg.message;
    if (message?.content) {
      for (const block of message.content) {
        if (block.type === 'text') {
          responseBuffer += block.text;
          // Stream text to client
          broadcastToClients({
            type: 'partial',
            text: block.text
          });
        } else if (block.type === 'tool_use') {
          // Tool call - broadcast it
          console.log('Tool call:', block.name, JSON.stringify(block.input).slice(0, 100));
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
  } else if (msg.type === 'content_block_delta') {
    // Streaming text delta (if --include-partial-messages is used)
    if (msg.delta?.text) {
      responseBuffer += msg.delta.text;
      broadcastToClients({
        type: 'partial',
        text: msg.delta.text
      });
    }
  } else if (msg.type === 'result') {
    // Final result - contains cost, usage, model breakdown
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
    conversationHistory.push({
      type: 'assistant',
      content: fullResponse,
      spokenSummary,
      metadata,
      timestamp: Date.now()
    });

    broadcastToClients({
      type: 'response',
      fullResponse,
      spokenSummary,
      model: sessionMetadata.model,
      metadata
    });

    // Clear turn events for next turn
    currentTurnEvents = [];
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
      content: VOICE_SYSTEM_PROMPT + '\n\nUser request: ' + userMessage
    }
  };

  responseBuffer = '';
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
          messages: conversationHistory
        }));

      } else if (message.type === 'clear-history') {
        // Clear conversation history
        conversationHistory = [];
        console.log('Conversation history cleared');
        ws.send(JSON.stringify({
          type: 'history-cleared'
        }));

      } else if (message.type === 'voice-command') {
        const transcript = message.transcript;
        console.log(`Voice command: "${transcript}"`);

        // Store user message in history
        conversationHistory.push({
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
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  stopClaudeSession();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  stopClaudeSession();
  process.exit(0);
});
