import React, { useState, useCallback, useEffect, useRef } from 'react';
import useWebSocket from './hooks/useWebSocket';
import useSpeechRecognition from './hooks/useSpeechRecognition';
import useTTS from './hooks/useTTS';
import useDebugAudioCues from './hooks/useDebugAudioCues';
import TranscriptArea from './components/TranscriptArea';
import Controls from './components/Controls';
import MicButton from './components/MicButton';
import InputArea from './components/InputArea';
import SessionRadialMenu from './components/SessionRadialMenu';
import SettingsPanel from './components/SettingsPanel';

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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
  const ORCHESTRATOR_OPTIONS = [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude', label: 'Claude Opus 4.6' },
    { value: 'codex', label: 'Codex (Spark)' },
  ];
  const formatOrchestratorLabel = (kind) => {
    if (kind === 'codex') return 'Codex (Spark)';
    if (kind === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6';
    return 'Claude Opus 4.6';
  };

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
  const [ttsEnabled, setTTSEnabled] = useState(() => {
    const value = localStorage.getItem('voice-terminal-tts-enabled');
    return value == null ? true : value === '1';
  });
  const [tmuxSessions, setTmuxSessions] = useState([]);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [activeTmuxSession, setActiveTmuxSession] = useState(() => {
    return localStorage.getItem('voice-terminal-active-tmux') || '';
  });
  const [tmuxStatusBySession, setTmuxStatusBySession] = useState({});
  const [tmuxUnreadCompletions, setTmuxUnreadCompletions] = useState({});
  const [doneFlashVisible, setDoneFlashVisible] = useState(false);
  const [uploadState, setUploadState] = useState(null);
  const [selectedOrchestrator, setSelectedOrchestrator] = useState(() => {
    const stored = localStorage.getItem('voice-terminal-orchestrator');
    if (stored === 'codex') return 'codex';
    if (stored === 'claude') return 'claude';
    if (stored === 'claude-sonnet-4-6') return 'claude-sonnet-4-6';
    return 'claude-sonnet-4-6';
  });
  const completionSeenRef = useRef({});
  const tmuxStatusBaselineReadyRef = useRef(false);
  const doneFlashTimerRef = useRef(null);
  const activeTmuxSyncedRef = useRef(false);
  const fileInputRef = useRef(null);

  const ws = useWebSocket();
  const speech = useSpeechRecognition();
  const tts = useTTS();
  const {
    unlock: unlockDebugCues,
    playMicStart,
    playMicStop,
    playTTSStart,
    playTTSStop,
    playSessionComplete,
    playToolDispatch,
    playStreamChunk,
  } = useDebugAudioCues();
  const ttsChunkMetaRef = useRef(null);
  const prevIsSpeakingRef = useRef(false);
  const wakeLockRef = useRef(null);
  const recordingControlsRef = useRef(null);

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
      const label = formatOrchestratorLabel(data?.orchestrator || ws.orchestrator);
    });

    ws.setHandler('session-reinit', (data) => {
      const label = formatOrchestratorLabel(data?.orchestrator || ws.orchestrator);
      const model = data?.model ? ` (${data.model})` : '';
    });

    ws.setHandler('session-ended', (data) => {
      const label = formatOrchestratorLabel(data?.orchestrator || ws.orchestrator);
      addMessage('status', `${label} session ended (code: ${data.code})`);
    });

    ws.setHandler('orchestrator-changed', (data) => {
      if (!data?.orchestrator) return;
      setSelectedOrchestrator(data.orchestrator);
      localStorage.setItem('voice-terminal-orchestrator', data.orchestrator);
      setLiveText(`Switched to ${formatOrchestratorLabel(data.orchestrator)}`);
      setTimeout(() => setLiveText(''), 1500);
    });

    ws.setHandler('status', (data) => {
      setLiveText(data.message);
    });

    ws.setHandler('tmux-sessions', (data) => {
      setTmuxSessions(data.sessions || []);
    });

    ws.setHandler('tmux-session-created', (data) => {
      if (!data?.name) return;
      ws.switchActiveTmuxSession(data.name, 'ui');
      setLiveText(`Attached to tmux session ${data.name}`);
      setTmuxUnreadCompletions((prev) => ({ ...prev, [data.name]: 0 }));
      ws.listTmuxSessions();
      setShowSessionMenu(false);
    });

    ws.setHandler('active-tmux-session-changed', (data) => {
      const next = String(data?.sessionName || '').trim();
      setActiveTmuxSession(next);
      if (next) {
        localStorage.setItem('voice-terminal-active-tmux', next);
        const status = tmuxStatusBySession[next];
        if (status) {
          completionSeenRef.current[next] = status.completionCount;
        }
        setTmuxUnreadCompletions((prev) => ({ ...prev, [next]: 0 }));
      } else {
        localStorage.removeItem('voice-terminal-active-tmux');
      }
      if (data?.source === 'orchestrator-tool') {
        setLiveText(next ? `AI switched active tmux session to ${next}` : 'AI detached tmux session');
      }
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
            playSessionComplete(delta);
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
      playToolDispatch();
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
      if ((data.text || '').trim()) {
        playStreamChunk();
      }
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

      if (data.ttsScheduled) {
        setLiveText('Generating speech...');
      } else {
        if (data.ttsSkipReason) {
          console.warn(`[TTS] Not scheduled: ${data.ttsSkipReason}`);
        }
        if (ttsEnabled && data.ttsSkipReason === 'no-tts-enabled-clients') {
          ws.setTTSEnabled(true);
          setLiveText('Resyncing audio with server...');
          setTimeout(() => setLiveText(''), 1200);
          setIsProcessing(false);
          return;
        }
        setLiveText('');
        setIsProcessing(false);
      }
    });

    ws.setHandler('tts-start', (data) => {
      tts.startStream(data);
      setLiveText('Speaking...');
    });

    ws.setHandler('tts-chunk', (data) => {
      ttsChunkMetaRef.current = {
        requestId: data.requestId,
        sampleRate: data.sampleRate,
      };
    });

    ws.setHandler('tts-audio-data', (arrayBuffer) => {
      const meta = ttsChunkMetaRef.current;
      if (!meta) return;
      tts.enqueueChunk(arrayBuffer, meta);
      ttsChunkMetaRef.current = null;
      setLiveText('Speaking...');
      setIsProcessing(false);
    });

    ws.setHandler('tts-end', (data) => {
      tts.endStream(data.requestId);
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('tts-cancelled', (data) => {
      tts.stop();
      ttsChunkMetaRef.current = null;
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('tts-error', (data) => {
      console.warn('[TTS] Server error:', data.message);
      tts.stop();
      ttsChunkMetaRef.current = null;
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('error', (data) => {
      setStreamingMessage(null);
      addMessage('error', data.message);
      setLiveText('');
      setIsProcessing(false);
    });

    ws.setHandler('request-cancelled', (data) => {
      tts.stop();
      ttsChunkMetaRef.current = null;
      setStreamingMessage((prev) => {
        const timeline = (Array.isArray(data?.timeline) && data.timeline.length > 0)
          ? data.timeline
          : (prev?.timeline || []);
        const toolCalls = (Array.isArray(data?.toolCalls) && data.toolCalls.length > 0)
          ? data.toolCalls
          : (prev?.toolCalls || []);
        const content = typeof data?.fullResponse === 'string' && data.fullResponse.length > 0
          ? data.fullResponse
          : (prev?.text || '');
        const hasVisibleContent = timeline.length > 0 || toolCalls.length > 0 || content.trim().length > 0;

        if (hasVisibleContent) {
          addMessage(
            'assistant',
            content,
            '',
            { interrupted: true, cancelled: true, partial: true },
            toolCalls,
            timeline
          );
        }

        return null;
      });
      setIsProcessing(false);
      setLiveText('Cancelled');
      setTimeout(() => setLiveText(''), 1500);
    });

    ws.setHandler('history-cleared', () => {
      // handled by local state clear
    });
  }, [
    ws.setHandler,
    ws.listTmuxSessions,
    ws.switchActiveTmuxSession,
    addMessage,
    tts.startStream,
    tts.enqueueChunk,
    tts.endStream,
    tts.stop,
    activeTmuxSession,
    ws.orchestrator,
    tmuxStatusBySession,
    ws.setTTSEnabled,
    playSessionComplete,
    playToolDispatch,
    playStreamChunk,
    ttsEnabled
  ]);

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    try {
      if (!wakeLockRef.current) {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => {
          if (wakeLockRef.current !== sentinel) return;
          wakeLockRef.current = null;
          if (document.visibilityState === 'visible') {
            requestWakeLock();
          }
        });
        wakeLockRef.current = sentinel;
      }
    } catch (e) {
      // Ignore wake lock failures (unsupported/browser policy)
    }
  }, []);

  useEffect(() => {
    requestWakeLock();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    const onFocus = () => requestWakeLock();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    const refreshTimer = setInterval(() => {
      requestWakeLock();
    }, 15000);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      clearInterval(refreshTimer);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [requestWakeLock]);

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
    if (!ws.sessionRunning) {
      setLiveText(`Start ${formatOrchestratorLabel(selectedOrchestrator)} session first`);
      return;
    }
    tts.unlock(); // iOS gesture unlock
    unlockDebugCues(); // iOS gesture unlock for debug cues
    const started = await speech.startListening();
    if (started) {
      playMicStart();
      setLiveText('Listening...');
    } else {
      setLiveText('Unable to start microphone');
    }
  }, [isProcessing, isTranscribing, speech, ws.sessionRunning, tts, unlockDebugCues, playMicStart, selectedOrchestrator]);

  const stopRecording = useCallback(async () => {
    if (!speech.isListening) return;
    playMicStop();
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
        setLiveText(`Sending to ${formatOrchestratorLabel(selectedOrchestrator)}...`);
        addMessage('user', finalText);
        ws.sendCommand(finalText);
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
  }, [speech, ws, autoSend, addMessage, playMicStop, selectedOrchestrator]);

  const toggleRecording = useCallback(() => {
    if (isProcessing || isTranscribing) return;
    if (speech.isListening) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isProcessing, isTranscribing, speech.isListening, startRecording, stopRecording]);

  const abortRecording = useCallback(async () => {
    if (!speech.isListening) return;
    playMicStop();
    try {
      await speech.stopListening();
    } catch {
      // ignore
    }
    setIsTranscribing(false);
    setInputText('');
    setShowInput(false);
    setLiveText('Recording discarded');
    setTimeout(() => setLiveText(''), 1200);
  }, [speech, playMicStop]);

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
    setLiveText(`Sending to ${formatOrchestratorLabel(selectedOrchestrator)}...`);
    addMessage('user', text);
    ws.sendCommand(text);
  }, [inputText, addMessage, ws, selectedOrchestrator]);

  const toggleAutoSend = useCallback((enabled) => {
    setAutoSend(enabled);
    localStorage.setItem('voice-terminal-auto-send', enabled ? '1' : '0');
  }, []);

  const toggleTTSEnabled = useCallback((enabled) => {
    const value = !!enabled;
    setTTSEnabled(value);
    localStorage.setItem('voice-terminal-tts-enabled', value ? '1' : '0');
    ws.setTTSEnabled(value);
    if (!value) {
      ws.stopTTS();
      tts.stop();
      setLiveText('Audio muted');
      setTimeout(() => setLiveText(''), 900);
      return;
    }
    (async () => {
      const unlocked = await tts.unlock();
      const played = await tts.playEnableCue();
      if (unlocked && played) {
        setLiveText('Audio on');
      } else {
        setLiveText('Audio on - if silent on iPhone, turn off Silent Mode and tap again');
      }
      setTimeout(() => setLiveText(''), 2200);
    })();
  }, [tts, ws]);

  const cancelMessage = useCallback(() => {
    setShowInput(false);
    setInputText('');
    setLiveText('');
  }, []);

  const handleUploadFiles = useCallback((files) => {
    const list = Array.isArray(files) ? files : Array.from(files || []);
    if (list.length === 0) return;

    const attachmentLines = list.map((file) => `- ${file.name}`);
    const attachmentBlock = `Attached files:\n${attachmentLines.join('\n')}`;

    setInputText((prev) => {
      const current = String(prev || '').trim();
      if (!current) return attachmentBlock;
      return `${current}\n\n${attachmentBlock}`;
    });
    setShowInput(true);
    setLiveText(`Added ${list.length} file${list.length === 1 ? '' : 's'} to message`);
  }, []);

  const cancelProcessing = useCallback(() => {
    ws.cancelRequest();
    tts.stop();
  }, [ws, tts]);

  const cancelMicAction = useCallback(() => {
    if (tts.isSpeaking) {
      ws.stopTTS();
      tts.stop();
      setLiveText('');
      return;
    }
    cancelProcessing();
  }, [tts, cancelProcessing, ws]);

  const uploadFileWithProgress = useCallback((file) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);

      xhr.open('POST', '/upload');
      xhr.responseType = 'json';

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        setUploadState((prev) => ({
          ...(prev || {}),
          status: 'uploading',
          filename: file.name,
          size: file.size,
          progress: Math.min(100, Math.round((event.loaded / event.total) * 100))
        }));
      };

      xhr.onerror = () => {
        reject(new Error('Network error while uploading'));
      };

      xhr.onload = () => {
        const raw = xhr.response ?? (() => {
          try {
            return JSON.parse(xhr.responseText || '{}');
          } catch {
            return {};
          }
        })();

        if (xhr.status >= 200 && xhr.status < 300 && raw?.success) {
          resolve(raw);
          return;
        }

        const error = new Error(raw?.error || `Upload failed (${xhr.status})`);
        error.payload = raw;
        reject(error);
      };

      xhr.send(formData);
    });
  }, []);

  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploadState({
      status: 'uploading',
      filename: file.name,
      size: file.size,
      progress: 0
    });

    try {
      const result = await uploadFileWithProgress(file);
      setUploadState({
        status: 'success',
        filename: result.filename || file.name,
        size: Number(result.size ?? file.size ?? 0),
        path: result.path,
        message: 'Saved and shared with the agent.'
      });
    } catch (err) {
      const payload = err?.payload || {};
      setUploadState({
        status: 'error',
        filename: payload.filename || file.name,
        size: Number(payload.size ?? file.size ?? 0),
        path: payload.path || '',
        message: payload.saved
          ? `Saved file, but could not notify the agent: ${err.message || 'Upload failed'}`
          : (err.message || 'Upload failed')
      });
    }
  }, [uploadFileWithProgress]);

  // ---- Session controls ----

  const restartSession = useCallback(() => {
    ws.restartSession();
    setMessages([]);
    setStreamingMessage(null);
    setShowInput(false);
    setInputText('');
    setIsProcessing(false);
    setLiveText(`Restarting ${formatOrchestratorLabel(selectedOrchestrator)} session...`);
    setShowSettings(false);
  }, [ws, selectedOrchestrator]);

  const handleSelectOrchestrator = useCallback((next) => {
    const normalized = next === 'codex'
      ? 'codex'
      : (next === 'claude-sonnet-4-6' ? 'claude-sonnet-4-6' : 'claude');
    setSelectedOrchestrator(normalized);
    localStorage.setItem('voice-terminal-orchestrator', normalized);
    setMessages([]);
    setStreamingMessage(null);
    setIsProcessing(false);
    ws.setSessionOrchestrator(normalized);
    setLiveText(`Switching to ${formatOrchestratorLabel(normalized)}...`);
  }, [ws]);

  const openSessionMenu = useCallback(() => {
    ws.listTmuxSessions();
    setShowSessionMenu(true);
  }, [ws]);

  const handleSelectTmuxSession = useCallback((sessionName) => {
    const next = sessionName || '';
    if (next) {
      ws.switchActiveTmuxSession(next, 'ui');
      setLiveText(`Attached to tmux session ${next}`);
    } else {
      ws.switchActiveTmuxSession('', 'ui');
      setLiveText('Detached from tmux session');
    }
    setShowSessionMenu(false);
  }, [ws]);

  const handleReviewTmuxSession = useCallback((sessionName) => {
    const next = String(sessionName || '').trim();
    if (!next) return;
    ws.switchActiveTmuxSession(next, 'ui');
    ws.summarizeTmuxSession(next);
    setLiveText(`Attached and reviewing tmux session ${next}...`);
    setShowSessionMenu(false);
  }, [ws]);

  const handleCreateClaudeSession = useCallback(() => {
    ws.createTmuxSession('claude');
    setLiveText('Creating new Claude tmux session...');
  }, [ws]);

  const handleCreateCodexSession = useCallback(() => {
    ws.createTmuxSession('codex');
    setLiveText('Creating new Codex tmux session...');
  }, [ws]);

  const handleEnableAudio = useCallback(async () => {
    unlockDebugCues();
    const unlocked = await tts.unlock();
    if (!unlocked) {
      setLiveText('Audio still locked. iPhone: disable Silent Mode and tap again.');
      setTimeout(() => setLiveText(''), 2200);
      return;
    }
    await tts.playEnableCue();
    setLiveText('Audio enabled');
    setTimeout(() => setLiveText(''), 1200);
  }, [tts, unlockDebugCues]);

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

  const openKeyboardInput = useCallback(() => {
    if (isProcessing || isTranscribing) return;
    setShowInput(true);
    setLiveText('Type your message and send');
  }, [isProcessing, isTranscribing]);

  useEffect(() => {
    if (!speech.isListening) return undefined;

    const handleOutsideCancel = (event) => {
      const controls = recordingControlsRef.current;
      if (!controls) return;
      if (controls.contains(event.target)) return;
      abortRecording();
    };

    document.addEventListener('pointerdown', handleOutsideCancel, true);
    document.addEventListener('mousedown', handleOutsideCancel, true);
    document.addEventListener('touchstart', handleOutsideCancel, { capture: true, passive: false });

    return () => {
      document.removeEventListener('pointerdown', handleOutsideCancel, true);
      document.removeEventListener('mousedown', handleOutsideCancel, true);
      document.removeEventListener('touchstart', handleOutsideCancel, true);
    };
  }, [speech.isListening, abortRecording]);

  useEffect(() => {
    if (!ws.isConnected || activeTmuxSyncedRef.current) return;
    activeTmuxSyncedRef.current = true;
    if (activeTmuxSession) {
      ws.switchActiveTmuxSession(activeTmuxSession, 'ui');
    }
  }, [ws.isConnected, ws.switchActiveTmuxSession, activeTmuxSession]);

  useEffect(() => {
    if (!ws.isConnected) return;
    ws.setTTSEnabled(ttsEnabled);
  }, [ws.isConnected, ws.setTTSEnabled, ttsEnabled]);

  useEffect(() => {
    if (!ws.isConnected) return;
    const desired = selectedOrchestrator === 'codex'
      ? 'codex'
      : (selectedOrchestrator === 'claude-sonnet-4-6' ? 'claude-sonnet-4-6' : 'claude');
    if (ws.orchestrator && ws.orchestrator !== desired) {
      ws.setSessionOrchestrator(desired);
    }
  }, [ws.isConnected, ws.orchestrator, ws.setSessionOrchestrator, selectedOrchestrator]);

  useEffect(() => {
    const wasSpeaking = prevIsSpeakingRef.current;
    if (!wasSpeaking && tts.isSpeaking) {
      playTTSStart();
    } else if (wasSpeaking && !tts.isSpeaking) {
      playTTSStop();
    }
    prevIsSpeakingRef.current = tts.isSpeaking;
  }, [tts.isSpeaking, playTTSStart, playTTSStop]);

  // ---- Render ----

  const totalUnreadCompletions = Object.values(tmuxUnreadCompletions).reduce((sum, value) => sum + Number(value || 0), 0);
  const activeTmuxStatus = activeTmuxSession ? tmuxStatusBySession[activeTmuxSession] : null;
  const activeStatusText = activeTmuxStatus?.state === 'working' ? 'Working' : 'Idle';
  const activeStatusDot = activeTmuxStatus?.state === 'working' ? 'bg-emerald-400' : 'bg-slate-500';
  const isMicInCancelMode = isProcessing || tts.isSpeaking;
  const micStatusText = tts.isSpeaking ? 'Speaking...' : liveText;
  const isUploading = uploadState?.status === 'uploading';

  return (
    <div className="h-dvh flex flex-col bg-slate-950 text-slate-100">
      <button
        onClick={() => setShowSettings(true)}
        className="absolute top-2 right-3 z-30 w-9 h-9 rounded-md bg-slate-800/85 text-slate-300 border border-slate-600/50 hover:bg-slate-700 hover:text-white transition-colors flex items-center justify-center"
        title="Open settings"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
        </svg>
      </button>

      <div className="relative z-20 flex items-center justify-center border-b border-slate-800/80 bg-slate-900/90 backdrop-blur-sm">
        <Controls
          isConnected={ws.isConnected}
          sessionRunning={ws.sessionRunning}
          orchestratorLabel={formatOrchestratorLabel(ws.orchestrator || selectedOrchestrator)}
          audioEnabled={ttsEnabled}
          audioUnlocked={tts.isAudioUnlocked}
        />
      </div>

      <div className="flex-1 flex flex-col p-4 overflow-hidden min-h-0">
        <TranscriptArea messages={messages} streamingMessage={streamingMessage} />

        <div
          className="relative z-20 flex-shrink-0 flex flex-col items-center gap-3 pt-4 border-t border-slate-800/70 mt-4"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ttsEnabled && !tts.isAudioUnlocked && (
            <div className="w-full max-w-lg">
              <button
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleEnableAudio();
                }}
                className="w-full px-4 py-3 rounded-lg border border-amber-500/40 bg-amber-900/40 text-amber-100 text-sm font-semibold hover:bg-amber-800/50 transition-colors"
                title={`Tap to enable audio output (AudioContext: ${tts.audioContextState})`}
              >
                Tap to enable audio
              </button>
              <div className="mt-1 text-[11px] text-amber-200/80 text-center">
                AudioContext state: {tts.audioContextState}
              </div>
            </div>
          )}

          <div className="text-xs text-slate-500 text-center flex items-center gap-2">
            <span>Active tmux: {activeTmuxSession || 'none'}</span>
            {activeTmuxSession && (
              <>
                <span className={`inline-block w-2 h-2 rounded-full ${activeStatusDot}`} />
                <span>{activeStatusText}</span>
              </>
            )}
            {doneFlashVisible && activeTmuxSession && (
              <span className="px-1.5 py-0.5 rounded bg-cyan-600/85 text-cyan-50 text-[10px] font-semibold">
                Done
              </span>
            )}
          </div>

          {ttsEnabled && ws.serverTTSEnabled === false && (
            <div className="text-[11px] text-rose-300 text-center">
              Server audio state is OFF (resync pending)
            </div>
          )}

          {ttsEnabled && tts.audioIssue && (
            <div className="text-[11px] text-amber-300 text-center max-w-lg px-2">
              Audio issue: {tts.audioIssue}
            </div>
          )}

          {micStatusText && !showInput && (
            <div className="text-sm text-slate-300 text-center min-h-[1.5em] px-4">
              {micStatusText}
            </div>
          )}

          {uploadState && (
            <div className={`w-full max-w-lg rounded-xl border px-4 py-3 ${
              uploadState.status === 'error'
                ? 'border-rose-500/40 bg-rose-950/40 text-rose-100'
                : uploadState.status === 'success'
                  ? 'border-emerald-500/30 bg-emerald-950/30 text-emerald-50'
                  : 'border-cyan-500/30 bg-slate-900 text-slate-100'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {uploadState.status === 'uploading' && 'Uploading file'}
                    {uploadState.status === 'success' && 'Upload complete'}
                    {uploadState.status === 'error' && 'Upload issue'}
                  </div>
                  <div className="mt-1 text-sm truncate">{uploadState.filename}</div>
                  <div className="mt-1 text-xs opacity-80">
                    {formatFileSize(uploadState.size)}
                    {uploadState.path ? ` • ${uploadState.path}` : ''}
                  </div>
                  {uploadState.message && (
                    <div className="mt-1 text-xs opacity-90">{uploadState.message}</div>
                  )}
                </div>
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (!isUploading) setUploadState(null);
                  }}
                  disabled={isUploading}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    isUploading
                      ? 'bg-slate-800/60 text-slate-500'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white'
                  }`}
                  title={isUploading ? 'Upload in progress' : 'Dismiss upload status'}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {uploadState.status === 'uploading' && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-slate-300">
                    <span>Sending to server</span>
                    <span>{Math.max(0, Math.min(100, uploadState.progress || 0))}%</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-cyan-400 transition-[width] duration-150"
                      style={{ width: `${Math.max(4, Math.min(100, uploadState.progress || 0))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <InputArea
            value={inputText}
            onChange={setInputText}
            onSend={sendMessage}
            onCancel={cancelMessage}
            onUploadFiles={handleUploadFiles}
            visible={showInput}
          />

          <input
            ref={fileInputRef}
            id="file-upload-input"
            type="file"
            accept="image/*,video/*,application/pdf"
            onChange={handleFileChange}
            className="hidden"
          />

          <div className="flex items-center gap-4">
            {!showInput && (
              <div ref={recordingControlsRef} className="flex items-center gap-4">
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    openSessionMenu();
                  }}
                  className="relative w-12 h-12 rounded-full flex items-center justify-center bg-slate-900 border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors touch-none select-none"
                  title="Open tmux session selector"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4zm2 2h6v2H6V9zm0 4h9v2H6v-2z" />
                  </svg>
                  {totalUnreadCompletions > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-cyan-500 text-[10px] leading-[1.1rem] text-white font-semibold text-center">
                      {totalUnreadCompletions > 9 ? '9+' : totalUnreadCompletions}
                    </span>
                  )}
                </button>

                <MicButton
                  isRecording={speech.isListening}
                  audioLevel={speech.audioLevel}
                  isProcessing={isMicInCancelMode}
                  isSendMode={false}
                  disabled={!ws.sessionRunning || isTranscribing}
                  onClick={toggleRecording}
                  onCancel={cancelMicAction}
                  onLongPress={openSessionMenu}
                />

                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    openKeyboardInput();
                  }}
                  className="w-12 h-12 rounded-full flex items-center justify-center bg-slate-900 border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors touch-none select-none"
                  title="Type input"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 6h18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 2v8h18V8H3zm2 2h2v2H5v-2zm3 0h2v2H8v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2zM5 13h10v2H5v-2z" />
                  </svg>
                </button>
              </div>
            )}

            <label
              htmlFor="file-upload-input"
              className={`w-12 h-12 rounded-full flex items-center justify-center border transition-colors select-none ${
                isUploading
                  ? 'bg-slate-900/60 border-slate-800 text-slate-500 cursor-not-allowed pointer-events-none'
                  : 'bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800 cursor-pointer'
              }`}
              title={isUploading ? 'Upload in progress' : 'Upload file'}
            >
              {isUploading ? (
                <div className="relative w-5 h-5">
                  <div className="absolute inset-0 rounded-full border-2 border-slate-700" />
                  <div
                    className="absolute inset-0 rounded-full border-2 border-cyan-400 border-t-transparent"
                    style={{ transform: `rotate(${Math.round((uploadState.progress || 0) * 3.6)}deg)` }}
                  />
                </div>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.9-9.9a4 4 0 1 1 5.66 5.66l-9.2 9.2a2 2 0 1 1-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </label>
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
        onReviewSession={handleReviewTmuxSession}
        onCreateClaude={handleCreateClaudeSession}
        onCreateCodex={handleCreateCodexSession}
        onClose={() => setShowSessionMenu(false)}
      />

      <SettingsPanel
        open={showSettings}
        autoSend={autoSend}
        onToggleAutoSend={toggleAutoSend}
        ttsEnabled={ttsEnabled}
        onToggleTTSEnabled={toggleTTSEnabled}
        orchestrator={selectedOrchestrator}
        orchestratorOptions={ORCHESTRATOR_OPTIONS.filter((o) => (ws.supportedOrchestrators || []).includes(o.value))}
        onSelectOrchestrator={handleSelectOrchestrator}
        onRefresh={() => location.reload()}
        onRestartSession={restartSession}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}
