import React, { useState, useCallback, useEffect, useRef } from 'react';
import useWebSocket from './hooks/useWebSocket';
import useSpeechRecognition from './hooks/useSpeechRecognition';
import useTTS from './hooks/useTTS';
import LoadingOverlay from './components/LoadingOverlay';
import TranscriptArea from './components/TranscriptArea';
import Controls from './components/Controls';
import MicButton from './components/MicButton';
import InputArea from './components/InputArea';
import SessionRadialMenu from './components/SessionRadialMenu';

export default function App() {
  const [initialized, setInitialized] = useState(false);
  const [messages, setMessages] = useState([]);
  const [streamingMessage, setStreamingMessage] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [autoSend, setAutoSend] = useState(() => {
    return localStorage.getItem('voice-terminal-auto-send') === '1';
  });
  const [tmuxSessions, setTmuxSessions] = useState([]);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [activeTmuxSession, setActiveTmuxSession] = useState(() => {
    return localStorage.getItem('voice-terminal-active-tmux') || '';
  });

  const ws = useWebSocket();
  const speech = useSpeechRecognition();
  const tts = useTTS();
  const ttsMetaRef = useRef(null);
  const wakeLockRef = useRef(null);

  // ---- WebSocket message handlers ----

  const addMessage = useCallback((type, content, spokenSummary, metadata, toolCalls) => {
    setMessages((prev) => [...prev, { type, content, spokenSummary, metadata, toolCalls }]);
  }, []);

  useEffect(() => {
    ws.setHandler('history', (data) => {
      if (data.messages?.length > 0) {
        const restored = data.messages.map((msg) => ({
          type: msg.type,
          content: msg.content,
          spokenSummary: msg.spokenSummary,
          metadata: msg.metadata,
          toolCalls: msg.toolCalls,
        }));
        setMessages(restored);
      } else {
        setMessages([]);
      }

      if (data.inFlightTurn) {
        setStreamingMessage({
          text: data.inFlightTurn.partialText || '',
          toolCalls: data.inFlightTurn.toolCalls || [],
        });
        setIsProcessing(true);
        setLiveText('Thinking...');
      } else {
        setStreamingMessage(null);
        setIsProcessing(false);
      }
    });

    ws.setHandler('session-init', (data) => {
      addMessage('status', 'Session started');
    });

    ws.setHandler('session-reinit', (data) => {
      const model = data?.model ? ` (${data.model})` : '';
      addMessage('status', `Session ready${model}`);
    });

    ws.setHandler('session-ended', (data) => {
      addMessage('status', `Claude session ended (code: ${data.code})`);
    });

    ws.setHandler('status', (data) => {
      setLiveText(data.message);
    });

    ws.setHandler('tmux-sessions', (data) => {
      setTmuxSessions(data.sessions || []);
    });

    ws.setHandler('tmux-session-created', (data) => {
      if (!data?.name) return;
      setActiveTmuxSession(data.name);
      localStorage.setItem('voice-terminal-active-tmux', data.name);
      setLiveText(`Attached to tmux session ${data.name}`);
      ws.listTmuxSessions();
      setShowSessionMenu(false);
    });

    ws.setHandler('tool-call', (data) => {
      setStreamingMessage((prev) => {
        const current = prev || { text: '', toolCalls: [] };
        return {
          ...current,
          toolCalls: [...current.toolCalls, { toolName: data.toolName, input: data.input }],
        };
      });
      setLiveText(`Using ${data.toolName}...`);
    });

    ws.setHandler('partial', (data) => {
      setStreamingMessage((prev) => {
        const current = prev || { text: '', toolCalls: [] };
        return { ...current, text: current.text + data.text };
      });
      setLiveText('Thinking...');
    });

    ws.setHandler('response', (data) => {
      // Finalize streaming message into a regular message
      setStreamingMessage((prev) => {
        const toolCalls = prev?.toolCalls || data.toolCalls || [];
        addMessage('assistant', data.fullResponse, data.spokenSummary, data.metadata, toolCalls);
        return null;
      });

      if (data.spokenSummary) {
        setLiveText('Generating speech...');
      } else {
        setLiveText('');
        setIsProcessing(false);
      }
    });

    ws.setHandler('tts-audio', (data) => {
      ttsMetaRef.current = { samplingRate: data.samplingRate, numSamples: data.numSamples };
    });

    ws.setHandler('tts-audio-data', (arrayBuffer) => {
      const meta = ttsMetaRef.current;
      if (!meta) return;
      const float32 = new Float32Array(arrayBuffer);
      tts.playAudio(float32, meta.samplingRate);
      ttsMetaRef.current = null;
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('tts-error', (data) => {
      console.warn('[TTS] Server error:', data.message);
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('error', (data) => {
      setStreamingMessage(null);
      addMessage('error', data.message);
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('request-cancelled', () => {
      setStreamingMessage(null);
      setIsProcessing(false);
      setLiveText('Cancelled');
      setTimeout(() => setLiveText(''), 1500);
    });

    ws.setHandler('history-cleared', () => {
      // handled by local state clear
    });
  }, [ws.setHandler, ws.listTmuxSessions, addMessage, tts.playAudio]);

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      if (!wakeLockRef.current) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
        });
      }
    } catch (e) {
      // Ignore wake lock failures (unsupported/browser policy)
    }
  }, []);

  useEffect(() => {
    if (!initialized) return;

    requestWakeLock();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [initialized, requestWakeLock]);

  // ---- Recording flow ----

  const startRecording = useCallback(async () => {
    if (isProcessing || isTranscribing || speech.isListening) return;
    if (!ws.claudeRunning) {
      setLiveText('Start Claude session first');
      return;
    }
    tts.unlock(); // iOS gesture unlock
    const started = await speech.startListening();
    if (started) {
      setLiveText('Listening...');
    } else {
      setLiveText('Unable to start microphone');
    }
  }, [isProcessing, isTranscribing, speech, ws.claudeRunning, tts]);

  const stopRecording = useCallback(async () => {
    if (!speech.isListening) return;
    setIsTranscribing(true);
    setLiveText('Transcribing on server...');

    try {
      const audioBlob = await speech.stopListening();
      if (!audioBlob || audioBlob.size === 0) {
        setLiveText('No audio captured');
        setShowInput(false);
        return;
      }

      const text = await ws.sendAudioForSTT(audioBlob);
      if (autoSend) {
        const finalText = (text || '').trim();
        if (!finalText || finalText.length < 2) {
          setShowInput(false);
          setInputText('');
          setLiveText('');
          return;
        }
        setShowInput(false);
        setInputText('');
        setIsProcessing(true);
        setLiveText('Sending to Claude...');
        addMessage('user', finalText);
        const finalCommand = activeTmuxSession
          ? `this speech command is intended for use with tmux session ${activeTmuxSession}\n\n${finalText}`
          : finalText;
        ws.sendCommand(finalCommand);
      } else {
        setInputText(text);
        setShowInput(true);
        setLiveText('Review or tap send');
      }
    } catch (err) {
      setLiveText(`Transcription failed: ${err.message || 'unknown error'}`);
      setShowInput(false);
      setInputText('');
    } finally {
      setIsTranscribing(false);
    }
  }, [speech, ws, autoSend, addMessage, activeTmuxSession]);

  const toggleRecording = useCallback(() => {
    if (isProcessing || isTranscribing) return;
    if (speech.isListening) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isProcessing, isTranscribing, speech.isListening, startRecording, stopRecording]);

  // ---- Send / Cancel ----

  const sendMessage = useCallback(() => {
    const text = inputText.trim();
    setShowInput(false);
    setInputText('');

    if (!text || text.length < 2) {
      setLiveText('');
      return;
    }

    setIsProcessing(true);
    setLiveText('Sending to Claude...');
    addMessage('user', text);
    const finalCommand = activeTmuxSession
      ? `this speech command is intended for use with tmux session ${activeTmuxSession}\n\n${text}`
      : text;
    ws.sendCommand(finalCommand);
  }, [inputText, addMessage, ws, activeTmuxSession]);

  const toggleAutoSend = useCallback((enabled) => {
    setAutoSend(enabled);
    localStorage.setItem('voice-terminal-auto-send', enabled ? '1' : '0');
  }, []);

  const cancelMessage = useCallback(() => {
    setShowInput(false);
    setInputText('');
    setLiveText('');
  }, []);

  const cancelProcessing = useCallback(() => {
    ws.cancelRequest();
    tts.stop();
  }, [ws, tts]);

  // ---- Session controls ----

  const restartSession = useCallback(() => {
    ws.restartSession();
    setMessages([]);
    setStreamingMessage(null);
    setShowInput(false);
    setInputText('');
    setIsProcessing(false);
    setLiveText('Restarting Claude session...');
  }, [ws]);

  const openSessionMenu = useCallback(() => {
    ws.listTmuxSessions();
    setShowSessionMenu(true);
  }, [ws]);

  const handleSelectTmuxSession = useCallback((sessionName) => {
    const next = sessionName || '';
    setActiveTmuxSession(next);
    if (next) {
      localStorage.setItem('voice-terminal-active-tmux', next);
      setLiveText(`Attached to tmux session ${next}`);
    } else {
      localStorage.removeItem('voice-terminal-active-tmux');
      setLiveText('Detached from tmux session');
    }
    setShowSessionMenu(false);
  }, []);

  const handleCreateClaudeSession = useCallback(() => {
    ws.createTmuxSession('claude');
    setLiveText('Creating new Claude tmux session...');
  }, [ws]);

  const handleCreateCodexSession = useCallback(() => {
    ws.createTmuxSession('codex');
    setLiveText('Creating new Codex tmux session...');
  }, [ws]);

  // ---- Spacebar shortcut ----

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === ' ' && !isProcessing && !isTranscribing && !showInput) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        toggleRecording();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isProcessing, isTranscribing, showInput, toggleRecording]);

  // ---- Render ----

  if (!initialized) {
    return <LoadingOverlay onStart={() => setInitialized(true)} />;
  }

  return (
    <div className="h-dvh flex flex-col bg-slate-900 text-slate-100">
      <div className="flex items-center justify-center border-b border-slate-700/50 bg-slate-800/80 backdrop-blur-sm">
        <Controls
          isConnected={ws.isConnected}
          claudeRunning={ws.claudeRunning}
          onRestartSession={restartSession}
          onRefresh={() => location.reload()}
          autoSend={autoSend}
          onToggleAutoSend={toggleAutoSend}
        />
      </div>

      <div className="flex-1 flex flex-col p-4 overflow-hidden min-h-0">
        <TranscriptArea messages={messages} streamingMessage={streamingMessage} />

        <div className="flex-shrink-0 flex flex-col items-center gap-3 pt-4 border-t border-slate-800/50 mt-4">
          <div className="text-xs text-slate-500 text-center">
            Active tmux: {activeTmuxSession || 'none'}
          </div>

          {liveText && !showInput && (
            <div className="text-sm text-slate-400 text-center min-h-[1.5em] px-4">
              {liveText}
            </div>
          )}

          <InputArea
            value={inputText}
            onChange={setInputText}
            onSend={sendMessage}
            onCancel={cancelMessage}
            visible={showInput}
          />

          <div className="flex items-center gap-4">
            <button
              onPointerDown={(e) => {
                e.preventDefault();
                openSessionMenu();
              }}
              className="w-12 h-12 rounded-full flex items-center justify-center bg-slate-800 border border-slate-600 text-slate-100 hover:bg-slate-700 transition-colors touch-none select-none"
              title="Open tmux session selector"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4zm2 2h6v2H6V9zm0 4h9v2H6v-2z" />
              </svg>
            </button>

            <MicButton
              isRecording={speech.isListening}
              audioLevel={speech.audioLevel}
              isProcessing={isProcessing}
              isSendMode={showInput}
              disabled={!ws.claudeRunning || isTranscribing}
              onClick={showInput ? sendMessage : toggleRecording}
              onCancel={cancelProcessing}
              onLongPress={openSessionMenu}
            />
          </div>
        </div>
      </div>

      <SessionRadialMenu
        open={showSessionMenu}
        sessions={tmuxSessions}
        activeSession={activeTmuxSession || null}
        onSelectSession={handleSelectTmuxSession}
        onCreateClaude={handleCreateClaudeSession}
        onCreateCodex={handleCreateCodexSession}
        onClose={() => setShowSessionMenu(false)}
      />
    </div>
  );
}
