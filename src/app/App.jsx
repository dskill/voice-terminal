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
import SettingsPanel from './components/SettingsPanel';

function appendTimelineEvent(currentTimeline, incomingEvent) {
  const next = Array.isArray(currentTimeline) ? [...currentTimeline] : [];
  const last = next[next.length - 1];

  if (incomingEvent.type === 'text' && last?.type === 'text' && (incomingEvent.seq == null || last.seq == null || incomingEvent.seq >= last.seq)) {
    next[next.length - 1] = {
      ...last,
      text: `${last.text || ''}${incomingEvent.text || ''}`,
      seq: incomingEvent.seq ?? last.seq
    };
    return next;
  }

  next.push(incomingEvent);
  next.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  return next;
}

function buildStreamingFromTimeline(timeline, fallbackText = '', fallbackToolCalls = []) {
  const list = Array.isArray(timeline) ? timeline : [];
  const text = list.filter((e) => e.type === 'text').map((e) => e.text || '').join('') || fallbackText || '';
  const toolCalls = list
    .filter((e) => e.type === 'tool')
    .map((e) => ({ toolName: e.toolName, input: e.input }));
  return {
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : (fallbackToolCalls || []),
    timeline: list
  };
}

export default function App() {
  const [initialized, setInitialized] = useState(false);
  const [messages, setMessages] = useState([]);
  const [streamingMessage, setStreamingMessage] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [autoSend, setAutoSend] = useState(() => {
    return localStorage.getItem('voice-terminal-auto-send') === '1';
  });
  const [tmuxSessions, setTmuxSessions] = useState([]);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [activeTmuxSession, setActiveTmuxSession] = useState(() => {
    return localStorage.getItem('voice-terminal-active-tmux') || '';
  });
  const [tmuxStatusBySession, setTmuxStatusBySession] = useState({});
  const [tmuxUnreadCompletions, setTmuxUnreadCompletions] = useState({});
  const [doneFlashVisible, setDoneFlashVisible] = useState(false);
  const completionSeenRef = useRef({});
  const tmuxStatusBaselineReadyRef = useRef(false);
  const doneFlashTimerRef = useRef(null);

  const ws = useWebSocket();
  const speech = useSpeechRecognition();
  const tts = useTTS();
  const ttsMetaRef = useRef(null);
  const wakeLockRef = useRef(null);

  // ---- WebSocket message handlers ----

  const addMessage = useCallback((type, content, spokenSummary, metadata, toolCalls, timeline) => {
    setMessages((prev) => [...prev, { type, content, spokenSummary, metadata, toolCalls, timeline }]);
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
          timeline: msg.timeline,
        }));
        setMessages(restored);
      } else {
        setMessages([]);
      }

      if (data.inFlightTurn) {
        setStreamingMessage(
          buildStreamingFromTimeline(
            data.inFlightTurn.timeline || [],
            data.inFlightTurn.partialText || '',
            data.inFlightTurn.toolCalls || []
          )
        );
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
      setTmuxUnreadCompletions((prev) => ({ ...prev, [data.name]: 0 }));
      ws.listTmuxSessions();
      ws.summarizeTmuxSession(data.name);
      setShowSessionMenu(false);
    });

    ws.setHandler('tmux-agent-status', (data) => {
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const nextStatus = {};
      for (const session of sessions) {
        if (!session?.session) continue;
        nextStatus[session.session] = {
          state: session.state === 'working' ? 'working' : 'idle',
          completionCount: Number(session.completionCount || 0),
          lastDoneAt: Number(session.lastDoneAt || 0)
        };
      }

      setTmuxStatusBySession(nextStatus);

      if (!tmuxStatusBaselineReadyRef.current) {
        const seededSeen = {};
        for (const [sessionName, status] of Object.entries(nextStatus)) {
          seededSeen[sessionName] = status.completionCount;
        }
        completionSeenRef.current = seededSeen;
        tmuxStatusBaselineReadyRef.current = true;
        setTmuxUnreadCompletions({});
        return;
      }

      setTmuxUnreadCompletions((prev) => {
        const nextUnread = { ...prev };
        for (const [sessionName, status] of Object.entries(nextStatus)) {
          const previousSeen = Number(completionSeenRef.current[sessionName] || 0);
          const delta = Math.max(0, status.completionCount - previousSeen);
          if (delta > 0) {
            if (sessionName === activeTmuxSession) {
              if (doneFlashTimerRef.current) clearTimeout(doneFlashTimerRef.current);
              setDoneFlashVisible(true);
              doneFlashTimerRef.current = setTimeout(() => setDoneFlashVisible(false), 2000);
              nextUnread[sessionName] = 0;
            } else {
              nextUnread[sessionName] = Number(nextUnread[sessionName] || 0) + delta;
            }
          }
          completionSeenRef.current[sessionName] = status.completionCount;
        }

        for (const sessionName of Object.keys(nextUnread)) {
          if (!nextStatus[sessionName]) {
            delete nextUnread[sessionName];
            delete completionSeenRef.current[sessionName];
          }
        }

        return nextUnread;
      });
    });

    ws.setHandler('tool-call', (data) => {
      setStreamingMessage((prev) => {
        const current = prev || { text: '', toolCalls: [], timeline: [] };
        const timeline = appendTimelineEvent(current.timeline, {
          type: 'tool',
          seq: data.seq,
          toolName: data.toolName,
          input: data.input
        });
        return buildStreamingFromTimeline(timeline, current.text, current.toolCalls);
      });
      setLiveText(`Using ${data.toolName}...`);
    });

    ws.setHandler('partial', (data) => {
      setStreamingMessage((prev) => {
        const current = prev || { text: '', toolCalls: [], timeline: [] };
        const timeline = appendTimelineEvent(current.timeline, {
          type: 'text',
          seq: data.seq,
          text: data.text
        });
        return buildStreamingFromTimeline(timeline, current.text + data.text, current.toolCalls);
      });
      setLiveText('Thinking...');
    });

    ws.setHandler('response', (data) => {
      // Finalize streaming message into a regular message
      setStreamingMessage((prev) => {
        const timeline = prev?.timeline || data.timeline || [];
        const toolCalls = prev?.toolCalls || data.toolCalls || [];
        addMessage('assistant', data.fullResponse, data.spokenSummary, data.metadata, toolCalls, timeline);
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
  }, [ws.setHandler, ws.listTmuxSessions, ws.summarizeTmuxSession, addMessage, tts.playAudio, activeTmuxSession]);

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

  useEffect(() => {
    return () => {
      if (doneFlashTimerRef.current) {
        clearTimeout(doneFlashTimerRef.current);
        doneFlashTimerRef.current = null;
      }
    };
  }, []);

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
    setShowSettings(false);
  }, [ws]);

  const openSessionMenu = useCallback(() => {
    ws.listTmuxSessions();
    setShowSessionMenu(true);
  }, [ws]);

  const handleSelectTmuxSession = useCallback((sessionName) => {
    const previous = activeTmuxSession || '';
    const next = sessionName || '';
    setActiveTmuxSession(next);
    if (next) {
      localStorage.setItem('voice-terminal-active-tmux', next);
      setLiveText(`Attached to tmux session ${next}`);
      const status = tmuxStatusBySession[next];
      if (status) {
        completionSeenRef.current[next] = status.completionCount;
      }
      setTmuxUnreadCompletions((prev) => ({ ...prev, [next]: 0 }));
      if (next !== previous) {
        ws.summarizeTmuxSession(next);
      }
    } else {
      localStorage.removeItem('voice-terminal-active-tmux');
      setLiveText('Detached from tmux session');
    }
    setShowSessionMenu(false);
  }, [tmuxStatusBySession, ws, activeTmuxSession]);

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

  const totalUnreadCompletions = Object.values(tmuxUnreadCompletions).reduce((sum, value) => sum + Number(value || 0), 0);
  const activeTmuxStatus = activeTmuxSession ? tmuxStatusBySession[activeTmuxSession] : null;
  const activeStatusText = activeTmuxStatus?.state === 'working' ? 'Working' : 'Idle';
  const activeStatusDot = activeTmuxStatus?.state === 'working' ? 'bg-emerald-400' : 'bg-slate-400';

  return (
    <div className="h-dvh flex flex-col bg-slate-900 text-slate-100">
      <div className="flex items-center justify-center border-b border-slate-700/50 bg-slate-800/80 backdrop-blur-sm">
        <Controls
          isConnected={ws.isConnected}
          claudeRunning={ws.claudeRunning}
          onRefresh={() => location.reload()}
          onOpenSettings={() => setShowSettings(true)}
        />
      </div>

      <div className="flex-1 flex flex-col p-4 overflow-hidden min-h-0">
        <TranscriptArea messages={messages} streamingMessage={streamingMessage} />

        <div className="flex-shrink-0 flex flex-col items-center gap-3 pt-4 border-t border-slate-800/50 mt-4">
          <div className="text-xs text-slate-500 text-center flex items-center gap-2">
            <span>Active tmux: {activeTmuxSession || 'none'}</span>
            {activeTmuxSession && (
              <>
                <span className={`inline-block w-2 h-2 rounded-full ${activeStatusDot}`} />
                <span>{activeStatusText}</span>
              </>
            )}
            {doneFlashVisible && activeTmuxSession && (
              <span className="px-1.5 py-0.5 rounded bg-blue-600/80 text-blue-50 text-[10px] font-semibold">
                Done
              </span>
            )}
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
              className="relative w-12 h-12 rounded-full flex items-center justify-center bg-slate-800 border border-slate-600 text-slate-100 hover:bg-slate-700 transition-colors touch-none select-none"
              title="Open tmux session selector"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4zm2 2h6v2H6V9zm0 4h9v2H6v-2z" />
              </svg>
              {totalUnreadCompletions > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-blue-500 text-[10px] leading-[1.1rem] text-white font-semibold text-center">
                  {totalUnreadCompletions > 9 ? '9+' : totalUnreadCompletions}
                </span>
              )}
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
        statusBySession={tmuxStatusBySession}
        unreadCompletions={tmuxUnreadCompletions}
        onSelectSession={handleSelectTmuxSession}
        onCreateClaude={handleCreateClaudeSession}
        onCreateCodex={handleCreateCodexSession}
        onClose={() => setShowSessionMenu(false)}
      />

      <SettingsPanel
        open={showSettings}
        autoSend={autoSend}
        onToggleAutoSend={toggleAutoSend}
        onRestartSession={restartSession}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}
