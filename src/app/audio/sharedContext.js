// One AudioContext for the whole app, plus the output node everything should
// connect to.
//
// Two iOS behaviours drive this module:
//
// 1. Safari caps the number of concurrent AudioContexts (historically 4) and
//    close() is asynchronous, so creating one per recording — as the mic meter
//    used to — can exhaust the pool. New contexts then fail to construct or
//    come up permanently suspended, which reads as "audio randomly stopped
//    working until I reloaded".
//
// 2. Raw Web Audio output (ctx.destination) is governed by the ringer/silent
//    switch. Routing the graph through a MediaStreamDestination into an
//    <audio playsinline> element instead moves playback onto the media-element
//    audio session, which ignores the silent switch and prefers the main
//    speaker over the earpiece.
//
// The element sink is best-effort: if it can't be created or the element
// refuses to play, we fall back to ctx.destination and the app still works.
// Set localStorage['voice-terminal-audio-sink'] = 'direct' to force the old
// behaviour if the element sink ever misbehaves on a given device.

// Piper emits 22050 Hz. Constructing the context at that rate lets the OS
// resample the whole stream once, instead of resampling every chunk buffer
// independently with fresh filter state (which ticks at chunk boundaries).
const PREFERRED_SAMPLE_RATE = 22050;
const SINK_PREF_KEY = 'voice-terminal-audio-sink';

let ctx = null;
let elementSink = null; // { dest, el }
let sinkAttemptPromise = null;

function readSinkPreference() {
  try {
    return localStorage.getItem(SINK_PREF_KEY) === 'direct' ? 'direct' : 'element';
  } catch {
    return 'element';
  }
}

export function getSharedAudioContext() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    try {
      ctx = new Ctor({ sampleRate: PREFERRED_SAMPLE_RATE });
    } catch {
      // Some browsers reject an explicit rate; the default is still usable.
      ctx = new Ctor();
    }
    console.log(`[audio] AudioContext created at ${ctx.sampleRate}Hz`);
  }
  return ctx;
}

// Everything that makes sound should connect here rather than ctx.destination,
// so playback follows whichever sink is active.
export function getOutputNode() {
  const context = getSharedAudioContext();
  return elementSink ? elementSink.dest : context.destination;
}

export function isElementSinkActive() {
  return !!elementSink;
}

// Must be called from a user gesture — the element's play() needs one on iOS.
// Safe to call repeatedly; only the first successful attach does work.
export async function attachElementSink() {
  if (elementSink) return true;
  if (readSinkPreference() === 'direct') return false;
  if (sinkAttemptPromise) return sinkAttemptPromise;

  sinkAttemptPromise = (async () => {
    const context = getSharedAudioContext();
    if (typeof context.createMediaStreamDestination !== 'function') return false;

    let el;
    try {
      const dest = context.createMediaStreamDestination();
      el = document.createElement('audio');
      // playsinline keeps iOS from trying to take over the screen; the element
      // is never displayed, it exists purely as an audio sink.
      el.setAttribute('playsinline', '');
      el.setAttribute('aria-hidden', 'true');
      el.autoplay = true;
      el.muted = false;
      el.volume = 1;
      el.style.display = 'none';
      el.srcObject = dest.stream;
      document.body.appendChild(el);

      await el.play();
      elementSink = { dest, el };
      console.log('[audio] element sink active (bypasses the iOS silent switch)');
      return true;
    } catch (e) {
      console.warn('[audio] element sink unavailable, using ctx.destination:', e?.message || e);
      try { el?.remove(); } catch { /* ignore */ }
      return false;
    } finally {
      sinkAttemptPromise = null;
    }
  })();

  return sinkAttemptPromise;
}

// Resume after iOS suspends the context (backgrounding, screen lock, an
// incoming call, or an audio route change). Also nudges the sink element,
// which iOS pauses alongside the context.
export async function resumeSharedAudio(reason = 'unspecified') {
  const context = getSharedAudioContext();
  if (context.state !== 'running') {
    try {
      await context.resume();
    } catch (e) {
      console.warn(`[audio] resume rejected (${reason}):`, e?.message || e);
    }
  }
  if (elementSink?.el?.paused) {
    try {
      await elementSink.el.play();
    } catch { /* needs a fresh gesture; the next tap will get it */ }
  }
  return context.state === 'running';
}
