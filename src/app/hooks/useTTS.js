import { useState, useRef, useCallback } from 'react';

export default function useTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const unlockedRef = useRef(false);

  const unlock = useCallback(() => {
    if (unlockedRef.current || !('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance('');
    utterance.volume = 0;
    speechSynthesis.speak(utterance);
    unlockedRef.current = true;
  }, []);

  const speak = useCallback((text) => {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        resolve();
        return;
      }

      speechSynthesis.cancel();
      setIsSpeaking(true);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      let resolved = false;
      let pollInterval = null;

      const done = () => {
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          setIsSpeaking(false);
          resolve();
        }
      };

      utterance.onend = done;
      utterance.onerror = done;

      // Poll as fallback
      pollInterval = setInterval(() => {
        if (!speechSynthesis.speaking && !speechSynthesis.pending) done();
      }, 200);

      // Timeout fallback
      const wordCount = text.split(/\s+/).length;
      const timeout = Math.max(5000, wordCount * 200 + 3000);
      setTimeout(done, timeout);

      // Small delay after cancel
      setTimeout(() => speechSynthesis.speak(utterance), 100);
    });
  }, []);

  return { isSpeaking, speak, unlock };
}
