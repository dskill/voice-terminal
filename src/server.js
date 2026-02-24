import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

// Instructions prepended to every voice command
const VOICE_PROMPT_PREFIX = `You are being invoked via a voice interface. Be brief. After completing the user's request, end your response with a spoken summary in this exact format: [SPOKEN: your 1-2 sentence summary here]. Keep it conversational and concise - it will be read aloud.

User's voice request: `;

// Serve static files from dist/ (built) or public/ (dev fallback)
const distPath = join(__dirname, '../dist');
const publicPath = join(__dirname, '../public');
const staticPath = existsSync(distPath) ? distPath : publicPath;
console.log(`Serving static files from: ${staticPath}`);
app.use(express.static(staticPath));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Extract spoken summary from Claude's response
function extractSpokenSummary(response) {
  const match = response.match(/\[SPOKEN:\s*([\s\S]*?)\]/i);
  if (match) {
    return match[1].trim();
  }
  // Fallback: use the last paragraph if no tag found
  const paragraphs = response.trim().split('\n\n');
  return paragraphs[paragraphs.length - 1].slice(0, 500);
}

// Invoke Claude Code CLI
function invokeClaude(prompt, workingDir = process.env.HOME) {
  return new Promise((resolve, reject) => {
    const args = ['--print', prompt];

    const claude = spawn('claude', args, {
      cwd: workingDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']  // ignore stdin - claude hangs if stdin is piped
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      }
    });

    claude.on('error', (err) => {
      reject(err);
    });
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'voice-command') {
        const transcript = message.transcript;
        const workingDir = message.workingDir || process.env.HOME;

        console.log(`[${Date.now()}] Received command: "${transcript}"`);

        // Send acknowledgment
        ws.send(JSON.stringify({
          type: 'status',
          status: 'processing',
          message: 'Sending to Claude...'
        }));

        try {
          console.log(`[${Date.now()}] Calling Claude...`);
          const fullPrompt = VOICE_PROMPT_PREFIX + transcript;
          const response = await invokeClaude(fullPrompt, workingDir);
          console.log(`[${Date.now()}] Claude responded, length: ${response.length}`);
          const spokenSummary = extractSpokenSummary(response);

          console.log(`[${Date.now()}] Sending response to client...`);
          ws.send(JSON.stringify({
            type: 'response',
            fullResponse: response,
            spokenSummary: spokenSummary
          }));
          console.log(`[${Date.now()}] Response sent`);
        } catch (err) {
          console.log(`[${Date.now()}] Error: ${err.message}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Claude error: ${err.message}`
          }));
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Invalid message format: ${err.message}`
      }));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[${Date.now()}] Client disconnected, code: ${code}, reason: ${reason || 'none'}`);
  });
});

server.listen(PORT, () => {
  console.log(`Voice terminal server running on port ${PORT}`);
  console.log(`Access at: https://${process.env.VM_NAME || 'your-vm'}.exe.xyz:${PORT}/`);
});
