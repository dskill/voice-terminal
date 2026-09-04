import { useCallback, useRef } from 'react';
import { getSharedAudioContext, getOutputNode, resumeSharedAudio } from '../audio/sharedContext';

// Shares the app's single AudioContext; a second one here counted against
// Safari's concurrent-context cap for no benefit.
function getCueContext() {
  return getSharedAudioContext();
}

// A cue is only useful if it marks something the user would otherwise miss.
// Per-token cues were tried and removed: Claude emits one `partial` per text
// delta, so a cue there fired several times a second for the length of every
// response and read as a constant clicking noise rather than as information.
// Everything below is either once-per-turn or explicitly throttled.
const TOOL_CUE_MIN_INTERVAL_MS = 900;
// Tool ids seen in this turn, so a tool reported at both start and completion
// (or re-broadcast on reconnect) doesn't cue twice.
const TOOL_ID_MEMORY = 64;

function playTone({
  startFreq,
  endFreq = startFreq,
  type = 'sine',
  duration = 0.14,
  volume = 1,
  attack = 0.006,
  release = 0.12,
  whenOffset = 0,
  warm = false,
}) {
  try {
    const ctx = getCueContext();
    if (ctx.state === 'suspended') return;

    const now = ctx.currentTime + Math.max(0, whenOffset);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const master = ctx.createGain();

    master.gain.value = 0.045; // subtle debug level
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(40, startFreq), now);
    osc.frequency.linearRampToValueAtTime(Math.max(40, endFreq), now + duration);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(attack + 0.02, release));

    if (warm) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(1200, now);
      lowpass.Q.setValueAtTime(0.8, now);
      osc.connect(gain);
      gain.connect(lowpass);
      lowpass.connect(master);
    } else {
      osc.connect(gain);
      gain.connect(master);
    }

    master.connect(getOutputNode());
    osc.start(now);
    osc.stop(now + duration);

    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
        master.disconnect();
      } catch {
        // ignore cleanup errors
      }
    };
  } catch {
    // ignore cue failures; cues are best-effort debug aids
  }
}

// `enabled` follows the app's mute control. Cues used to play regardless of it,
// so muting audio silenced speech but left the interface chirping.
export default function useDebugAudioCues(enabled = true) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const lastToolCueAtRef = useRef(0);
  const cuedToolIdsRef = useRef([]);
  const turnCuedRef = useRef(false);

  const cue = useCallback((fn) => {
    if (!enabledRef.current) return;
    fn();
  }, []);

  const unlock = useCallback(async () => {
    try {
      await resumeSharedAudio('debug-cues');
    } catch {
      // ignore
    }
  }, []);

  const playMicStart = useCallback(() => {
    // Soft ascending double tone.
    cue(() => {
      playTone({ startFreq: 520, endFreq: 760, type: 'sine', duration: 0.12, volume: 0.42, release: 0.12 });
      playTone({ startFreq: 720, endFreq: 980, type: 'sine', duration: 0.1, volume: 0.24, whenOffset: 0.025, release: 0.1 });
    });
  }, [cue]);

  const playMicStop = useCallback(() => {
    // Mirror of mic start: soft descending double tone.
    cue(() => {
      playTone({ startFreq: 980, endFreq: 720, type: 'sine', duration: 0.1, volume: 0.24, release: 0.1 });
      playTone({ startFreq: 760, endFreq: 520, type: 'sine', duration: 0.12, volume: 0.42, whenOffset: 0.02, release: 0.12 });
    });
  }, [cue]);

  const playTTSStart = useCallback(() => {
    // Brief warm low-pitched ping.
    cue(() => playTone({ startFreq: 240, endFreq: 275, type: 'triangle', duration: 0.14, volume: 0.5, release: 0.14, warm: true }));
  }, [cue]);

  const playTTSStop = useCallback(() => {
    // Brief soft high-pitched ping.
    cue(() => playTone({ startFreq: 1320, endFreq: 1180, type: 'sine', duration: 0.09, volume: 0.34, release: 0.09 }));
  }, [cue]);

  // One chime per notification, however many completions the poll reports at
  // once. The tmux broker counts a completion on every working -> quiet
  // transition, so a bursty pane could deliver a delta of 3 and fire a
  // three-chime volley for what the user experiences as one event.
  const playSessionComplete = useCallback(() => {
    cue(() => {
      playTone({ startFreq: 740, endFreq: 920, type: 'triangle', duration: 0.12, volume: 0.34, release: 0.12, warm: true });
      playTone({ startFreq: 920, endFreq: 1180, type: 'sine', duration: 0.11, volume: 0.22, release: 0.1, whenOffset: 0.03 });
    });
  }, [cue]);

  // Marks the moment a response begins, replacing the old per-chunk cue. Fires
  // at most once per turn; `beginTurn` reopens it.
  const playResponseStart = useCallback(() => {
    if (turnCuedRef.current) return;
    turnCuedRef.current = true;
    cue(() => playTone({ startFreq: 620, endFreq: 820, type: 'sine', duration: 0.08, volume: 0.16, attack: 0.004, release: 0.08, warm: true }));
  }, [cue]);

  const beginTurn = useCallback(() => {
    turnCuedRef.current = false;
    cuedToolIdsRef.current = [];
  }, []);

  // Deduplicated by tool id and rate-limited, so a burst of parallel tool calls
  // is one tick rather than a rattle.
  const playToolDispatch = useCallback((toolId) => {
    const key = toolId == null ? null : String(toolId);
    if (key) {
      if (cuedToolIdsRef.current.includes(key)) return;
      cuedToolIdsRef.current.push(key);
      if (cuedToolIdsRef.current.length > TOOL_ID_MEMORY) cuedToolIdsRef.current.shift();
    }

    const nowMs = Date.now();
    if ((nowMs - lastToolCueAtRef.current) < TOOL_CUE_MIN_INTERVAL_MS) return;
    lastToolCueAtRef.current = nowMs;

    cue(() => playTone({ startFreq: 1620, endFreq: 1340, type: 'square', duration: 0.035, volume: 0.08, attack: 0.001, release: 0.035 }));
  }, [cue]);

  return {
    unlock,
    beginTurn,
    playMicStart,
    playMicStop,
    playTTSStart,
    playTTSStop,
    playSessionComplete,
    playToolDispatch,
    playResponseStart,
  };
}
