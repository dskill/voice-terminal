import { useState, useRef, useCallback } from 'react';

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function pcm16ToFloat32(arrayBuffer) {
  const input = new Int16Array(arrayBuffer);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / 32768;
  }
  return output;
}

export default function useTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const requestIdRef = useRef(null);
  const sampleRateRef = useRef(22050);
  const nextStartTimeRef = useRef(0);
  const streamOpenRef = useRef(false);
  const scheduledSourcesRef = useRef(new Set());

  const unlock = useCallback(async () => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e) { /* ignore */ }
  }, []);

  const clearSpeakingIfIdle = useCallback(() => {
    if (!streamOpenRef.current && scheduledSourcesRef.current.size === 0) {
      setIsSpeaking(false);
    }
  }, []);

  const stop = useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.onended = null;
        source.stop();
      } catch (e) { /* ignore */ }
    }
    scheduledSourcesRef.current.clear();
    requestIdRef.current = null;
    streamOpenRef.current = false;
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
  }, []);

  const startStream = useCallback((meta) => {
    const nextRequestId = meta?.requestId || null;
    if (!nextRequestId) return;

    if (requestIdRef.current && requestIdRef.current !== nextRequestId) {
      stop();
    }

    requestIdRef.current = nextRequestId;
    sampleRateRef.current = Number(meta.sampleRate) || 22050;
    streamOpenRef.current = true;

    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime + 0.05);
    setIsSpeaking(true);
  }, [stop]);

  const enqueueChunk = useCallback((arrayBuffer, meta) => {
    if (!arrayBuffer || !meta?.requestId || meta.requestId !== requestIdRef.current) {
      return;
    }

    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') ctx.resume();

      const float32Array = pcm16ToFloat32(arrayBuffer);
      if (float32Array.length === 0) return;

      const sampleRate = Number(meta.sampleRate) || sampleRateRef.current || 22050;
      const audioBuffer = ctx.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const startTime = Math.max(nextStartTimeRef.current, ctx.currentTime + 0.03);
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      source.onended = () => {
        scheduledSourcesRef.current.delete(source);
        clearSpeakingIfIdle();
      };

      scheduledSourcesRef.current.add(source);
      setIsSpeaking(true);
      source.start(startTime);
    } catch (e) {
      console.error('[TTS] Playback error:', e);
      stop();
    }
  }, [clearSpeakingIfIdle, stop]);

  const endStream = useCallback((requestId) => {
    if (!requestId || requestId !== requestIdRef.current) return;
    streamOpenRef.current = false;
    clearSpeakingIfIdle();
  }, [clearSpeakingIfIdle]);

  return {
    isSpeaking,
    unlock,
    startStream,
    enqueueChunk,
    endStream,
    stop,
  };
}
