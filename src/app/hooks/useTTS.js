import { useState, useRef, useCallback, useEffect } from 'react';

// Lazy-init shared AudioContext
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// Play a short tone — freq in Hz, duration in seconds
function playTone(freq, duration, volume = 0.3) {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = volume;
    gain.gain.setTargetAtTime(0, ctx.currentTime + duration * 0.7, 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    console.warn('[TTS] Tone failed:', e);
  }
}

function playStartSound() {
  playTone(440, 0.1, 0.2);
  setTimeout(() => playTone(660, 0.12, 0.2), 100);
}

function playEndSound() {
  playTone(660, 0.1, 0.15);
  setTimeout(() => playTone(440, 0.12, 0.15), 100);
}

export default function useTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pendingText, setPendingText] = useState(null);
  const [debug, setDebug] = useState('init');
  const unlockedRef = useRef(false);
  const voicesReadyRef = useRef(false);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    function checkVoices() {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        voicesReadyRef.current = true;
        console.log('[TTS] Voices loaded:', voices.length);
      }
    }
    checkVoices();
    speechSynthesis.addEventListener('voiceschanged', checkVoices);
    return () => speechSynthesis.removeEventListener('voiceschanged', checkVoices);
  }, []);

  const unlock = useCallback(async () => {
    if (unlockedRef.current || !('speechSynthesis' in window)) return;
    try {
      if (audioCtx) {
        await audioCtx.resume();
      } else {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
      }
    } catch (e) { /* ignore */ }
    unlockedRef.current = true;
    setDebug(`unlocked | ctx:${audioCtx?.state} | voices:${speechSynthesis.getVoices().length}`);
  }, []);

  // Called from async context (WebSocket handler) — queues text for user-gesture playback
  const speak = useCallback((text) => {
    return new Promise((resolve) => {
      if (!text || !('speechSynthesis' in window)) {
        resolve();
        return;
      }
      // First try speaking directly (works on desktop, may fail on iOS)
      setIsSpeaking(true);
      playStartSound();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      let resolved = false;
      let pollInterval = null;
      let speechStarted = false;

      const done = (reason) => {
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          setIsSpeaking(false);
          playEndSound();
          setDebug(`done: ${reason}`);
          resolve();
        }
      };

      utterance.onstart = () => { speechStarted = true; };
      utterance.onend = () => done('onend');
      utterance.onerror = (e) => {
        setDebug(`ERROR: ${e.error}`);
        // If speech was blocked, queue for user-gesture playback
        if (!speechStarted) {
          setPendingText(text);
          setDebug(`queued for tap | ${e.error}`);
        }
        done('error: ' + e.error);
      };

      speechSynthesis.speak(utterance);
      setDebug(`queued | speaking:${speechSynthesis.speaking} pending:${speechSynthesis.pending}`);

      // After 1.5s, if speech hasn't started, it's probably blocked on iOS
      setTimeout(() => {
        if (!speechStarted && !resolved) {
          setPendingText(text);
          setDebug('blocked on iOS — tap to hear');
          done('blocked');
        }
      }, 1500);

      // Timeout fallback
      const wordCount = text.split(/\s+/).length;
      const timeout = Math.max(8000, wordCount * 200 + 3000);
      setTimeout(() => done('timeout'), timeout);

      pollInterval = setInterval(() => {
        if (!speechSynthesis.speaking && !speechSynthesis.pending && speechStarted) {
          done('poll');
        }
      }, 300);
    });
  }, []);

  // Called from a user gesture (tap) — speaks the pending text
  const speakNow = useCallback((text) => {
    const toSpeak = text || pendingText;
    if (!toSpeak) return;
    setPendingText(null);
    setIsSpeaking(true);
    playStartSound();
    setDebug('speaking from tap...');

    if (speechSynthesis.speaking) speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(toSpeak);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => {
      setIsSpeaking(false);
      playEndSound();
      setDebug('done: tap-onend');
    };
    utterance.onerror = (e) => {
      setIsSpeaking(false);
      setDebug(`tap ERROR: ${e.error}`);
    };

    speechSynthesis.speak(utterance);
  }, [pendingText]);

  const stop = useCallback(() => {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    setIsSpeaking(false);
    setPendingText(null);
  }, []);

  return { isSpeaking, pendingText, speak, speakNow, stop, unlock, debug };
}
