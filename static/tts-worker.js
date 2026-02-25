import { pipeline } from '@huggingface/transformers';

/**
 * Check if WebGPU is available
 */
async function isWebGPUAvailable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

/**
 * TTS Pipeline Factory
 */
class TTSPipelineFactory {
  static model_id = 'onnx-community/Supertonic-TTS-ONNX';
  static instance = null;

  static async getInstance(progress_callback = null) {
    if (!this.instance) {
      const useWebGPU = await isWebGPUAvailable();
      const device = useWebGPU ? 'webgpu' : 'wasm';
      console.log(`[TTS] Using device: ${device}`);

      this.instance = await pipeline(
        'text-to-speech',
        this.model_id,
        {
          device,
          progress_callback,
        }
      );
    }
    return this.instance;
  }
}

// Voice embeddings cache
let voiceEmbeddings = null;

/**
 * Load voice embeddings from HuggingFace
 */
async function loadVoiceEmbeddings() {
  if (voiceEmbeddings) return voiceEmbeddings;

  const VOICES_URL = `https://huggingface.co/${TTSPipelineFactory.model_id}/resolve/main/voices/`;

  const [maleData, femaleData] = await Promise.all([
    fetch(`${VOICES_URL}M1.bin`).then(r => r.arrayBuffer()),
    fetch(`${VOICES_URL}F1.bin`).then(r => r.arrayBuffer()),
  ]);

  voiceEmbeddings = {
    M1: new Float32Array(maleData),
    F1: new Float32Array(femaleData),
  };

  return voiceEmbeddings;
}

/**
 * Synthesize speech from text
 */
async function synthesize(text, voiceId = 'M1') {
  const tts = await TTSPipelineFactory.getInstance();
  const embeddings = await loadVoiceEmbeddings();

  const speakerEmbeddings = embeddings[voiceId] || embeddings.M1;

  self.postMessage({ status: 'generating' });

  try {
    const result = await tts(text, {
      speaker_embeddings: speakerEmbeddings,
      num_inference_steps: 10,
      speed: 1.05,
    });

    self.postMessage({
      status: 'complete',
      audio: result.audio,
      sampleRate: result.sampling_rate,
    });
  } catch (error) {
    self.postMessage({
      status: 'error',
      error: error.message,
    });
  }
}

/**
 * Load/warm up the model
 */
async function load() {
  self.postMessage({
    status: 'loading',
    data: 'Loading TTS model...',
  });

  try {
    const tts = await TTSPipelineFactory.getInstance((progress) => {
      self.postMessage(progress);
    });

    self.postMessage({
      status: 'loading',
      data: 'Warming up model...',
    });

    const embeddings = await loadVoiceEmbeddings();

    // Warm up with a short phrase
    await tts('Hello', {
      speaker_embeddings: embeddings.M1,
      num_inference_steps: 1,
      speed: 1.0,
    });

    self.postMessage({ status: 'ready' });
  } catch (error) {
    self.postMessage({
      status: 'error',
      error: error.message,
    });
  }
}

/**
 * Message handler
 */
self.addEventListener('message', async (e) => {
  const { type, text, voice } = e.data;

  switch (type) {
    case 'load':
      load();
      break;
    case 'synthesize':
      synthesize(text, voice || 'M1');
      break;
  }
});
