import { useState, useRef, useCallback, useEffect } from 'react';

export default function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const stopResolveRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const rafIdRef = useRef(null);
  const dataArrayRef = useRef(null);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
      if (analyserRef.current) analyserRef.current.disconnect();
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  const stopAudioMeter = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    dataArrayRef.current = null;
    setAudioLevel(0);
  }, []);

  const startAudioMeter = useCallback(async (stream) => {
    stopAudioMeter();

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    audioContextRef.current = ctx;
    sourceNodeRef.current = source;
    analyserRef.current = analyser;
    dataArrayRef.current = dataArray;

    const tick = () => {
      if (!analyserRef.current || !dataArrayRef.current) return;
      analyserRef.current.getByteTimeDomainData(dataArrayRef.current);

      let sum = 0;
      for (let i = 0; i < dataArrayRef.current.length; i++) {
        const centered = (dataArrayRef.current[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / dataArrayRef.current.length);
      const normalized = Math.min(1, Math.max(0, rms * 4));
      setAudioLevel(normalized);

      rafIdRef.current = requestAnimationFrame(tick);
    };

    tick();
  }, [stopAudioMeter]);

  const startListening = useCallback(async () => {
    if (!isSupported) return false;
    if (isListening) return true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      await startAudioMeter(stream);

      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4'
      ];
      const supportedMime = mimeCandidates.find((mime) =>
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported(mime)
      );

      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      setError(null);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        const msg = event?.error?.message || 'audio-capture-error';
        setError(msg);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
        }
        stopAudioMeter();

        if (stopResolveRef.current) {
          stopResolveRef.current(blob);
          stopResolveRef.current = null;
        }
        setIsListening(false);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
      return true;
    } catch (err) {
      stopAudioMeter();
      setError(err?.message || 'microphone-access-denied');
      setIsListening(false);
      return false;
    }
  }, [isListening, startAudioMeter, stopAudioMeter]);

  const stopListening = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return null;

    if (recorder.state === 'inactive') {
      return new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    }

    return new Promise((resolve) => {
      stopResolveRef.current = resolve;
      recorder.stop();
      setIsListening(false);
    });
  }, []);

  const isSupported = typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof MediaRecorder !== 'undefined';

  return {
    isListening,
    error,
    audioLevel,
    isSupported,
    startListening,
    stopListening,
  };
}
