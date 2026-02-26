import { pipeline } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Supertonic-TTS-ONNX';

let ttsInstance = null;
let speakerEmbeddings = null;
let ready = false;

export function isTTSReady() {
  return ready;
}

async function loadSpeakerEmbeddings() {
  if (speakerEmbeddings) return speakerEmbeddings;

  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/M1.bin`;
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
  });

  return {
    audio: result.audio,
    samplingRate: result.sampling_rate,
  };
}
