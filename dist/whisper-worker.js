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
 * Singleton ASR pipeline factory
 */
class ASRPipelineFactory {
  static model_id = 'onnx-community/whisper-tiny.en';
  static instance = null;

  static async getInstance(progress_callback = null) {
    if (!this.instance) {
      const useWebGPU = await isWebGPUAvailable();
      const device = useWebGPU ? 'webgpu' : 'wasm';
      console.log(`[Whisper] Using device: ${device}`);

      this.instance = await pipeline(
        'automatic-speech-recognition',
        this.model_id,
        {
          device,
          dtype: 'fp32',
          progress_callback,
        }
      );
    }
    return this.instance;
  }
}

/**
 * Transcribe audio
 */
async function transcribe(audioData) {
  const transcriber = await ASRPipelineFactory.getInstance();

  self.postMessage({ status: 'start' });

  try {
    const result = await transcriber(audioData, {
      return_timestamps: false,
      chunk_length_s: 30,
      stride_length_s: 5,
      callback_function: (chunk) => {
        if (chunk.text) {
          self.postMessage({
            status: 'update',
            text: chunk.text,
          });
        }
      },
    });

    self.postMessage({
      status: 'complete',
      text: result.text.trim(),
    });
  } catch (error) {
    self.postMessage({
      status: 'error',
      error: error.message,
    });
  }
}

/**
 * Load the model
 */
async function load() {
  self.postMessage({
    status: 'loading',
    data: 'Loading Whisper model...',
  });

  await ASRPipelineFactory.getInstance((progress) => {
    self.postMessage(progress);
  });

  self.postMessage({ status: 'ready' });
}

/**
 * Message handler
 */
self.addEventListener('message', async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'load':
      load();
      break;
    case 'transcribe':
      transcribe(data);
      break;
  }
});
