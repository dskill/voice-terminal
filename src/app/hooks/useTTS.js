import { useState, useRef, useCallback, useEffect } from 'react';

export default function useTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const unlockedRef = useRef(false);
  const voicesReadyRef = useRef(false);

  // Wait for voices to be available (Chrome loads them async)
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

  const unlock = useCallback(() => {
    if (unlockedRef.current || !('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    speechSynthesis.speak(utterance);
    unlockedRef.current = true;
    console.log('[TTS] Audio unlocked');
  }, []);

  const speak = useCallback((text) => {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        console.warn('[TTS] speechSynthesis not available');
        resolve();
        return;
      }

      if (!text) {
        console.warn('[TTS] No text to speak');
        resolve();
        return;
      }

      console.log('[TTS] Speaking:', text);

      speechSynthesis.cancel();
      setIsSpeaking(true);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      let resolved = false;
      let pollInterval = null;

      const done = (reason) => {
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          setIsSpeaking(false);
          console.log('[TTS] Done:', reason || 'unknown');
          resolve();
        }
      };

      utterance.onend = () => done('onend');
      utterance.onerror = (e) => {
        console.error('[TTS] Error:', e.error, e);
        done('error: ' + e.error);
      };

      // Timeout fallback
      const wordCount = text.split(/\s+/).length;
      const timeout = Math.max(5000, wordCount * 200 + 3000);
      setTimeout(() => done('timeout'), timeout);

      // Delay after cancel, then speak and start polling
      setTimeout(() => {
        speechSynthesis.speak(utterance);
        console.log('[TTS] utterance queued, speaking:', speechSynthesis.speaking, 'pending:', speechSynthesis.pending);

        // Start polling AFTER speak() is called to avoid race condition
        pollInterval = setInterval(() => {
          if (!speechSynthesis.speaking && !speechSynthesis.pending) {
            done('poll');
          }
        }, 300);
      }, 150);
    });
  }, []);

  const stop = useCallback(() => {
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, []);

  return { isSpeaking, speak, stop, unlock };
}
