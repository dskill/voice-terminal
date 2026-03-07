import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_PIPER_BIN = existsSync(join(REPO_ROOT, '.venv/bin/piper'))
  ? join(REPO_ROOT, '.venv/bin/piper')
  : 'piper';
const DEFAULT_PIPER_MODEL = existsSync(join(REPO_ROOT, 'models/piper/en_US-lessac-medium.onnx'))
  ? join(REPO_ROOT, 'models/piper/en_US-lessac-medium.onnx')
  : '';

const PIPER_BIN = process.env.PIPER_BIN || DEFAULT_PIPER_BIN;
const PIPER_MODEL = process.env.PIPER_MODEL || DEFAULT_PIPER_MODEL;
const PIPER_MODEL_CONFIG = process.env.PIPER_MODEL_CONFIG || inferConfigPath(PIPER_MODEL);
const PIPER_SPEAKER = process.env.PIPER_SPEAKER;
const DEFAULT_SAMPLE_RATE = Number(process.env.PIPER_SAMPLE_RATE || 22050);
const MAX_CHUNK_LENGTH = Number(process.env.TTS_MAX_CHUNK_LENGTH || 280);

let ready = false;
let sampleRate = DEFAULT_SAMPLE_RATE;
let readinessError = '';

function inferConfigPath(modelPath) {
  if (!modelPath) return '';
  if (existsSync(`${modelPath}.json`)) return `${modelPath}.json`;
  if (existsSync(modelPath.replace(/\.onnx$/i, '.onnx.json'))) return modelPath.replace(/\.onnx$/i, '.onnx.json');
  return `${modelPath}.json`;
}

function parseSampleRate(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return DEFAULT_SAMPLE_RATE;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const value = raw?.audio?.sample_rate;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SAMPLE_RATE;
  } catch (err) {
    console.warn(`[TTS] Failed to parse Piper config at ${configPath}: ${err.message}`);
    return DEFAULT_SAMPLE_RATE;
  }
}

function splitParagraphIntoSentences(paragraph) {
  const text = String(paragraph || '').trim();
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function forceSplitLongText(text, maxChunkLength) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  const parts = [];
  let remaining = normalized;
  while (remaining.length > maxChunkLength) {
    let cut = remaining.lastIndexOf(' ', maxChunkLength);
    if (cut <= 0) cut = maxChunkLength;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function splitTextIntoChunks(text, maxChunkLength = MAX_CHUNK_LENGTH) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  const appendPiece = (piece) => {
    if (!piece) return;
    if (!current) {
      current = piece;
      return;
    }

    const candidate = `${current} ${piece}`;
    if (candidate.length <= maxChunkLength) {
      current = candidate;
      return;
    }

    pushCurrent();
    current = piece;
  };

  for (const paragraph of paragraphs) {
    const sentences = splitParagraphIntoSentences(paragraph);
    const pieces = sentences.length > 0 ? sentences : [paragraph];

    for (const piece of pieces) {
      if (piece.length <= maxChunkLength) {
        appendPiece(piece);
        continue;
      }

      pushCurrent();
      for (const forced of forceSplitLongText(piece, maxChunkLength)) {
        chunks.push(forced);
      }
    }

    pushCurrent();
  }

  if (chunks.length === 0) {
    return forceSplitLongText(String(text || ''), maxChunkLength);
  }

  return chunks;
}

export function isTTSReady() {
  return ready;
}

export function getTTSStatus() {
  return {
    ready,
    sampleRate,
    error: readinessError,
    provider: 'piper',
  };
}

export async function loadTTSModel() {
  if (!PIPER_MODEL) {
    ready = false;
    readinessError = 'PIPER_MODEL is not set';
    console.warn('[TTS] Piper disabled: set PIPER_MODEL to enable streaming TTS');
    return;
  }

  if (!existsSync(PIPER_MODEL)) {
    ready = false;
    readinessError = `Piper model not found at ${PIPER_MODEL}`;
    console.warn(`[TTS] Piper disabled: ${readinessError}`);
    return;
  }

  sampleRate = parseSampleRate(PIPER_MODEL_CONFIG);
  ready = true;
  readinessError = '';
  console.log(`[TTS] Piper ready: model=${PIPER_MODEL}, sample_rate=${sampleRate}Hz`);
}

export async function synthesizeStream(text, { signal, onStart, onChunk, onEnd } = {}) {
  if (!ready) {
    throw new Error(readinessError || 'TTS model not loaded');
  }

  const chunks = splitTextIntoChunks(text);
  if (chunks.length === 0) {
    onEnd?.({ chunkCount: 0 });
    return { chunkCount: 0 };
  }

  const args = ['--model', PIPER_MODEL, '--output-raw'];
  if (PIPER_SPEAKER != null && `${PIPER_SPEAKER}`.trim() !== '') {
    args.push('--speaker', `${PIPER_SPEAKER}`.trim());
  }

  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    let chunkCount = 0;
    let pcmRemainder = null;

    const finish = (err = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abortHandler);
      if (err) {
        reject(err);
        return;
      }
      onEnd?.({ chunkCount });
      resolve({ chunkCount });
    };

    const abortHandler = () => {
      const error = new Error('TTS synthesis aborted');
      error.name = 'AbortError';
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000).unref();
      }
      finish(error);
    };

    if (signal?.aborted) {
      abortHandler();
      return;
    }

    signal?.addEventListener('abort', abortHandler, { once: true });

    child.once('spawn', () => {
      onStart?.({
        sampleRate,
        channels: 1,
        format: 's16le',
        textChunkCount: chunks.length,
      });

      for (const piece of chunks) {
        child.stdin.write(`${piece}\n`);
      }
      child.stdin.end();
    });

    child.stdout.on('data', (data) => {
      let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (pcmRemainder?.length) {
        buffer = Buffer.concat([pcmRemainder, buffer]);
        pcmRemainder = null;
      }

      if (buffer.length % 2 !== 0) {
        pcmRemainder = buffer.subarray(buffer.length - 1);
        buffer = buffer.subarray(0, buffer.length - 1);
      }

      if (buffer.length === 0) return;
      chunkCount += 1;
      onChunk?.(buffer);
    });

    child.stderr.on('data', (data) => {
      const textChunk = data.toString();
      stderr += textChunk;
      const line = textChunk.trim();
      if (line) {
        console.log(`[TTS] Piper: ${line}`);
      }
    });

    child.on('error', (err) => {
      finish(err);
    });

    child.on('close', (code, signalCode) => {
      if (settled) return;

      if (pcmRemainder?.length) {
        const error = new Error('Received truncated PCM frame from Piper');
        finish(error);
        return;
      }

      if (code === 0) {
        finish();
        return;
      }

      const message = stderr.trim() || `Piper exited with code ${code ?? 'unknown'}${signalCode ? ` (${signalCode})` : ''}`;
      const error = new Error(message);
      finish(error);
    });
  });
}
