import { useState, useRef, useCallback, useEffect } from 'react';
import { getSharedAudioContext } from '../audio/sharedContext';

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
      // Never close the context here — it is shared with TTS playback.
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
    // The context is shared with playback, so only drop our reference to it —
    // closing it here used to tear down TTS output too, and the per-recording
    // create/close churn counted against Safari's concurrent-context cap.
    audioContextRef.current = null;
    dataArrayRef.current = null;
    setAudioLevel(0);
  }, []);

  // Stopping every track is what releases the microphone. While any capture
  // track stays live, iOS holds the audio session in playAndRecord mode, which
  // routes playback to the earpiece instead of the main speaker.
  const releaseStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const startAudioMeter = useCallback(async (stream) => {
    stopAudioMeter();

    const ctx = getSharedAudioContext();
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
        // A failed recorder never fires onstop, so release the mic here or the
        // capture track stays live for the rest of the page's life.
        releaseStream();
        stopAudioMeter();
        setIsListening(false);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        releaseStream();
        stopAudioMeter();

        if (stopResolveRef.current) {
          stopResolveRef.current(blob);
          stopResolveRef.current = null;
        }
        setIsListening(false);
      };

      mediaRecorderRef.current = recorder;
      // Emit every 250ms. Without a timeslice the recorder holds the entire
      // recording in one blob until stop(), so backgrounding the app mid-record
      // on iOS loses the whole utterance instead of the last fragment.
      recorder.start(250);
      setIsListening(true);
      return true;
    } catch (err) {
      // getUserMedia may have succeeded before this threw (e.g. an unsupported
      // MediaRecorder mime type), which would strand a live capture track.
      releaseStream();
      stopAudioMeter();
      setError(err?.message || 'microphone-access-denied');
      setIsListening(false);
      return false;
    }
  }, [isListening, startAudioMeter, stopAudioMeter, releaseStream]);

  const stopListening = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return null;

    if (recorder.state === 'inactive') {
      // onstop never ran for this recorder, so nothing has released the mic.
      releaseStream();
      stopAudioMeter();
      return new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    }

    return new Promise((resolve) => {
      stopResolveRef.current = resolve;
      recorder.stop();
      setIsListening(false);
    });
  }, [releaseStream, stopAudioMeter]);

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
