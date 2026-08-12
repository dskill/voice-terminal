import { useState, useRef, useCallback } from 'react';
import {
  getSharedAudioContext,
  getOutputNode,
  attachElementSink,
  resumeSharedAudio,
} from '../audio/sharedContext';

// Chunks that arrive while the context is suspended are held here rather than
// dropped, so a response that starts during a screen lock still plays on
// resume. Bounded so a context that never resumes can't grow this without end.
const MAX_PENDING_CHUNKS = 64;

let audioCtx = null;
function getAudioContext() {
  audioCtx = getSharedAudioContext();
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
  const pendingChunksRef = useRef([]);
  const wasSuspendedRef = useRef(false);
  // Assigned below once flushPendingChunks exists, so the statechange listener
  // and the resume path can both reach it without depending on declaration order.
  const flushPendingRef = useRef(null);

  const bindContextStateListener = useCallback((ctx) => {
    if (!ctx || stateListenerAttachedRef.current) return;
    stateListenerAttachedRef.current = true;
    setAudioContextState(ctx.state);
    console.log(`[TTS] AudioContext initial state: ${ctx.state}`);
    ctx.addEventListener('statechange', () => {
      console.log(`[TTS] AudioContext state changed: ${ctx.state}`);
      setAudioContextState(ctx.state);
      if (ctx.state !== 'running') {
        wasSuspendedRef.current = true;
        setAudioIssue(`AudioContext is ${ctx.state}`);
      } else {
        // Back from a suspension: play anything that arrived meanwhile.
        flushPendingRef.current?.();
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
      await resumeSharedAudio(reason);
      console.log(`[TTS] resume resolved (${reason}), now=${ctx.state}`);
    }
    setAudioContextState(ctx.state);
    if (ctx.state === 'running') flushPendingRef.current?.();
    return ctx;
  }, [getOrCreateContext]);

  const unlock = useCallback(async () => {
    try {
      const ctx = await ensureAudioContextRunning('unlock');
      if (ctx.state === 'running') {
        // Called from a user gesture, which is the only moment iOS lets us
        // start the element sink that bypasses the silent switch.
        await attachElementSink();
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
    pendingChunksRef.current = [];
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

  const scheduleBuffer = useCallback((arrayBuffer, meta, ctx) => {
    const float32Array = pcm16ToFloat32(arrayBuffer);
    if (float32Array.length === 0) return;

    const sampleRate = Number(meta.sampleRate) || sampleRateRef.current || 22050;
    const audioBuffer = ctx.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.copyToChannel(float32Array, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    // Not ctx.destination: getOutputNode() routes through the element sink when
    // one is active, so playback ignores the iOS silent switch.
    source.connect(getOutputNode());

    // ctx.currentTime freezes while suspended, so a start time computed before
    // a suspension is stale on resume — queued audio would either fire in one
    // burst or be scheduled far into the future. Rebase after any suspension.
    if (wasSuspendedRef.current) {
      nextStartTimeRef.current = 0;
      wasSuspendedRef.current = false;
    }

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
  }, [clearSpeakingIfIdle]);

  const flushPendingChunks = useCallback(() => {
    const pending = pendingChunksRef.current;
    if (pending.length === 0) return;
    const ctx = getOrCreateContext('flushPending');
    if (ctx.state !== 'running') return;

    pendingChunksRef.current = [];
    console.log(`[TTS] Flushing ${pending.length} buffered chunk(s) after resume`);
    for (const item of pending) {
      // Drop anything belonging to a response the user has moved past.
      if (item.meta.requestId !== requestIdRef.current) continue;
      try {
        scheduleBuffer(item.arrayBuffer, item.meta, ctx);
      } catch (e) {
        console.error('[TTS] Failed to play buffered chunk:', e);
      }
    }
  }, [getOrCreateContext, scheduleBuffer]);

  flushPendingRef.current = flushPendingChunks;

  const enqueueChunk = useCallback((arrayBuffer, meta) => {
    if (!arrayBuffer || !meta?.requestId || meta.requestId !== requestIdRef.current) {
      return;
    }

    try {
      const ctx = getOrCreateContext('enqueueChunk');
      if (ctx.state !== 'running') {
        // Hold rather than discard: iOS suspends the context on screen lock and
        // route changes, and dropping here is what produced "No audio frames
        // played for latest response" for an entire reply.
        if (pendingChunksRef.current.length < MAX_PENDING_CHUNKS) {
          pendingChunksRef.current.push({ arrayBuffer, meta });
        }
        setAudioIssue(`Audio paused (${ctx.state}) — buffering`);
        ensureAudioContextRunning('enqueueChunk').catch(() => {});
        return;
      }

      scheduleBuffer(arrayBuffer, meta, ctx);
    } catch (e) {
      console.error('[TTS] Playback error:', e);
      setAudioIssue(`Playback error: ${e?.message || 'unknown'}`);
      stop();
    }
  }, [stop, getOrCreateContext, scheduleBuffer, ensureAudioContextRunning]);

  const endStream = useCallback((requestId) => {
    if (!requestId || requestId !== requestIdRef.current) return;
    streamOpenRef.current = false;
    if (!playedChunkInStreamRef.current && pendingChunksRef.current.length === 0) {
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
      gain.connect(getOutputNode());

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
