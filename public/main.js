// Voice Terminal - Main Application

// State
let ws = null;
let whisperWorker = null;
let ttsWorker = null;
let whisperReady = false;
let ttsReady = false;
let isRecording = false;
let isProcessing = false;

// Audio recording
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;

// DOM Elements
const loadingOverlay = document.getElementById('loading-overlay');
const startButton = document.getElementById('start-button');
const loadingLog = document.getElementById('loading-log');
const wsStatus = document.getElementById('ws-status');
const whisperStatus = document.getElementById('whisper-status');
const ttsStatus = document.getElementById('tts-status');
const transcriptArea = document.getElementById('transcript-area');
const liveTranscript = document.getElementById('live-transcript');
const micButton = document.getElementById('mic-button');

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

  try {
    // Check browser capabilities
    log('Checking browser capabilities...');

    const hasWebGPU = await checkWebGPU();
    log(`WebGPU: ${hasWebGPU ? 'Available' : 'Not available (will use WASM fallback)'}`);

    log(`User Agent: ${navigator.userAgent.substring(0, 80)}...`);

    // Request mic permission early
    log('Requesting microphone permission...');
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      log('Microphone permission granted');
    } catch (e) {
      logError('Microphone permission denied', e);
      throw e;
    }

    // STT DISABLED FOR DEBUGGING - using browser Web Speech API
    log('STT disabled for debugging - using browser speech recognition');
    whisperReady = true;
    whisperStatus.textContent = 'STT: Browser';
    whisperStatus.className = 'status ready';
    /*
    log('Starting Whisper (STT) initialization...');
    try {
      await initializeWhisper();
      log('Whisper ready!');
    } catch (e) {
      logError('Whisper initialization failed', e);
      throw e;
    }
    */

    // TTS DISABLED FOR DEBUGGING
    log('TTS disabled for debugging - using browser speech synthesis');
    ttsReady = true;
    ttsStatus.textContent = 'TTS: Browser';
    ttsStatus.className = 'status ready';
    /*
    log('Starting TTS initialization...');
    try {
      await initializeTTS();
      log('TTS ready!');
    } catch (e) {
      logError('TTS initialization failed', e);
      throw e;
    }
    */

    // Connect WebSocket
    log('Connecting to WebSocket server...');
    connectWebSocket();

    // Hide loading overlay
    log('All systems ready!');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
      addMessage('status', 'Voice terminal ready. Hold the mic button to speak.');
    }, 1000);

  } catch (error) {
    logError('Initialization failed', error);
    startButton.textContent = 'Failed - see log above';
  }
});

async function checkWebGPU() {
  try {
    if (!navigator.gpu) {
      log('navigator.gpu not available');
      return false;
    }
    log('Requesting WebGPU adapter...');
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      const info = await adapter.requestAdapterInfo?.() || {};
      log(`WebGPU adapter: ${info.vendor || 'unknown'} ${info.device || ''}`);
      return true;
    }
    return false;
  } catch (e) {
    log(`WebGPU check error: ${e.message}`);
    return false;
  }
}

// ============================================
// Whisper (Speech-to-Text)
// ============================================

async function initializeWhisper() {
  return new Promise((resolve, reject) => {
    log('Creating Whisper worker...');

    try {
      whisperWorker = new Worker(
        new URL('./whisper-worker.js', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      logError('Failed to create Whisper worker', e);
      reject(e);
      return;
    }

    log('Whisper worker created, setting up handlers...');

    whisperWorker.onerror = (e) => {
      logError('Whisper worker error', e);
      reject(new Error(`Worker error: ${e.message}`));
    };

    whisperWorker.onmessage = (e) => {
      const { status, data, text, error, progress, file, loaded, total } = e.data;

      if (status === 'ready') {
        whisperReady = true;
        whisperStatus.textContent = 'STT: Ready';
        whisperStatus.className = 'status ready';
        log('Whisper model loaded and ready');
        resolve();
      } else if (status === 'loading') {
        const msg = data || 'Loading...';
        whisperStatus.textContent = `STT: ${msg}`;
        log(`Whisper: ${msg}`);
      } else if (status === 'progress' || (progress !== undefined && total > 0)) {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : progress;
        const fileName = file || 'model';
        whisperStatus.textContent = `STT: ${pct}%`;
        if (pct % 20 === 0 || pct === 100) {
          log(`Whisper downloading ${fileName}: ${pct}%`);
        }
      } else if (status === 'error') {
        logError('Whisper error from worker', error);
        reject(new Error(error));
      } else if (status === 'initiate' || status === 'download') {
        log(`Whisper: ${status} ${file || ''}`);
      }
    };

    log('Sending load command to Whisper worker...');
    whisperWorker.postMessage({ type: 'load' });

    // Timeout fallback
    setTimeout(() => {
      if (!whisperReady) {
        logError('Whisper load timeout after 5 minutes', null);
        reject(new Error('Whisper load timeout'));
      }
    }, 300000);
  });
}

function transcribeAudio(audioData) {
  return new Promise((resolve, reject) => {
    if (!whisperReady || !whisperWorker) {
      reject(new Error('Whisper not ready'));
      return;
    }

    const messageHandler = (e) => {
      const { status, text, error } = e.data;

      if (status === 'update') {
        liveTranscript.textContent = text;
      } else if (status === 'complete') {
        whisperWorker.removeEventListener('message', messageHandler);
        resolve(text);
      } else if (status === 'error') {
        whisperWorker.removeEventListener('message', messageHandler);
        reject(new Error(error));
      }
    };

    whisperWorker.addEventListener('message', messageHandler);
    whisperWorker.postMessage({ type: 'transcribe', data: audioData });
  });
}

// ============================================
// TTS (Text-to-Speech)
// ============================================

async function initializeTTS() {
  return new Promise((resolve, reject) => {
    log('Creating TTS worker...');

    try {
      ttsWorker = new Worker(
        new URL('./tts-worker.js', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      logError('Failed to create TTS worker', e);
      reject(e);
      return;
    }

    log('TTS worker created, setting up handlers...');

    ttsWorker.onerror = (e) => {
      logError('TTS worker error', e);
      reject(new Error(`Worker error: ${e.message}`));
    };

    ttsWorker.onmessage = (e) => {
      const { status, data, error, progress, file, loaded, total } = e.data;

      if (status === 'ready') {
        ttsReady = true;
        ttsStatus.textContent = 'TTS: Ready';
        ttsStatus.className = 'status ready';
        log('TTS model loaded and ready');
        resolve();
      } else if (status === 'loading') {
        const msg = data || 'Loading...';
        ttsStatus.textContent = `TTS: ${msg}`;
        log(`TTS: ${msg}`);
      } else if (status === 'progress' || (progress !== undefined && total > 0)) {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : progress;
        const fileName = file || 'model';
        ttsStatus.textContent = `TTS: ${pct}%`;
        if (pct % 20 === 0 || pct === 100) {
          log(`TTS downloading ${fileName}: ${pct}%`);
        }
      } else if (status === 'error') {
        logError('TTS error from worker', error);
        reject(new Error(error));
      } else if (status === 'initiate' || status === 'download') {
        log(`TTS: ${status} ${file || ''}`);
      }
    };

    log('Sending load command to TTS worker...');
    ttsWorker.postMessage({ type: 'load' });

    // Timeout fallback
    setTimeout(() => {
      if (!ttsReady) {
        logError('TTS load timeout after 5 minutes', null);
        reject(new Error('TTS load timeout'));
      }
    }, 300000);
  });
}

function synthesizeSpeech(text) {
  return new Promise((resolve, reject) => {
    // DEBUG: Use browser speech synthesis instead of WebGPU TTS
    if (!ttsWorker) {
      // Fallback to browser speech synthesis
      if ('speechSynthesis' in window) {
        console.log('TTS: Starting speech synthesis for:', text);
        const utterance = new SpeechSynthesisUtterance(text);
        let resolved = false;

        const done = () => {
          if (!resolved) {
            resolved = true;
            console.log('TTS: Speech finished');
            resolve();
          }
        };

        utterance.onend = done;
        utterance.onerror = (e) => {
          console.log('TTS: Speech error', e);
          done();
        };

        // Timeout fallback - estimate ~100ms per word + 2 seconds buffer
        const wordCount = text.split(/\s+/).length;
        const timeout = Math.max(5000, wordCount * 150 + 2000);
        setTimeout(() => {
          if (!resolved) {
            console.log('TTS: Timeout, forcing completion');
            done();
          }
        }, timeout);

        speechSynthesis.speak(utterance);
      } else {
        console.log('TTS: Not available');
        resolve(); // No TTS available, just continue
      }
      return;
    }

    const messageHandler = (e) => {
      const { status, audio, sampleRate, error } = e.data;

      if (status === 'complete') {
        ttsWorker.removeEventListener('message', messageHandler);
        playAudio(audio, sampleRate).then(resolve).catch(reject);
      } else if (status === 'error') {
        ttsWorker.removeEventListener('message', messageHandler);
        reject(new Error(error));
      }
    };

    ttsWorker.addEventListener('message', messageHandler);
    ttsWorker.postMessage({ type: 'synthesize', text, voice: 'M1' });
  });
}

// ============================================
// Audio Playback
// ============================================

async function playAudio(audioData, sampleRate) {
  const ctx = new AudioContext({ sampleRate });
  const buffer = ctx.createBuffer(1, audioData.length, sampleRate);
  buffer.copyToChannel(audioData, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  return new Promise((resolve) => {
    source.onended = () => {
      ctx.close();
      resolve();
    };
    source.start();
  });
}

// ============================================
// Audio Recording
// ============================================

async function initializeRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
    }
  });

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm',
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = [];
    await processRecordedAudio(audioBlob);
  };

  audioContext = new AudioContext({ sampleRate: 16000 });
}

async function processRecordedAudio(audioBlob) {
  if (audioBlob.size === 0) {
    liveTranscript.textContent = '(no audio recorded)';
    setProcessing(false);
    return;
  }

  try {
    liveTranscript.textContent = 'Transcribing...';

    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    let audioData;
    if (audioBuffer.numberOfChannels === 2) {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      audioData = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        audioData[i] = (left[i] + right[i]) / 2;
      }
    } else {
      audioData = audioBuffer.getChannelData(0);
    }

    // Resample to 16kHz if needed
    if (audioBuffer.sampleRate !== 16000) {
      audioData = resampleAudio(audioData, audioBuffer.sampleRate, 16000);
    }

    const transcript = await transcribeAudio(audioData);
    handleTranscriptionComplete(transcript);

  } catch (error) {
    console.error('Audio processing error:', error);
    liveTranscript.textContent = `Error: ${error.message}`;
    setProcessing(false);
  }
}

function resampleAudio(audioData, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const newLength = Math.round(audioData.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
    const t = srcIndex - srcIndexFloor;
    result[i] = audioData[srcIndexFloor] * (1 - t) + audioData[srcIndexCeil] * t;
  }

  return result;
}

function handleTranscriptionComplete(transcript) {
  console.log('handleTranscriptionComplete called with:', transcript);
  const cleaned = transcript ? transcript.trim() : '';
  const isBlank = !cleaned ||
    cleaned.length < 2 ||
    cleaned === '[BLANK_AUDIO]' ||
    cleaned.startsWith('[');

  if (isBlank) {
    console.log('Transcript is blank, skipping');
    liveTranscript.textContent = '(no speech detected)';
    setProcessing(false);
    return;
  }

  console.log('Sending to server:', cleaned);
  liveTranscript.textContent = '';
  addMessage('user', cleaned);
  sendToServer(cleaned);
}

// ============================================
// WebSocket
// ============================================

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    wsStatus.textContent = 'WS: Connected';
    wsStatus.className = 'status connected';
    micButton.disabled = false;
    log('WebSocket connected');
  };

  ws.onclose = () => {
    wsStatus.textContent = 'WS: Disconnected';
    wsStatus.className = 'status disconnected';
    micButton.disabled = true;
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

function sendToServer(transcript) {
  console.log('sendToServer called, ws state:', ws?.readyState, 'WebSocket.OPEN:', WebSocket.OPEN);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('WebSocket not connected!');
    addMessage('error', 'Not connected to server');
    setProcessing(false);
    return;
  }

  liveTranscript.textContent = 'Sending to Claude...';
  console.log('Sending via WebSocket:', transcript);

  ws.send(JSON.stringify({
    type: 'voice-command',
    transcript: transcript,
  }));
  console.log('Sent!');
}

async function handleServerMessage(data) {
  console.log('Received server message:', data.type);
  if (data.type === 'status') {
    liveTranscript.textContent = data.message;
  } else if (data.type === 'response') {
    console.log('Got response, spokenSummary:', data.spokenSummary);
    addMessage('assistant', data.fullResponse, data.spokenSummary);
    liveTranscript.textContent = 'Speaking...';

    if (data.spokenSummary && ttsReady) {
      try {
        console.log('Starting TTS...');
        await synthesizeSpeech(data.spokenSummary);
        console.log('TTS complete');
      } catch (err) {
        console.error('TTS playback error:', err);
      }
    }

    console.log('Resetting UI state');
    liveTranscript.textContent = '';
    setProcessing(false);

  } else if (data.type === 'error') {
    addMessage('error', data.message);
    liveTranscript.textContent = '';
    setProcessing(false);
  }
}

// ============================================
// UI Helpers
// ============================================

function addMessage(type, content, spokenSummary = null) {
  const div = document.createElement('div');
  div.className = `message ${type}`;

  const labels = {
    user: 'You',
    assistant: 'Claude',
    status: 'Status',
    error: 'Error'
  };

  let html = `<div class="message-label">${labels[type] || type}</div>`;
  html += `<div>${escapeHtml(content)}</div>`;

  if (spokenSummary) {
    html += `<div class="spoken-summary"><strong>Spoken:</strong> ${escapeHtml(spokenSummary)}</div>`;
  }

  div.innerHTML = html;
  transcriptArea.appendChild(div);
  transcriptArea.scrollTop = transcriptArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setProcessing(processing) {
  isProcessing = processing;
  micButton.disabled = processing || !whisperReady || !ttsReady;
  micButton.classList.toggle('processing', processing);
}

// ============================================
// Recording Controls
// ============================================

// Browser speech recognition (fallback when Whisper disabled)
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
  browserRecognition.continuous = false;
  browserRecognition.interimResults = true;
  browserRecognition.lang = 'en-US';

  browserRecognition.onresult = (event) => {
    console.log('Speech recognition onresult:', event);
    let transcript = '';
    let isFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) isFinal = true;
    }
    console.log('Transcript:', transcript, 'isFinal:', isFinal);
    lastTranscript = transcript;
    liveTranscript.textContent = transcript;
    if (isFinal) {
      transcriptProcessed = true;
      handleTranscriptionComplete(transcript);
    }
  };

  browserRecognition.onstart = () => {
    console.log('Speech recognition started');
    lastTranscript = '';
    transcriptProcessed = false;
  };

  browserRecognition.onaudiostart = () => {
    console.log('Audio capture started');
  };

  browserRecognition.onsoundstart = () => {
    console.log('Sound detected');
  };

  browserRecognition.onspeechstart = () => {
    console.log('Speech detected');
  };

  browserRecognition.onerror = (event) => {
    console.log('Speech recognition error:', event.error, event);
    log(`Speech recognition error: ${event.error}`, true);
    liveTranscript.textContent = `Error: ${event.error}`;
    setProcessing(false);
  };

  browserRecognition.onend = () => {
    console.log('Speech recognition ended, isRecording:', isRecording, 'transcriptProcessed:', transcriptProcessed, 'lastTranscript:', lastTranscript);
    if (isRecording) {
      isRecording = false;
      micButton.classList.remove('recording');
    }
    // Process transcript if we got one but it wasn't marked as final
    if (!transcriptProcessed && lastTranscript) {
      console.log('Processing transcript on end (was not final)');
      handleTranscriptionComplete(lastTranscript);
    }
  };

  browserRecognition.onnomatch = () => {
    console.log('Speech recognition: no match');
  };

  log('Browser speech recognition initialized');
  return true;
}

async function startRecording() {
  if (isRecording || isProcessing) return;
  if (!whisperReady || !ttsReady) return;

  // DEBUG: Use browser speech recognition when Whisper is disabled
  if (!whisperWorker) {
    if (!browserRecognition) {
      initBrowserSpeechRecognition();
    }
    if (browserRecognition) {
      isRecording = true;
      micButton.classList.add('recording');
      liveTranscript.textContent = 'Listening...';
      browserRecognition.start();
      return;
    }
  }

  if (!mediaRecorder) {
    await initializeRecording();
  }

  isRecording = true;
  audioChunks = [];
  micButton.classList.add('recording');
  liveTranscript.textContent = 'Listening...';
  mediaRecorder.start(100);
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  micButton.classList.remove('recording');
  setProcessing(true);

  // DEBUG: Stop browser speech recognition if using fallback
  if (browserRecognition && !whisperWorker) {
    browserRecognition.stop();
    return;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// Event listeners for mic button
micButton.addEventListener('mousedown', startRecording);
micButton.addEventListener('mouseup', stopRecording);
micButton.addEventListener('mouseleave', () => {
  if (isRecording) stopRecording();
});
micButton.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
});
micButton.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording();
});

// Spacebar push-to-talk
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !isRecording && !isProcessing) {
    if (document.activeElement?.tagName === 'INPUT') return;
    e.preventDefault();
    startRecording();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && isRecording) {
    e.preventDefault();
    stopRecording();
  }
});

// Global error handler
window.onerror = (msg, url, line, col, error) => {
  logError(`Uncaught error at ${url}:${line}`, error || msg);
};

window.onunhandledrejection = (event) => {
  logError('Unhandled promise rejection', event.reason);
};
