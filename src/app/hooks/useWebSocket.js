import { useState, useEffect, useRef, useCallback } from 'react';

export default function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [claudeRunning, setClaudeRunning] = useState(false);
  const [currentModel, setCurrentModel] = useState('');
  const wsRef = useRef(null);
  const handlersRef = useRef({});
  const reconnectTimer = useRef(null);

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
        // Binary messages are TTS audio data
        if (event.data instanceof ArrayBuffer) {
          const handler = handlersRef.current['tts-audio-data'];
          if (handler) handler(event.data);
          return;
        }

        const data = JSON.parse(event.data);

        // Handle session status internally
        if (data.type === 'session-status') {
          setClaudeRunning(data.running);
        } else if (data.type === 'session-init') {
          setCurrentModel(data.model || '');
          setClaudeRunning(true);
        } else if (data.type === 'session-ended') {
          setClaudeRunning(false);
        }

        // Forward to registered handlers
        const handler = handlersRef.current[data.type];
        if (handler) handler(data);
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const startSession = useCallback(() => send('start-session'), [send]);
  const stopSession = useCallback(() => send('stop-session'), [send]);
  const sendCommand = useCallback((transcript) => send('voice-command', { transcript }), [send]);
  const cancelRequest = useCallback(() => send('cancel-request'), [send]);
  const clearHistory = useCallback(() => send('clear-history'), [send]);
  const getHistory = useCallback(() => send('get-history'), [send]);

  return {
    isConnected,
    claudeRunning,
    currentModel,
    setCurrentModel,
    send,
    setHandler,
    startSession,
    stopSession,
    sendCommand,
    cancelRequest,
    clearHistory,
    getHistory,
  };
}
