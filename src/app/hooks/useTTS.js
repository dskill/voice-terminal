import { useState, useRef, useCallback } from 'react';

// Lazy-init shared AudioContext
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

export default function useTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const sourceRef = useRef(null);

  const unlock = useCallback(async () => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e) { /* ignore */ }
  }, []);

  const playAudio = useCallback((float32Array, sampleRate) => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') ctx.resume();

      const audioBuffer = ctx.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      setIsSpeaking(true);
      sourceRef.current = source;

      source.onended = () => {
        setIsSpeaking(false);
        sourceRef.current = null;
      };

      source.start();
    } catch (e) {
      console.error('[TTS] Playback error:', e);
      setIsSpeaking(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) { /* ignore */ }
      sourceRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  return { isSpeaking, playAudio, unlock, stop };
}
