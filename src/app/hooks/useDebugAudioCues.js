import { useCallback } from 'react';

let cueContext = null;

function getCueContext() {
  if (!cueContext) {
    cueContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return cueContext;
}

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

    master.connect(ctx.destination);
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

export default function useDebugAudioCues() {
  const unlock = useCallback(async () => {
    try {
      const ctx = getCueContext();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      // ignore
    }
  }, []);

  const playMicStart = useCallback(() => {
    // Soft ascending double tone.
    playTone({ startFreq: 520, endFreq: 760, type: 'sine', duration: 0.12, volume: 0.42, release: 0.12 });
    playTone({ startFreq: 720, endFreq: 980, type: 'sine', duration: 0.1, volume: 0.24, whenOffset: 0.025, release: 0.1 });
  }, []);

  const playMicStop = useCallback(() => {
    // Mirror of mic start: soft descending double tone.
    playTone({ startFreq: 980, endFreq: 720, type: 'sine', duration: 0.1, volume: 0.24, release: 0.1 });
    playTone({ startFreq: 760, endFreq: 520, type: 'sine', duration: 0.12, volume: 0.42, whenOffset: 0.02, release: 0.12 });
  }, []);

  const playTTSStart = useCallback(() => {
    // Brief warm low-pitched ping.
    playTone({ startFreq: 240, endFreq: 275, type: 'triangle', duration: 0.14, volume: 0.5, release: 0.14, warm: true });
  }, []);

  const playTTSStop = useCallback(() => {
    // Brief soft high-pitched ping.
    playTone({ startFreq: 1320, endFreq: 1180, type: 'sine', duration: 0.09, volume: 0.34, release: 0.09 });
  }, []);

  return {
    unlock,
    playMicStart,
    playMicStop,
    playTTSStart,
    playTTSStop,
  };
}
