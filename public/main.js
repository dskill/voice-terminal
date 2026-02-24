// Voice Terminal - Main Application

// State
let ws = null;
let isRecording = false;
let isProcessing = false;
let claudeSessionRunning = false;
let currentModel = '';
let streamingMessageDiv = null; // Reference to streaming message element

// DOM Elements
const loadingOverlay = document.getElementById('loading-overlay');
const startButton = document.getElementById('start-button');
const loadingLog = document.getElementById('loading-log');
const wsStatus = document.getElementById('ws-status');
const claudeStatus = document.getElementById('claude-status');
const sessionToggle = document.getElementById('session-toggle');
const transcriptArea = document.getElementById('transcript-area');
const liveTranscript = document.getElementById('live-transcript');
const micButton = document.getElementById('mic-button');
const inputArea = document.getElementById('input-area');
const inputField = document.getElementById('input-field');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const clearHistoryBtn = document.getElementById('clear-history');
const refreshBtn = document.getElementById('refresh-btn');
const contextBarFill = document.getElementById('context-bar-fill');

// WebSocket URL
const WS_URL = `wss://${location.host}`;

// ============================================
// Debug Logging
// ============================================

function log(message, isError = false) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${message}`;
  console.log(entry);

  if (loadingLog) {
    const div = document.createElement('div');
    div.textContent = entry;
    if (isError) div.style.color = '#ef4444';
    loadingLog.appendChild(div);
    loadingLog.scrollTop = loadingLog.scrollHeight;
  }
}

function logError(message, error) {
  log(`ERROR: ${message}: ${error?.message || error}`, true);
  if (error?.stack) {
    console.error(error.stack);
  }
}

// ============================================
// Initialization
// ============================================

startButton.addEventListener('click', async () => {
  startButton.textContent = 'Initializing...';
  startButton.disabled = true;
  loadingLog.innerHTML = '';

  // Unlock TTS early on user gesture (iOS requirement)
  unlockTTS();

  try {
    log('Checking browser capabilities...');
    log(`User Agent: ${navigator.userAgent.substring(0, 80)}...`);

    // Request mic permission
    log('Requesting microphone permission...');
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      log('Microphone permission granted');
    } catch (e) {
      logError('Microphone permission denied', e);
      throw e;
    }

    // Connect WebSocket
    log('Connecting to server...');
    connectWebSocket();

    // Hide loading overlay after connection
    log('Ready!');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
      addMessage('status', 'Voice terminal ready. Tap the mic button to start/stop recording.');
      // Force scroll to make content visible
      setTimeout(scrollToBottom, 100);
    }, 1000);

  } catch (error) {
    logError('Initialization failed', error);
    startButton.textContent = 'Failed - see log above';
  }
});

// ============================================
// WebSocket
// ============================================

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    wsStatus.textContent = 'WS: Connected';
    wsStatus.className = 'status connected';
    sessionToggle.disabled = false;
    log('WebSocket connected');
    // Request conversation history on reconnect
    sendToServer('get-history');
  };

  ws.onclose = () => {
    wsStatus.textContent = 'WS: Disconnected';
    wsStatus.className = 'status disconnected';
    micButton.disabled = true;
    sessionToggle.disabled = true;
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerMessage(data);
  };
}

function sendToServer(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addMessage('error', 'Not connected to server');
    return false;
  }
  ws.send(JSON.stringify({ type, ...payload }));
  return true;
}

// ============================================
// Session Control
// ============================================

sessionToggle.addEventListener('click', () => {
  if (claudeSessionRunning) {
    sendToServer('stop-session');
  } else {
    sendToServer('start-session');
  }
});

function updateSessionUI(running) {
  claudeSessionRunning = running;

  if (running) {
    claudeStatus.textContent = 'Claude: Running';
    claudeStatus.className = 'status ready';
    sessionToggle.textContent = 'Stop';
    sessionToggle.classList.add('running');
    micButton.disabled = false;
  } else {
    claudeStatus.textContent = 'Claude: Stopped';
    claudeStatus.className = 'status disconnected';
    sessionToggle.textContent = 'Start';
    sessionToggle.classList.remove('running');
    micButton.disabled = true;
  }
}

// ============================================
// Server Message Handling
// ============================================

let streamingResponse = '';

async function handleServerMessage(data) {
  console.log('Server message:', data.type);

  switch (data.type) {
    case 'session-status':
      updateSessionUI(data.running);
      break;

    case 'session-init':
      // Session initialized with model info
      currentModel = data.model || '';
      updateModelDisplay(currentModel);
      addMessage('status', `Session started (${formatModelName(currentModel)})`);
      break;

    case 'history':
      // Restore conversation history on reconnect
      if (data.messages && data.messages.length > 0) {
        transcriptArea.innerHTML = ''; // Clear existing messages
        for (const msg of data.messages) {
          if (msg.type === 'user') {
            addMessage('user', msg.content);
          } else if (msg.type === 'assistant') {
            addMessage('assistant', msg.content, msg.spokenSummary, msg.metadata);
          }
        }
        addMessage('status', 'Reconnected - conversation history restored.');
      }
      // Force scroll after history loads
      setTimeout(scrollToBottom, 100);
      break;

    case 'session-ended':
      updateSessionUI(false);
      addMessage('status', `Claude session ended (code: ${data.code})`);
      break;

    case 'status':
      liveTranscript.textContent = data.message;
      break;

    case 'tool-call':
      // Show tool calls in real-time
      if (!streamingMessageDiv) {
        streamingMessageDiv = createStreamingMessage();
      }
      appendToolCall(streamingMessageDiv, data.toolName, data.input);
      liveTranscript.textContent = `Using ${data.toolName}...`;
      break;

    case 'partial':
      // Streaming text update
      streamingResponse += data.text;
      if (!streamingMessageDiv) {
        streamingMessageDiv = createStreamingMessage();
      }
      updateStreamingText(streamingMessageDiv, streamingResponse);
      liveTranscript.textContent = 'Thinking...';
      break;

    case 'response':
      // Finalize streaming message
      if (streamingMessageDiv) {
        finalizeStreamingMessage(streamingMessageDiv, data.fullResponse, data.spokenSummary, data.metadata);
        streamingMessageDiv = null;
      } else {
        addMessage('assistant', data.fullResponse, data.spokenSummary, data.metadata);
      }
      streamingResponse = '';

      if (data.model) {
        currentModel = data.model;
        updateModelDisplay(currentModel);
      }

      liveTranscript.textContent = 'Speaking...';

      if (data.spokenSummary) {
        await synthesizeSpeech(data.spokenSummary);
      }

      liveTranscript.textContent = '';
      setProcessing(false);
      break;

    case 'error':
      if (streamingMessageDiv) {
        streamingMessageDiv.remove();
        streamingMessageDiv = null;
      }
      streamingResponse = '';
      addMessage('error', data.message);
      liveTranscript.textContent = '';
      setProcessing(false);
      break;
  }
}

// ============================================
// Text-to-Speech (Browser Native)
// ============================================

let ttsUnlocked = false;

// iOS requires TTS to be triggered by user gesture first
function unlockTTS() {
  if (ttsUnlocked || !('speechSynthesis' in window)) return;

  // Speak empty utterance to unlock
  const utterance = new SpeechSynthesisUtterance('');
  utterance.volume = 0;
  speechSynthesis.speak(utterance);
  ttsUnlocked = true;
  console.log('TTS: Unlocked');
}

function synthesizeSpeech(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      console.log('TTS: speechSynthesis not available');
      resolve();
      return;
    }

    // Cancel any pending speech
    speechSynthesis.cancel();

    console.log('TTS: Speaking:', text);
    console.log('TTS: voices available:', speechSynthesis.getVoices().length);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    let resolved = false;
    let pollInterval = null;

    const done = (reason) => {
      if (!resolved) {
        resolved = true;
        if (pollInterval) clearInterval(pollInterval);
        console.log('TTS: Finished -', reason);
        resolve();
      }
    };

    utterance.onstart = () => console.log('TTS: Started speaking');
    utterance.onend = () => done('onend');
    utterance.onerror = (e) => {
      console.log('TTS: Error -', e.error || e);
      done('error');
    };

    // Poll speechSynthesis.speaking as fallback
    pollInterval = setInterval(() => {
      if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        done('poll');
      }
    }, 200);

    // Timeout fallback
    const wordCount = text.split(/\s+/).length;
    const timeout = Math.max(5000, wordCount * 200 + 3000);
    setTimeout(() => done('timeout'), timeout);

    // Small delay after cancel
    setTimeout(() => {
      console.log('TTS: Calling speak()');
      speechSynthesis.speak(utterance);
    }, 100);
  });
}

// ============================================
// Speech Recognition (Browser Native)
// ============================================

let browserRecognition = null;
let lastTranscript = '';
let transcriptProcessed = false;

function initBrowserSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log('Browser speech recognition not available');
    return false;
  }

  browserRecognition = new SpeechRecognition();
  browserRecognition.continuous = true;  // Keep listening until manually stopped
  browserRecognition.interimResults = true;
  browserRecognition.lang = 'en-US';

  browserRecognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    lastTranscript = transcript;
    liveTranscript.textContent = transcript;
    // Don't auto-send on isFinal - wait for user to tap button to stop
  };

  browserRecognition.onstart = () => {
    lastTranscript = '';
    transcriptProcessed = false;
  };

  browserRecognition.onerror = (event) => {
    console.log('Speech recognition error:', event.error);
    liveTranscript.textContent = `Error: ${event.error}`;
    setProcessing(false);
  };

  browserRecognition.onend = () => {
    if (isRecording) {
      // Recognition ended unexpectedly while still recording
      isRecording = false;
      micButton.classList.remove('recording');
      // Show input area with whatever we got
      if (lastTranscript) {
        showInputArea(lastTranscript);
      }
    }
  };

  return true;
}

function handleTranscriptionComplete(transcript) {
  const cleaned = transcript?.trim() || '';

  if (!cleaned || cleaned.length < 2) {
    liveTranscript.textContent = '(no speech detected)';
    setProcessing(false);
    return;
  }

  liveTranscript.textContent = 'Sending to Claude...';
  addMessage('user', cleaned);
  sendToServer('voice-command', { transcript: cleaned });
}

// ============================================
// Recording Controls
// ============================================

async function startRecording() {
  if (isRecording || isProcessing) return;
  if (!claudeSessionRunning) {
    liveTranscript.textContent = 'Start Claude session first';
    return;
  }

  // Unlock TTS on user gesture (iOS requirement)
  unlockTTS();

  if (!browserRecognition) {
    initBrowserSpeechRecognition();
  }

  if (browserRecognition) {
    isRecording = true;
    micButton.classList.add('recording');
    liveTranscript.textContent = 'Listening...';
    browserRecognition.start();
  }
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  micButton.classList.remove('recording');

  if (browserRecognition) {
    browserRecognition.stop();
  }

  // Show edit UI instead of auto-sending
  showInputArea(lastTranscript);
}

function showInputArea(text = '') {
  inputField.value = text;
  inputArea.classList.add('visible');
  micButton.style.display = 'none';
  liveTranscript.style.display = 'none';
  inputField.focus();
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
  });
}

function updateContextBar(percent) {
  contextBarFill.style.width = percent + '%';
  contextBarFill.classList.remove('warning', 'danger');
  if (percent >= 80) {
    contextBarFill.classList.add('danger');
  } else if (percent >= 60) {
    contextBarFill.classList.add('warning');
  }
  contextBarFill.parentElement.title = `Context: ${percent}%`;
}

// Fix initial viewport position on mobile
window.addEventListener('load', () => {
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
});

function hideInputArea() {
  inputArea.classList.remove('visible');
  micButton.style.display = 'flex';
  liveTranscript.style.display = 'block';
  liveTranscript.textContent = '';
}

function sendMessage() {
  const text = inputField.value.trim();
  hideInputArea();

  if (!text || text.length < 2) {
    liveTranscript.textContent = '(no message to send)';
    return;
  }

  setProcessing(true);
  liveTranscript.textContent = 'Sending to Claude...';
  addMessage('user', text);
  sendToServer('voice-command', { transcript: text });
}

function cancelMessage() {
  hideInputArea();
  liveTranscript.textContent = '(cancelled)';
  setTimeout(() => {
    liveTranscript.textContent = '';
  }, 1500);
}

// Input area buttons
sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', cancelMessage);

// Enter to send, Shift+Enter for newline
inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'Escape') {
    cancelMessage();
  }
});

// Auto-scroll when textarea content changes (grows)
inputField.addEventListener('input', () => {
  scrollToBottom();
});

// Clear history button
clearHistoryBtn.addEventListener('click', () => {
  if (confirm('Clear conversation history?')) {
    sendToServer('clear-history');
    transcriptArea.innerHTML = '';
    addMessage('status', 'History cleared.');
  }
});

// Refresh button
refreshBtn.addEventListener('click', () => {
  location.reload();
});

// Event listeners - tap to toggle recording
function toggleRecording() {
  if (isProcessing) return;
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// Use touchstart for mobile to prevent scroll issues
micButton.addEventListener('touchstart', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleRecording();
}, { passive: false });

// Click for desktop
micButton.addEventListener('click', (e) => {
  // Skip if this was triggered by touch
  if (e.sourceCapabilities?.firesTouchEvents) return;
  toggleRecording();
});

// Spacebar tap-to-toggle
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !isProcessing) {
    if (document.activeElement?.tagName === 'INPUT') return;
    e.preventDefault();
    toggleRecording();
  }
});

// ============================================
// UI Helpers
// ============================================

function formatModelName(model) {
  if (!model) return 'Unknown';
  // claude-opus-4-6-20260... -> Opus 4.6
  const match = model.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return `${name} ${match[2]}.${match[3]}`;
  }
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model.split('-').slice(1, 3).join(' ');
}

function formatCost(cost) {
  if (!cost) return '';
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
  return `$${cost.toFixed(4)}`;
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function updateModelDisplay(model) {
  const modelName = formatModelName(model);
  claudeStatus.textContent = `Claude: ${modelName}`;
}

function createStreamingMessage() {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  div.innerHTML = `
    <div class="message-label">Claude</div>
    <div class="tool-calls"></div>
    <div class="streaming-text"></div>
  `;
  transcriptArea.appendChild(div);
  scrollToBottom();
  return div;
}

function appendToolCall(div, toolName, input) {
  const toolCalls = div.querySelector('.tool-calls');
  const toolDiv = document.createElement('div');
  toolDiv.className = 'tool-call';

  // Format tool input preview
  let inputPreview = '';
  if (input) {
    if (input.command) inputPreview = input.command.slice(0, 50);
    else if (input.file_path) inputPreview = input.file_path;
    else if (input.pattern) inputPreview = input.pattern;
    else inputPreview = JSON.stringify(input).slice(0, 50);
    if (inputPreview.length >= 50) inputPreview += '...';
  }

  toolDiv.innerHTML = `<span class="tool-name">${escapeHtml(toolName)}</span>${inputPreview ? ` <span class="tool-input">${escapeHtml(inputPreview)}</span>` : ''}`;
  toolCalls.appendChild(toolDiv);
  scrollToBottom();
}

function updateStreamingText(div, text) {
  const textDiv = div.querySelector('.streaming-text');
  textDiv.textContent = text;
  scrollToBottom();
}

function finalizeStreamingMessage(div, fullResponse, spokenSummary, metadata) {
  div.classList.remove('streaming');

  const textDiv = div.querySelector('.streaming-text');
  textDiv.textContent = fullResponse;

  if (spokenSummary) {
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'spoken-summary';
    summaryDiv.innerHTML = `<strong>Spoken:</strong> ${escapeHtml(spokenSummary)}`;
    div.appendChild(summaryDiv);
  }

  if (metadata) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';
    const parts = [];
    if (metadata.durationMs) parts.push(formatDuration(metadata.durationMs));
    if (metadata.totalCostUsd) parts.push(formatCost(metadata.totalCostUsd));
    if (metadata.numTurns) parts.push(`${metadata.numTurns} turn${metadata.numTurns > 1 ? 's' : ''}`);
    if (parts.length > 0) {
      metaDiv.textContent = parts.join(' · ');
      div.appendChild(metaDiv);
    }
  }

  scrollToBottom();
}

function addMessage(type, content, spokenSummary = null, metadata = null) {
  const div = document.createElement('div');
  div.className = `message ${type}`;

  const labels = {
    user: 'You',
    assistant: 'Claude',
    status: 'Status',
    error: 'Error'
  };

  let html = `<div class="message-label">${labels[type] || type}</div>`;
  html += `<div class="message-content">${escapeHtml(content)}</div>`;

  if (spokenSummary) {
    html += `<div class="spoken-summary"><strong>Spoken:</strong> ${escapeHtml(spokenSummary)}</div>`;
  }

  if (metadata && type === 'assistant') {
    const parts = [];
    if (metadata.durationMs) parts.push(formatDuration(metadata.durationMs));
    if (metadata.totalCostUsd) parts.push(formatCost(metadata.totalCostUsd));
    if (metadata.numTurns) parts.push(`${metadata.numTurns} turn${metadata.numTurns > 1 ? 's' : ''}`);
    if (parts.length > 0) {
      html += `<div class="message-meta">${parts.join(' · ')}</div>`;
    }
  }

  div.innerHTML = html;
  transcriptArea.appendChild(div);

  // Scroll after DOM renders
  scrollToBottom();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setProcessing(processing) {
  isProcessing = processing;
  micButton.disabled = processing || !claudeSessionRunning;
  micButton.classList.toggle('processing', processing);
}

// Global error handlers
window.onerror = (msg, url, line, col, error) => {
  logError(`Uncaught error at ${url}:${line}`, error || msg);
};

window.onunhandledrejection = (event) => {
  logError('Unhandled promise rejection', event.reason);
};
