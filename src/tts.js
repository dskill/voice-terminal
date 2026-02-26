import { pipeline } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Supertonic-TTS-ONNX';
const VOICE = 'F2'; // Available: M1-M5, F1-F5
const NUM_INFERENCE_STEPS = 3; // Default 5, lower = faster (range 1-50)
const SPEED = 1.2; // Default 1.0, higher = faster speech (range 0.8-1.2)

let ttsInstance = null;
let speakerEmbeddings = null;
let ready = false;

export function isTTSReady() {
  return ready;
}

async function loadSpeakerEmbeddings() {
  if (speakerEmbeddings) return speakerEmbeddings;

  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${VOICE}.bin`;
  console.log('[TTS] Downloading speaker embeddings...');
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  speakerEmbeddings = new Float32Array(buffer);
  console.log(`[TTS] Speaker embeddings loaded (${speakerEmbeddings.length} floats)`);
  return speakerEmbeddings;
}

export async function loadTTSModel() {
  try {
    console.log('[TTS] Loading model:', MODEL_ID);

    const [pipe] = await Promise.all([
      pipeline('text-to-speech', MODEL_ID, {
        device: 'cpu',
        progress_callback: (progress) => {
          if (progress.status === 'download' || progress.status === 'progress') {
            const pct = progress.progress ? `${Math.round(progress.progress)}%` : '';
            console.log(`[TTS] ${progress.status}: ${progress.file || ''} ${pct}`);
          }
        },
      }),
      loadSpeakerEmbeddings(),
    ]);

    ttsInstance = pipe;
    console.log('[TTS] Model loaded, running warmup...');

    await ttsInstance('Hello', {
      speaker_embeddings: speakerEmbeddings,
      num_inference_steps: NUM_INFERENCE_STEPS,
      speed: SPEED,
    });

    ready = true;
    console.log('[TTS] Model ready');
  } catch (err) {
    console.error('[TTS] Failed to load model:', err);
  }
}

export async function synthesize(text) {
  if (!ttsInstance || !speakerEmbeddings) {
    throw new Error('TTS model not loaded');
  }

  const result = await ttsInstance(text, {
    speaker_embeddings: speakerEmbeddings,
    num_inference_steps: NUM_INFERENCE_STEPS,
    speed: SPEED,
  });

  return {
    audio: result.audio,
    samplingRate: result.sampling_rate,
  };
}
