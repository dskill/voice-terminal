import { useState, useEffect, useRef, useCallback } from 'react';

export default function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [orchestrator, setOrchestrator] = useState('claude');
  const [supportedOrchestrators, setSupportedOrchestrators] = useState(['claude', 'claude-sonnet-4-6', 'codex']);
  const wsRef = useRef(null);
  const handlersRef = useRef({});
  const reconnectTimer = useRef(null);
  const sttPendingRef = useRef(new Map());

  const setHandler = useCallback((type, handler) => {
    handlersRef.current[type] = handler;
  }, []);

  const send = useCallback((type, payload = {}) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }, []);

  useEffect(() => {
    function connect() {
      const url = `wss://${location.host}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setIsConnected(true);
        send('get-orchestrator');
        send('get-history');
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const handler = handlersRef.current['tts-audio-data'];
          if (handler) handler(event.data);
          return;
        }

        const data = JSON.parse(event.data);

        if (data.type === 'session-status') {
          setSessionRunning(!!data.running);
          if (data.orchestrator) setOrchestrator(data.orchestrator);
          if (Array.isArray(data.supportedOrchestrators) && data.supportedOrchestrators.length > 0) {
            setSupportedOrchestrators(data.supportedOrchestrators);
          }
        } else if (data.type === 'session-init') {
          setSessionRunning(true);
          if (data.orchestrator) setOrchestrator(data.orchestrator);
        } else if (data.type === 'session-ended') {
          setSessionRunning(false);
          if (data.orchestrator) setOrchestrator(data.orchestrator);
        } else if (data.type === 'orchestrator-changed') {
          if (data.orchestrator) setOrchestrator(data.orchestrator);
          if (Array.isArray(data.supportedOrchestrators) && data.supportedOrchestrators.length > 0) {
            setSupportedOrchestrators(data.supportedOrchestrators);
          }
        }

        if (data.type === 'stt-result' && data.requestId) {
          const pending = sttPendingRef.current.get(data.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            sttPendingRef.current.delete(data.requestId);
            if (data.error) pending.reject(new Error(data.error));
            else pending.resolve(data.text || '');
            return;
          }
        }

        const handler = handlersRef.current[data.type];
        if (handler) handler(data);
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
      for (const [id, pending] of sttPendingRef.current.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('WebSocket closed'));
        sttPendingRef.current.delete(id);
      }
    };
  }, [send]);

  const startSession = useCallback(() => send('start-session'), [send]);
  const stopSession = useCallback(() => send('stop-session'), [send]);
  const restartSession = useCallback(() => send('restart-session'), [send]);
  const setSessionOrchestrator = useCallback((next) => send('set-orchestrator', { orchestrator: next }), [send]);
  const sendCommand = useCallback((transcript) => send('voice-command', { transcript }), [send]);
  const sendAudioForSTT = useCallback(async (blob) => {
    const requestId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const audioBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Unable to encode audio'));
          return;
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(new Error('Failed to read audio blob'));
      reader.readAsDataURL(blob);
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sttPendingRef.current.delete(requestId);
        reject(new Error('Transcription timed out'));
      }, 70000);

      sttPendingRef.current.set(requestId, { resolve, reject, timeout });
      const ok = send('transcribe-audio', {
        requestId,
        mimeType: blob.type || 'audio/webm',
        audioBase64
      });
      if (!ok) {
        clearTimeout(timeout);
        sttPendingRef.current.delete(requestId);
        reject(new Error('WebSocket is not connected'));
      }
    });
  }, [send]);

  const cancelRequest = useCallback(() => send('cancel-request'), [send]);
  const clearHistory = useCallback(() => send('clear-history'), [send]);
  const getHistory = useCallback(() => send('get-history'), [send]);
  const listTmuxSessions = useCallback(() => send('list-tmux-sessions'), [send]);
  const createTmuxSession = useCallback((kind) => send('create-tmux-session', { kind }), [send]);
  const summarizeTmuxSession = useCallback((sessionName) => send('summarize-tmux-session', { sessionName }), [send]);
  const setTTSEnabled = useCallback((enabled) => send('set-tts-enabled', { enabled: !!enabled }), [send]);

  return {
    isConnected,
    sessionRunning,
    orchestrator,
    supportedOrchestrators,
    send,
    setHandler,
    startSession,
    stopSession,
    restartSession,
    setSessionOrchestrator,
    sendCommand,
    sendAudioForSTT,
    cancelRequest,
    clearHistory,
    getHistory,
    listTmuxSessions,
    createTmuxSession,
    summarizeTmuxSession,
    setTTSEnabled,
  };
}
