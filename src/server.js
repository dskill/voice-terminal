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
  console.log('Claude message:', msg.type);

  if (msg.type === 'assistant') {
    // Assistant message with content
    if (msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          responseBuffer += block.text;
        }
      }
    }
  } else if (msg.type === 'content_block_delta') {
    // Streaming text delta
    if (msg.delta?.text) {
      responseBuffer += msg.delta.text;
      broadcastToClients({
        type: 'partial',
        text: msg.delta.text
      });
    }
  } else if (msg.type === 'result') {
    // Final result
    const fullResponse = responseBuffer;
    responseBuffer = '';

    const spokenSummary = extractSpokenSummary(fullResponse);

    // Store in history
    conversationHistory.push({
      type: 'assistant',
      content: fullResponse,
      spokenSummary,
      timestamp: Date.now()
    });

    broadcastToClients({
      type: 'response',
      fullResponse,
      spokenSummary
    });
  } else if (msg.type === 'error') {
    broadcastToClients({
      type: 'error',
      message: msg.error?.message || 'Unknown error'
    });
  }
}

function extractSpokenSummary(response) {
  const match = response.match(/\[SPOKEN:\s*([\s\S]*?)\]/i);
  if (match) {
    return match[1].trim();
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
