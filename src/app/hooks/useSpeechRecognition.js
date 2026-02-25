import { useState, useRef, useCallback, useEffect } from 'react';

export default function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      transcriptRef.current = text;
      setTranscript(text);
    };

    recognition.onstart = () => {
      transcriptRef.current = '';
      setTranscript('');
      setError(null);
    };

    recognition.onerror = (event) => {
      console.log('Speech recognition error:', event.error);
      setError(event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) return false;
    setIsListening(true);
    setTranscript('');
    transcriptRef.current = '';
    recognitionRef.current.start();
    return true;
  }, []);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return '';
    recognitionRef.current.stop();
    setIsListening(false);
    return transcriptRef.current;
  }, []);

  const isSupported = typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  return {
    isListening,
    transcript,
    error,
    isSupported,
    startListening,
    stopListening,
  };
}
