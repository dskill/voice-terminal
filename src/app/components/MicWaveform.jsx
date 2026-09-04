import React from 'react';

// Live spectrum ring drawn around the mic button.
//
// What this replaces: 18 DOM nodes whose heights all came from a single RMS
// scalar, shaped by a constant `Math.sin(i * 1.7)` so the ring *looked* varied
// while carrying exactly one number. It also drove a React state update on
// every animation frame, re-rendering the whole app at 60fps during recording.
//
// This version reads the analyser node directly inside its own rAF loop (no
// React state at all) and splits the signal into log-spaced bands across the
// speech range, so you can actually see the difference between a vowel, a
// sibilant, and room noise.

// Speech energy lives roughly between these; going lower just renders handling
// noise and mains hum, going higher renders hiss.
const MIN_HZ = 85;
const MAX_HZ = 5000;
const BANDS = 28;

// Fast attack / slow release: a syllable should snap the bar out and let it
// fall back, which is what reads as "responsive".
const ATTACK = 0.55;
const RELEASE = 0.14;

// The noise floor is tracked per band and allowed to fall instantly but rise
// only slowly, so the display adapts to a quiet room without a loud moment
// permanently desensitising it.
const FLOOR_RISE_DB_PER_FRAME = 0.08;
const MIN_DYNAMIC_RANGE_DB = 22;

// Sized so the longest bar plus its round cap stays inside the canvas:
// innerRadius + minBar + maxBar + barWidth/2 must stay under size/2 (72), or
// peaks clip flat against the edge.
const GEOMETRY = {
  size: 144,      // matches the -inset-8 box around the 80px button
  innerRadius: 44,
  minBar: 3,
  maxBar: 22,
  barWidth: 3,
};

function buildBands(sampleRate, binCount) {
  const nyquist = sampleRate / 2;
  const bands = [];
  for (let i = 0; i < BANDS; i += 1) {
    const lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / BANDS);
    const hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / BANDS);
    const loBin = Math.max(0, Math.min(binCount - 1, Math.floor((lo / nyquist) * binCount)));
    const hiBin = Math.max(loBin + 1, Math.min(binCount, Math.ceil((hi / nyquist) * binCount)));
    bands.push({ loBin, hiBin, centerHz: Math.sqrt(lo * hi) });
  }
  return bands;
}

export default function MicWaveform({ analyserRef, active }) {
  const canvasRef = React.useRef(null);
  const rafRef = React.useRef(null);

  React.useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return undefined;

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const { size } = GEOMETRY;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    let bands = null;
    let freqData = null;
    let timeData = null;
    let levels = new Float32Array(BANDS);
    let floors = null;
    let peakDb = -35;
    let smoothedRms = 0;
    let voicedFrames = 0;
    let cancelled = false;

    const frame = () => {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(frame);

      const analyser = analyserRef?.current;
      if (!analyser) {
        // Recording can start a frame or two before the graph exists; decay
        // what's on screen rather than snapping to zero.
        for (let i = 0; i < BANDS; i += 1) levels[i] *= 0.9;
        smoothedRms *= 0.9;
        draw(ctx2d, levels, smoothedRms, false);
        return;
      }

      if (!freqData || freqData.length !== analyser.frequencyBinCount) {
        freqData = new Float32Array(analyser.frequencyBinCount);
        timeData = new Uint8Array(analyser.fftSize);
        bands = buildBands(analyser.context.sampleRate, analyser.frequencyBinCount);
        floors = new Float32Array(BANDS).fill(-90);
        levels = new Float32Array(BANDS);
      }

      analyser.getFloatFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      // Overall amplitude, used for the glow and as a gate for voice activity.
      let sumSquares = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const centered = (timeData[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / timeData.length);
      smoothedRms += (Math.min(1, rms * 3.2) - smoothedRms) * (rms > smoothedRms ? 0.5 : 0.12);

      // Track the loudest band this frame so quiet speakers still fill the ring
      // while a shout doesn't clip every bar to the same maximum.
      let frameMaxDb = -140;
      const bandDb = new Float32Array(BANDS);
      for (let i = 0; i < BANDS; i += 1) {
        const { loBin, hiBin } = bands[i];
        // Average in the power domain; averaging decibels under-weights the
        // peaks that make speech legible.
        let power = 0;
        for (let bin = loBin; bin < hiBin; bin += 1) {
          power += Math.pow(10, freqData[bin] / 10);
        }
        const db = 10 * Math.log10(Math.max(power / (hiBin - loBin), 1e-12));
        bandDb[i] = db;
        if (db > frameMaxDb) frameMaxDb = db;

        if (db < floors[i]) floors[i] = db;
        else floors[i] = Math.min(db, floors[i] + FLOOR_RISE_DB_PER_FRAME);
      }

      peakDb = frameMaxDb > peakDb ? frameMaxDb : peakDb - 0.25;

      let voicedEnergy = 0;
      let voicedBands = 0;
      for (let i = 0; i < BANDS; i += 1) {
        const range = Math.max(MIN_DYNAMIC_RANGE_DB, peakDb - floors[i]);
        const norm = Math.max(0, Math.min(1, (bandDb[i] - floors[i]) / range));
        // Slight perceptual curve: linear normalised dB looks flat-topped.
        const shaped = Math.pow(norm, 0.75);
        levels[i] += (shaped - levels[i]) * (shaped > levels[i] ? ATTACK : RELEASE);

        const hz = bands[i].centerHz;
        if (hz >= 200 && hz <= 3000) {
          voicedEnergy += norm;
          voicedBands += 1;
        }
      }

      // Voice activity: sustained energy across the vocal bands, gated on
      // absolute level so a silent room's amplified noise floor doesn't read as
      // speech.
      const voiced = voicedBands > 0
        && (voicedEnergy / voicedBands) > 0.3
        && rms > 0.012;
      voicedFrames = voiced ? Math.min(8, voicedFrames + 1) : Math.max(0, voicedFrames - 1);

      draw(ctx2d, levels, smoothedRms, voicedFrames >= 3);
    };

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      ctx2d.clearRect(0, 0, size, size);
    };
  }, [active, analyserRef]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute -inset-8 w-36 h-36 pointer-events-none"
      aria-hidden="true"
    />
  );
}

function draw(ctx2d, levels, rms, voiced) {
  const { size, innerRadius, minBar, maxBar, barWidth } = GEOMETRY;
  const cx = size / 2;
  const cy = size / 2;

  ctx2d.clearRect(0, 0, size, size);

  // Baseline ring: shows the visualiser is live even in silence, which the old
  // version could not distinguish from "the mic isn't working".
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, innerRadius - 1.5, 0, Math.PI * 2);
  ctx2d.strokeStyle = voiced ? 'rgba(251,113,133,0.28)' : 'rgba(161,161,170,0.18)';
  ctx2d.lineWidth = 1;
  ctx2d.stroke();

  ctx2d.lineCap = 'round';
  ctx2d.lineWidth = barWidth;

  // Bands run low-to-high from the top down each side, mirrored, so the shape
  // stays symmetric and readable rather than looking like random noise.
  for (let i = 0; i < levels.length; i += 1) {
    const level = Math.max(0, Math.min(1, levels[i]));
    const length = minBar + level * maxBar;
    const spread = ((i + 0.5) / levels.length) * Math.PI;

    const alpha = voiced ? 0.45 + level * 0.55 : 0.25 + level * 0.35;
    ctx2d.strokeStyle = voiced
      ? `rgba(253,164,175,${alpha.toFixed(3)})`
      : `rgba(212,212,216,${alpha.toFixed(3)})`;
    ctx2d.shadowBlur = voiced ? 6 + level * 10 : 0;
    ctx2d.shadowColor = 'rgba(251,113,133,0.55)';

    for (const theta of [-Math.PI / 2 + spread, -Math.PI / 2 - spread]) {
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      ctx2d.beginPath();
      ctx2d.moveTo(cx + cos * innerRadius, cy + sin * innerRadius);
      ctx2d.lineTo(cx + cos * (innerRadius + length), cy + sin * (innerRadius + length));
      ctx2d.stroke();
    }
  }

  ctx2d.shadowBlur = 0;

  // Overall level as a soft halo, so loudness is legible at a glance from arm's
  // length on a phone.
  if (rms > 0.02) {
    const haloRadius = Math.min(size / 2 - 1, innerRadius + minBar + rms * (maxBar + 6));
    const gradient = ctx2d.createRadialGradient(cx, cy, innerRadius, cx, cy, haloRadius);
    gradient.addColorStop(0, 'rgba(244,63,94,0)');
    gradient.addColorStop(1, `rgba(244,63,94,${(0.12 * rms).toFixed(3)})`);
    ctx2d.fillStyle = gradient;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, haloRadius, 0, Math.PI * 2);
    ctx2d.fill();
  }
}
