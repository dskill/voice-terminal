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
  const [audioContextState, setAudioContextState] = useState(audioCtx ? audioCtx.state : 'uninitialized');
  const [audioIssue, setAudioIssue] = useState('');
  const requestIdRef = useRef(null);
  const sampleRateRef = useRef(22050);
  const nextStartTimeRef = useRef(0);
  const streamOpenRef = useRef(false);
  const scheduledSourcesRef = useRef(new Set());
  const stateListenerAttachedRef = useRef(false);
  const playedChunkInStreamRef = useRef(false);

  const bindContextStateListener = useCallback((ctx) => {
    if (!ctx || stateListenerAttachedRef.current) return;
    stateListenerAttachedRef.current = true;
    setAudioContextState(ctx.state);
    console.log(`[TTS] AudioContext initial state: ${ctx.state}`);
    ctx.addEventListener('statechange', () => {
      console.log(`[TTS] AudioContext state changed: ${ctx.state}`);
      setAudioContextState(ctx.state);
      if (ctx.state !== 'running') {
        setAudioIssue(`AudioContext is ${ctx.state}`);
      }
    });
  }, []);

  const getOrCreateContext = useCallback((reason = 'unspecified') => {
    const hadContext = !!audioCtx;
    const ctx = getAudioContext();
    if (!hadContext) {
      console.log(`[TTS] AudioContext created (${reason})`);
    }
    bindContextStateListener(ctx);
    return ctx;
  }, [bindContextStateListener]);

  const ensureAudioContextRunning = useCallback(async (reason = 'unspecified') => {
    const ctx = getOrCreateContext(reason);
    console.log(`[TTS] ensure running requested (${reason}), current=${ctx.state}`);
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
        console.log(`[TTS] resume resolved (${reason}), now=${ctx.state}`);
      } catch (e) {
        console.warn(`[TTS] resume rejected (${reason}):`, e);
      }
    }
    setAudioContextState(ctx.state);
    return ctx;
  }, [getOrCreateContext]);

  const unlock = useCallback(async () => {
    try {
      const ctx = await ensureAudioContextRunning('unlock');
      if (ctx.state === 'running') {
        setAudioIssue('');
      }
      return ctx.state === 'running';
    } catch (e) { /* ignore */ }
    return false;
  }, [ensureAudioContextRunning]);

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
    playedChunkInStreamRef.current = false;

    const ctx = getOrCreateContext('startStream');
    if (ctx.state !== 'running') {
      ensureAudioContextRunning('startStream').catch(() => {});
      setAudioIssue(`AudioContext is ${ctx.state}; tap "enable audio"`);
    }
    nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime + 0.05);
    setIsSpeaking(true);
  }, [stop, getOrCreateContext, ensureAudioContextRunning]);

  const enqueueChunk = useCallback((arrayBuffer, meta) => {
    if (!arrayBuffer || !meta?.requestId || meta.requestId !== requestIdRef.current) {
      return;
    }

    try {
      const ctx = getOrCreateContext('enqueueChunk');
      if (ctx.state !== 'running') {
        console.warn(`[TTS] Skipping chunk playback because AudioContext is ${ctx.state}`);
        setAudioIssue(`Skipped audio chunk (${ctx.state})`);
        return;
      }

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
      playedChunkInStreamRef.current = true;
      setAudioIssue('');
      source.start(startTime);
    } catch (e) {
      console.error('[TTS] Playback error:', e);
      setAudioIssue(`Playback error: ${e?.message || 'unknown'}`);
      stop();
    }
  }, [clearSpeakingIfIdle, stop, getOrCreateContext]);

  const endStream = useCallback((requestId) => {
    if (!requestId || requestId !== requestIdRef.current) return;
    streamOpenRef.current = false;
    if (!playedChunkInStreamRef.current) {
      setAudioIssue('No audio frames played for latest response');
    }
    clearSpeakingIfIdle();
  }, [clearSpeakingIfIdle]);

  const playEnableCue = useCallback(async () => {
    try {
      const ctx = await ensureAudioContextRunning();
      if (ctx.state !== 'running') {
        setAudioIssue(`AudioContext is ${ctx.state}`);
        return false;
      }

      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      gain.connect(ctx.destination);

      const toneA = ctx.createOscillator();
      toneA.type = 'sine';
      toneA.frequency.setValueAtTime(660, now);
      toneA.connect(gain);
      toneA.start(now);
      toneA.stop(now + 0.09);

      const toneB = ctx.createOscillator();
      toneB.type = 'sine';
      toneB.frequency.setValueAtTime(880, now + 0.09);
      toneB.connect(gain);
      toneB.start(now + 0.09);
      toneB.stop(now + 0.18);

      toneB.onended = () => {
        try {
          gain.disconnect();
        } catch (e) { /* ignore */ }
      };
      setAudioIssue('');
      return true;
    } catch (e) {
      console.warn('[TTS] Failed to play enable cue:', e);
      setAudioIssue(`Enable cue failed: ${e?.message || 'unknown'}`);
      return false;
    }
  }, [ensureAudioContextRunning]);

  return {
    isSpeaking,
    audioContextState,
    isAudioUnlocked: audioContextState === 'running',
    audioIssue,
    unlock,
    startStream,
    enqueueChunk,
    endStream,
    playEnableCue,
    stop,
  };
}
