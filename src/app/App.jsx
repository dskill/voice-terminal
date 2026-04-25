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

function formatVmUpdateSummary(update) {
  if (!update) return 'No update check yet';
  if (update.error) return 'Check failed';

  let gitText = 'git status unknown';
  if (update.gitState === 'up-to-date') gitText = 'up to date';
  else if (update.gitState === 'behind') gitText = `behind by ${Number(update.behindCount || 0)} commits`;
  else if (update.gitState === 'ahead') gitText = `ahead by ${Number(update.aheadCount || 0)} commits`;
  else if (update.gitState === 'diverged') {
    gitText = `diverged (${Number(update.aheadCount || 0)} ahead, ${Number(update.behindCount || 0)} behind)`;
  }

  const serverText = update.serverRunning ? 'server running' : 'server down';
  const ttsText = update.ttsHealthy === true
    ? 'tts ok'
    : (update.ttsHealthy === false
      ? `tts issue${update.ttsIssue ? ` (${update.ttsIssue})` : ''}`
      : 'tts unknown');
  return `${gitText} / ${serverText} / ${ttsText}`;
}

function vmUpdateTone(update) {
  if (!update) return 'text-zinc-400';
  if (update.error) return 'text-red-400/80';
  if (!update.serverRunning) return 'text-red-400/80';
  if (update.ttsHealthy === false) return 'text-amber-400/70';
  if (update.gitState === 'behind' || update.gitState === 'diverged') return 'text-amber-400/70';
  if (update.gitState === 'up-to-date') return 'text-emerald-400/70';
  return 'text-zinc-400';
}

function formatVmUpdateAllSummary(result) {
  if (!result) return '';
  if (result.success) return 'Update all succeeded';
  return `Update all failed${result.error ? `: ${result.error}` : ''}`;
}

function vmUpdateAllTone(result) {
  if (!result) return 'text-zinc-400';
  return result.success ? 'text-emerald-400/70' : 'text-red-400/80';
}

const VOICE_BOSS_URL = 'https://voiceboss.exe.xyz:3456/';
const VM_UPDATE_LOG_LIMIT = 400;

function createRunId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const ORCHESTRATOR_OPTIONS = [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude', label: 'Claude Opus 4.7' },
    { value: 'codex', label: 'Codex (Spark)' },
  ];
  const formatOrchestratorLabel = (kind) => {
    if (kind === 'codex') return 'Codex (Spark)';
    if (kind === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6';
    return 'Claude Opus 4.7';
  };
  const formatStatusOrchestratorLabel = (kind) => {
    if (kind === 'codex') return 'Codex (Spark)';
    return 'LLM';
  };

  const [messages, setMessages] = useState([]);
  const [streamingMessage, setStreamingMessage] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVmSessions, setShowVmSessions] = useState(false);
  const [vmSessions, setVmSessions] = useState([]);
  const [vmSessionsLoading, setVmSessionsLoading] = useState(false);
  const [vmSessionsError, setVmSessionsError] = useState('');
  const [vmUpdatesByName, setVmUpdatesByName] = useState({});
  const [vmUpdatesLoading, setVmUpdatesLoading] = useState(false);
  const [vmUpdatesError, setVmUpdatesError] = useState('');
  const [vmUpdateAllByName, setVmUpdateAllByName] = useState({});
  const [vmUpdateAllLoading, setVmUpdateAllLoading] = useState(false);
  const [vmUpdateAllError, setVmUpdateAllError] = useState('');
  const [vmSingleUpdateLoadingName, setVmSingleUpdateLoadingName] = useState('');
  const [vmSingleAuthLoadingName, setVmSingleAuthLoadingName] = useState('');
  const [vmUpdateRunState, setVmUpdateRunState] = useState({
    runId: '',
    scope: '',
    vmName: '',
    action: '',
    phase: 'idle',
    message: '',
    totalSessions: 0,
    completedSessions: 0,
    currentSession: '',
    logs: []
  });
  const [showVmUpdateProgressPanel, setShowVmUpdateProgressPanel] = useState(false);
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
  const vmUpdateRunIdRef = useRef('');
  const vmUpdateInlineLogRef = useRef(null);
  const vmUpdateGlobalLogRef = useRef(null);
  const singleVmProgressHideTimerRef = useRef(null);

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

    ws.setHandler('vm-update-progress', (data) => {
      if (!data || !data.runId) return;

      const incomingRunId = String(data.runId || '').trim();
      if (!incomingRunId) return;

      if (!vmUpdateRunIdRef.current || incomingRunId !== vmUpdateRunIdRef.current) {
        return;
      }

      setShowVmUpdateProgressPanel(true);

      setVmUpdateRunState((prev) => {
        const next = {
          ...prev,
          runId: incomingRunId,
          phase: data?.phase || prev.phase,
          message: data?.message || prev.message,
          totalSessions: Number.isFinite(Number(data?.totalSessions))
            ? Number(data.totalSessions)
            : prev.totalSessions,
          completedSessions: Number.isFinite(Number(data?.completedSessions))
            ? Number(data.completedSessions)
            : prev.completedSessions,
          currentSession: data?.sessionName || prev.currentSession
        };

        if (data?.phase === 'session-log' && typeof data?.line === 'string') {
          const streamTag = data?.stream === 'stderr' ? 'stderr' : 'stdout';
          const sessionLabel = data?.sessionName || next.currentSession || 'vm';
          const line = `[${sessionLabel}/${streamTag}] ${data.line}`;
          next.logs = [...(Array.isArray(prev.logs) ? prev.logs : []), line].slice(-VM_UPDATE_LOG_LIMIT);
        } else if (data?.phase === 'session-start') {
          const line = `==> ${data?.sessionName || 'vm'}: update started`;
          next.logs = [...(Array.isArray(prev.logs) ? prev.logs : []), line].slice(-VM_UPDATE_LOG_LIMIT);
        } else if (data?.phase === 'session-complete') {
          const outcome = data?.success ? 'success' : 'failed';
          const extra = data?.error ? ` (${data.error})` : '';
          const line = `==> ${data?.sessionName || 'vm'}: update ${outcome}${extra}`;
          next.logs = [...(Array.isArray(prev.logs) ? prev.logs : []), line].slice(-VM_UPDATE_LOG_LIMIT);
        } else if (data?.phase === 'error') {
          const line = `Update failed: ${data?.message || 'unknown error'}`;
          next.logs = [...(Array.isArray(prev.logs) ? prev.logs : []), line].slice(-VM_UPDATE_LOG_LIMIT);
        } else if (data?.phase === 'cancelled') {
          const line = `Update cancelled: ${data?.message || ''}`;
          next.logs = [...(Array.isArray(prev.logs) ? prev.logs : []), line].slice(-VM_UPDATE_LOG_LIMIT);
        } else {
          next.logs = prev.logs;
        }

        return next;
      });
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
    const hasLogs = Array.isArray(vmUpdateRunState.logs) && vmUpdateRunState.logs.length > 0;
    if (!showVmSessions || !hasLogs) return;

    const rafId = requestAnimationFrame(() => {
      const target = vmUpdateRunState.scope === 'single'
        ? vmUpdateInlineLogRef.current
        : vmUpdateGlobalLogRef.current;
      if (!target) return;
      target.scrollTop = target.scrollHeight;
    });

    return () => cancelAnimationFrame(rafId);
  }, [showVmSessions, vmUpdateRunState.scope, vmUpdateRunState.logs]);

  useEffect(() => {
    const isSingleRun = vmUpdateRunState.scope === 'single';
    const isTerminalPhase = vmUpdateRunState.phase === 'complete'
      || vmUpdateRunState.phase === 'error'
      || vmUpdateRunState.phase === 'cancelled';
    if (!showVmUpdateProgressPanel || !isSingleRun || !isTerminalPhase) return;

    if (singleVmProgressHideTimerRef.current) {
      clearTimeout(singleVmProgressHideTimerRef.current);
    }
    singleVmProgressHideTimerRef.current = setTimeout(() => {
      setShowVmUpdateProgressPanel(false);
      singleVmProgressHideTimerRef.current = null;
    }, 4500);

    return () => {
      if (singleVmProgressHideTimerRef.current) {
        clearTimeout(singleVmProgressHideTimerRef.current);
        singleVmProgressHideTimerRef.current = null;
      }
    };
  }, [showVmUpdateProgressPanel, vmUpdateRunState.scope, vmUpdateRunState.phase]);

  useEffect(() => {
    if (!showVmSessions) {
      setShowVmUpdateProgressPanel(false);
    }
  }, [showVmSessions]);

  useEffect(() => {
    return () => {
      if (singleVmProgressHideTimerRef.current) {
        clearTimeout(singleVmProgressHideTimerRef.current);
        singleVmProgressHideTimerRef.current = null;
      }
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

  const fetchVmSessions = useCallback(async () => {
    setVmSessionsLoading(true);
    setVmSessions([]);
    setVmSessionsError('');
    setVmUpdatesByName({});
    setVmUpdatesError('');
    try {
      const response = await fetch('/api/vm-sessions');
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = await response.json();
      const sessions = Array.isArray(data) ? data : [];
      sessions.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
      setVmSessions(sessions);
    } catch (err) {
      setVmSessions([]);
      setVmSessionsError(err?.message || 'Failed to load VM sessions');
    } finally {
      setVmSessionsLoading(false);
    }
  }, []);

  const openVmSessionsModal = useCallback(() => {
    setShowVmSessions(true);
    fetchVmSessions();
  }, [fetchVmSessions]);

  const checkVmUpdates = useCallback(async () => {
    setVmUpdatesLoading(true);
    setVmUpdatesError('');
    try {
      const response = await fetch('/api/vm-sessions/updates');
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = await response.json();
      const sessions = Array.isArray(data) ? data : [];
      const byName = {};
      for (const session of sessions) {
        if (!session?.name || !session?.hasVoiceTerminal) continue;
        byName[session.name] = session.update || null;
      }
      setVmUpdatesByName(byName);
    } catch (err) {
      setVmUpdatesError(err?.message || 'Failed to check VM updates');
    } finally {
      setVmUpdatesLoading(false);
    }
  }, []);

  const runUpdateAll = useCallback(async () => {
    const runId = createRunId();
    vmUpdateRunIdRef.current = runId;
    setShowVmUpdateProgressPanel(true);
    setVmUpdateAllLoading(true);
    setVmUpdateAllError('');
    setVmUpdateAllByName({});
    setVmUpdateRunState({
      runId,
      scope: 'all',
      vmName: '',
      action: 'update-all',
      phase: 'start',
      message: 'Starting update all run...',
      totalSessions: 0,
      completedSessions: 0,
      currentSession: '',
      logs: [`[run ${runId}] starting update-all...`]
    });
    try {
      const response = await fetch(`/api/vm-sessions/update-all?runId=${encodeURIComponent(runId)}`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = await response.json();
      const sessions = Array.isArray(data) ? data : [];
      const byName = {};
      for (const session of sessions) {
        if (!session?.name || !session?.hasVoiceTerminal) continue;
        byName[session.name] = session.updateAll || null;
      }
      setVmUpdateAllByName(byName);
      fetchVmSessions();
    } catch (err) {
      setShowVmUpdateProgressPanel(true);
      setVmUpdateAllError(err?.message || 'Failed to run update-all');
      setVmUpdateRunState((prev) => ({
        ...prev,
        phase: 'error',
        message: err?.message || 'Failed to run update-all',
        logs: [...(Array.isArray(prev.logs) ? prev.logs : []), `Update all failed: ${err?.message || 'unknown error'}`].slice(-VM_UPDATE_LOG_LIMIT)
      }));
    } finally {
      setVmUpdateAllLoading(false);
    }
  }, [fetchVmSessions]);

  const runSingleVmUpdate = useCallback(async (vmName) => {
    const normalized = String(vmName || '').trim().toLowerCase();
    if (!normalized) return;

    const runId = createRunId();
    vmUpdateRunIdRef.current = runId;
    setShowVmUpdateProgressPanel(true);
    setVmSingleUpdateLoadingName(normalized);
    setVmUpdateAllError('');
    setVmUpdateRunState({
      runId,
      scope: 'single',
      vmName: normalized,
      action: 'update',
      phase: 'start',
      message: `Starting update for ${normalized}...`,
      totalSessions: 1,
      completedSessions: 0,
      currentSession: normalized,
      logs: [`[run ${runId}] starting update for ${normalized}...`]
    });

    try {
      const response = await fetch(`/api/vm-sessions/${encodeURIComponent(normalized)}/update?runId=${encodeURIComponent(runId)}`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = await response.json();
      if (data?.name && data?.updateAll) {
        setVmUpdateAllByName((prev) => ({ ...prev, [data.name]: data.updateAll }));
      }
      fetchVmSessions();
    } catch (err) {
      setVmUpdateAllError(err?.message || `Failed to update ${normalized}`);
      setVmUpdateRunState((prev) => ({
        ...prev,
        phase: 'error',
        message: err?.message || `Failed to update ${normalized}`,
        logs: [...(Array.isArray(prev.logs) ? prev.logs : []), `Update failed: ${err?.message || 'unknown error'}`].slice(-VM_UPDATE_LOG_LIMIT)
      }));
    } finally {
      setVmSingleUpdateLoadingName('');
    }
  }, [fetchVmSessions]);

  const runSingleVmAuthUpdate = useCallback(async (vmName) => {
    const normalized = String(vmName || '').trim().toLowerCase();
    if (!normalized) return;

    const runId = createRunId();
    vmUpdateRunIdRef.current = runId;
    setShowVmUpdateProgressPanel(true);
    setVmSingleAuthLoadingName(normalized);
    setVmUpdateAllError('');
    setVmUpdateRunState({
      runId,
      scope: 'single',
      vmName: normalized,
      action: 'auth',
      phase: 'start',
      message: `Starting auth update for ${normalized}...`,
      totalSessions: 1,
      completedSessions: 0,
      currentSession: normalized,
      logs: [`[run ${runId}] starting auth update for ${normalized}...`]
    });

    try {
      const response = await fetch(`/api/vm-sessions/${encodeURIComponent(normalized)}/update-auth?runId=${encodeURIComponent(runId)}`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      await response.json();
    } catch (err) {
      setVmUpdateAllError(err?.message || `Failed to update auth for ${normalized}`);
      setVmUpdateRunState((prev) => ({
        ...prev,
        phase: 'error',
        message: err?.message || `Failed to update auth for ${normalized}`,
        logs: [...(Array.isArray(prev.logs) ? prev.logs : []), `Auth update failed: ${err?.message || 'unknown error'}`].slice(-VM_UPDATE_LOG_LIMIT)
      }));
    } finally {
      setVmSingleAuthLoadingName('');
    }
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
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    const successes = [];
    const failures = [];

    for (const file of files) {
      setUploadState({
        status: 'uploading',
        filename: file.name,
        size: file.size,
        progress: 0
      });

      try {
        const result = await uploadFileWithProgress(file);
        successes.push({
          filename: result.filename || file.name,
          size: Number(result.size ?? file.size ?? 0),
          path: result.path || ''
        });
      } catch (err) {
        const payload = err?.payload || {};
        failures.push({
          filename: payload.filename || file.name,
          size: Number(payload.size ?? file.size ?? 0),
          path: payload.path || '',
          saved: !!payload.saved,
          message: err?.message || 'Upload failed'
        });
      }
    }

    if (failures.length === 0) {
      const first = successes[0] || {};
      setUploadState({
        status: 'success',
        filename: successes.length === 1 ? (first.filename || files[0].name) : `${successes.length} files`,
        size: successes.length === 1 ? Number(first.size || 0) : 0,
        path: successes.length === 1 ? (first.path || '') : '',
        message: successes.length === 1
          ? 'Saved and shared with the agent.'
          : `Saved and shared ${successes.length} files with the agent.`
      });
      return;
    }

    if (successes.length === 0) {
      const firstFailed = failures[0];
      setUploadState({
        status: 'error',
        filename: failures.length === 1 ? firstFailed.filename : `${failures.length} files`,
        size: failures.length === 1 ? Number(firstFailed.size || 0) : 0,
        path: failures.length === 1 ? (firstFailed.path || '') : '',
        message: failures.length === 1
          ? (firstFailed.saved
            ? `Saved file, but could not notify the agent: ${firstFailed.message}`
            : firstFailed.message)
          : `Failed to upload ${failures.length} files.`
      });
      return;
    }

    setUploadState({
      status: 'error',
      filename: `${successes.length + failures.length} files`,
      size: 0,
      path: '',
      message: `Uploaded ${successes.length} file${successes.length === 1 ? '' : 's'}, failed ${failures.length}.`
    });
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
  const activeStatusDot = activeTmuxStatus?.state === 'working' ? 'bg-emerald-400' : 'bg-zinc-500';
  const isMicInCancelMode = isProcessing || tts.isSpeaking;
  const micStatusText = tts.isSpeaking ? 'Speaking...' : liveText;
  const isUploading = uploadState?.status === 'uploading';
  const visibleVmSessions = vmSessions.filter((session) => session?.hasVoiceTerminal !== false);
  const isRestrictedVmSessionMode = !vmSessionsLoading && !vmSessionsError && visibleVmSessions.length === 0;
  const vmUpdateProgressTotal = Math.max(0, Number(vmUpdateRunState.totalSessions || 0));
  const vmUpdateProgressCompleted = Math.max(0, Number(vmUpdateRunState.completedSessions || 0));
  const vmUpdateProgressPct = vmUpdateProgressTotal > 0
    ? Math.max(0, Math.min(100, Math.round((vmUpdateProgressCompleted / vmUpdateProgressTotal) * 100)))
    : (vmUpdateAllLoading ? 8 : 0);
  const shouldShowVmUpdateProgressPanel = vmUpdateRunState.scope === 'all' && (showVmUpdateProgressPanel
    || vmUpdateRunState.phase === 'complete'
    || vmUpdateRunState.phase === 'error'
    || vmUpdateRunState.phase === 'cancelled'
    || (Array.isArray(vmUpdateRunState.logs) && vmUpdateRunState.logs.length > 0));

  return (
    <div className="h-dvh flex flex-col bg-zinc-950 text-zinc-300">
      <div className="absolute top-2 left-3 z-30 flex items-center gap-2">
        <button
          onClick={openVmSessionsModal}
          className="w-9 h-9 rounded-md bg-zinc-800/85 text-zinc-300 border border-zinc-600/50 hover:bg-zinc-700 hover:text-white transition-colors flex items-center justify-center"
          title="Switch VM session"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
          </svg>
        </button>

      </div>

      <div className="absolute top-2 right-3 z-30 flex items-center gap-2">
        <button
          onClick={() => setShowSettings(true)}
          className="w-9 h-9 rounded-md bg-zinc-800/85 text-zinc-300 border border-zinc-600/50 hover:bg-zinc-700 hover:text-white transition-colors flex items-center justify-center"
          title="Open settings"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
          </svg>
        </button>
      </div>

      <div className="relative z-20 flex items-center justify-center border-b border-zinc-800/80 bg-zinc-900/90 backdrop-blur-sm">
        <Controls
          isConnected={ws.isConnected}
          sessionRunning={ws.sessionRunning}
          orchestratorLabel={formatStatusOrchestratorLabel(ws.orchestrator || selectedOrchestrator)}
          audioEnabled={ttsEnabled}
          audioUnlocked={tts.isAudioUnlocked}
        />
      </div>

      <div className="flex-1 flex flex-col p-4 overflow-hidden min-h-0">
        <TranscriptArea messages={messages} streamingMessage={streamingMessage} />

        <div
          className="relative z-20 flex-shrink-0 flex flex-col items-center gap-3 pt-4 border-t border-zinc-800/70 mt-4"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ttsEnabled && !tts.isAudioUnlocked && (
            <div className="w-full max-w-lg">
              <button
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleEnableAudio();
                }}
                className="w-full px-4 py-3 rounded-lg border border-amber-500/40 bg-amber-900/30 text-amber-100 text-sm font-semibold hover:bg-amber-800/40 transition-colors"
                title={`Tap to enable audio output (AudioContext: ${tts.audioContextState})`}
              >
                Tap to enable audio
              </button>
              <div className="mt-1 text-[11px] text-amber-200/60 text-center">
                AudioContext state: {tts.audioContextState}
              </div>
            </div>
          )}

          <div className="text-xs text-zinc-500 text-center flex items-center gap-2">
            <span>Active tmux: {activeTmuxSession || 'none'}</span>
            {activeTmuxSession && (
              <>
                <span className={`inline-block w-2 h-2 rounded-full ${activeStatusDot}`} />
                <span>{activeStatusText}</span>
              </>
            )}
            {doneFlashVisible && activeTmuxSession && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-800/60 text-emerald-300 text-[10px] font-semibold">
                Done
              </span>
            )}
          </div>

          {ttsEnabled && ws.serverTTSEnabled === false && (
            <div className="text-[11px] text-red-400/70 text-center">
              Server audio state is OFF (resync pending)
            </div>
          )}

          {ttsEnabled && tts.audioIssue && (
            <div className="text-[11px] text-amber-300 text-center max-w-lg px-2">
              Audio issue: {tts.audioIssue}
            </div>
          )}

          {micStatusText && !showInput && (
            <div className="text-sm text-zinc-300 text-center min-h-[1.5em] px-4">
              {micStatusText}
            </div>
          )}

          {uploadState && (
            <div className={`w-full max-w-lg rounded-xl border px-4 py-3 ${
              uploadState.status === 'error'
                ? 'border-red-900/40 bg-red-950/20 text-red-300/80'
                : uploadState.status === 'success'
                  ? 'border-emerald-900/30 bg-emerald-950/20 text-emerald-300/80'
                  : 'border-zinc-700/40 bg-zinc-900/50 text-zinc-300'
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
                      ? 'bg-zinc-800/60 text-zinc-500'
                      : 'bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 hover:text-white'
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
                  <div className="flex items-center justify-between text-xs text-zinc-300">
                    <span>Sending to server</span>
                    <span>{Math.max(0, Math.min(100, uploadState.progress || 0))}%</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-zinc-500 transition-[width] duration-150"
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
            visible={showInput}
          />

          <input
            ref={fileInputRef}
            id="file-upload-input"
            type="file"
            multiple
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
                  className="relative w-12 h-12 rounded-full flex items-center justify-center bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 transition-colors touch-none select-none"
                  title="Open tmux session selector"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4zm2 2h6v2H6V9zm0 4h9v2H6v-2z" />
                  </svg>
                  {totalUnreadCompletions > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-zinc-500 text-[10px] leading-[1.1rem] text-white font-semibold text-center">
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
                  className="w-12 h-12 rounded-full flex items-center justify-center bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 transition-colors touch-none select-none"
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
                  ? 'bg-zinc-900/60 border-zinc-800 text-zinc-500 cursor-not-allowed pointer-events-none'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800 cursor-pointer'
              }`}
              title={isUploading ? 'Upload in progress' : 'Upload file'}
            >
              {isUploading ? (
                <div className="relative w-5 h-5">
                  <div className="absolute inset-0 rounded-full border-2 border-zinc-700" />
                  <div
                    className="absolute inset-0 rounded-full border-2 border-zinc-400 border-t-transparent"
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

      {showVmSessions && (
        <div className="fixed inset-0 z-50 bg-zinc-950/80 backdrop-blur-sm" onClick={() => setShowVmSessions(false)}>
          <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
            <div
              className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900/95 shadow-2xl pointer-events-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-zinc-800 flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-zinc-100">VM Sessions</div>
                  <div className="text-xs text-zinc-400 mt-1">Jump to another voice-terminal VM.</div>
                </div>
                <button
                  onClick={() => setShowVmSessions(false)}
                  className="w-8 h-8 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
                  title="Close VM sessions"
                >
                  <svg className="w-4 h-4 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="p-4 flex flex-col space-y-3 max-h-[60vh]">
                <div className="space-y-3 min-h-0 overflow-auto flex-1">
                  {vmSessionsLoading && (
                    <div className="text-sm text-zinc-300">Loading VM sessions...</div>
                  )}

                  {!vmSessionsLoading && vmSessionsError && (
                    <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-sm text-red-300/80">
                      {vmSessionsError}
                    </div>
                  )}

                  {!vmSessionsLoading && !vmSessionsError && vmUpdatesError && (
                    <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-sm text-red-300/80">
                      {vmUpdatesError}
                    </div>
                  )}

                  {!vmSessionsLoading && !vmSessionsError && vmUpdateAllError && (
                    <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-sm text-red-300/80">
                      {vmUpdateAllError}
                    </div>
                  )}

                  {!vmSessionsLoading && !vmSessionsError && visibleVmSessions.length === 0 && (
                    <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-300">
                      No VMs with voice-terminal detected.
                    </div>
                  )}

                  {!vmSessionsLoading && !vmSessionsError && visibleVmSessions.map((session) => {
                    const isUnreachable = session.hasVoiceTerminal === null;
                    const isUpdatingThisVm = vmSingleUpdateLoadingName === session.name;
                    const isUpdatingAuthThisVm = vmSingleAuthLoadingName === session.name;
                    const isSingleRunForVm = vmUpdateRunState.scope === 'single' && vmUpdateRunState.vmName === session.name;
                    const singleRunActionLabel = vmUpdateRunState.action === 'auth' ? 'Auth update' : 'Update';
                    const showSingleVmProgress = showVmUpdateProgressPanel && isSingleRunForVm && (
                      isUpdatingThisVm
                      || isUpdatingAuthThisVm
                      || vmUpdateRunState.phase === 'complete'
                      || vmUpdateRunState.phase === 'error'
                      || vmUpdateRunState.phase === 'cancelled'
                      || (Array.isArray(vmUpdateRunState.logs) && vmUpdateRunState.logs.length > 0)
                    );

                    return (
                      <div
                        key={session.name}
                        className={`w-full rounded-lg border px-3 py-2 ${isUnreachable ? 'border-zinc-700/50 bg-zinc-900/40' : 'border-zinc-700 bg-zinc-900/70'}`}
                      >
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => {
                              window.location.href = session.url;
                            }}
                            className="flex-1 text-left rounded-md px-2 py-1 -mx-2 -my-1 hover:bg-zinc-800/70 hover:text-white transition-colors"
                          >
                            <div className={`text-sm font-medium ${isUnreachable ? 'text-zinc-400' : 'text-zinc-100'}`}>{session.name}</div>
                            <div className="text-xs text-zinc-500 mt-0.5">{session.url}</div>
                            {isUnreachable
                              ? <div className="text-[11px] mt-1 text-zinc-500">unreachable</div>
                              : <div className={`text-[11px] mt-1 ${vmUpdateTone(vmUpdatesByName[session.name])}`}>
                                  {formatVmUpdateSummary(vmUpdatesByName[session.name])}
                                </div>
                            }
                            {!isUnreachable && vmUpdateAllByName[session.name] && (
                              <div className={`text-[11px] mt-1 ${vmUpdateAllTone(vmUpdateAllByName[session.name])}`}>
                                {formatVmUpdateAllSummary(vmUpdateAllByName[session.name])}
                              </div>
                            )}
                          </button>
                          <button
                            onClick={() => runSingleVmUpdate(session.name)}
                            disabled={
                              isUnreachable
                              || vmUpdateAllLoading
                              || vmUpdatesLoading
                              || vmSessionsLoading
                              || !!vmSingleUpdateLoadingName
                              || !!vmSingleAuthLoadingName
                            }
                            className={`shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                              (isUnreachable
                                || vmUpdateAllLoading
                                || vmUpdatesLoading
                                || vmSessionsLoading
                                || !!vmSingleUpdateLoadingName
                                || !!vmSingleAuthLoadingName)
                                ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                                : 'bg-zinc-700/40 border-zinc-600/40 text-zinc-200 hover:bg-zinc-600/50'
                            }`}
                          >
                            {isUpdatingThisVm ? 'Updating...' : 'Update'}
                          </button>
                          <button
                            onClick={() => runSingleVmAuthUpdate(session.name)}
                            disabled={
                              isUnreachable
                              || vmUpdateAllLoading
                              || vmUpdatesLoading
                              || vmSessionsLoading
                              || !!vmSingleUpdateLoadingName
                              || !!vmSingleAuthLoadingName
                            }
                            className={`shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                              (isUnreachable
                                || vmUpdateAllLoading
                                || vmUpdatesLoading
                                || vmSessionsLoading
                                || !!vmSingleUpdateLoadingName
                                || !!vmSingleAuthLoadingName)
                                ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                                : 'bg-zinc-700/50 border-zinc-600/40 text-zinc-200 hover:bg-zinc-600/60'
                            }`}
                          >
                            {isUpdatingAuthThisVm ? 'Updating...' : 'Update Auth'}
                          </button>
                        </div>

                        {showSingleVmProgress && (
                          <div className="mt-2 rounded-md border border-zinc-700/30 bg-zinc-950/70 px-2 py-2">
                            <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-300">
                              <span className="min-w-0">
                                {vmUpdateRunState.phase === 'complete'
                                  ? `${singleRunActionLabel} complete`
                                  : vmUpdateRunState.phase === 'error'
                                    ? `${singleRunActionLabel} failed`
                                    : vmUpdateRunState.phase === 'cancelled'
                                      ? `${singleRunActionLabel} cancelled`
                                      : `${singleRunActionLabel} in progress...`}
                              </span>
                              <div className="flex items-center gap-2">
                                <span>{vmUpdateProgressTotal > 0 ? `${vmUpdateProgressCompleted}/${vmUpdateProgressTotal}` : 'running'}</span>
                                <button
                                  onClick={() => setShowVmUpdateProgressPanel(false)}
                                  className="w-5 h-5 rounded-full flex items-center justify-center border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                                  title="Dismiss"
                                >
                                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                    <path d="M18 6 6 18M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-[width] duration-200 ${
                                  vmUpdateRunState.phase === 'error' ? 'bg-red-400' : 'bg-emerald-400'
                                }`}
                                style={{ width: `${Math.max(2, vmUpdateProgressPct)}%` }}
                              />
                            </div>
                            <div className="mt-1 text-[10px] text-zinc-400">
                              {vmUpdateRunState.message || 'Processing update...'}
                            </div>
                            <div
                              ref={isSingleRunForVm ? vmUpdateInlineLogRef : undefined}
                              className="mt-1 max-h-24 overflow-auto rounded border border-zinc-800 bg-zinc-950/90 p-1.5"
                            >
                              <pre className="text-[10px] leading-4 text-zinc-300 whitespace-pre-wrap break-words">
                                {(vmUpdateRunState.logs || []).join('\n') || 'No output yet.'}
                              </pre>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {shouldShowVmUpdateProgressPanel && (
                  <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/80 px-3 py-3">
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>
                        {vmUpdateRunState.phase === 'complete'
                          ? 'Update all complete'
                          : vmUpdateRunState.phase === 'error'
                            ? 'Update all failed'
                            : 'Update all in progress'}
                      </span>
                      <span>
                        {vmUpdateProgressTotal > 0
                          ? `${vmUpdateProgressCompleted}/${vmUpdateProgressTotal}`
                          : (vmUpdateAllLoading ? 'running' : 'idle')}
                      </span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-[width] duration-200 ${
                          vmUpdateRunState.phase === 'error' ? 'bg-red-400' : 'bg-zinc-400'
                        }`}
                        style={{ width: `${vmUpdateProgressPct}%` }}
                      />
                    </div>
                    <div className="mt-2 text-[11px] text-zinc-400">
                      {vmUpdateRunState.message || (vmUpdateAllLoading ? 'Updating VMs...' : 'Waiting for update status')}
                    </div>
                    <div
                      ref={vmUpdateRunState.scope === 'all' ? vmUpdateGlobalLogRef : undefined}
                      className="mt-2 rounded-md border border-zinc-700 bg-zinc-950/70 p-2 max-h-36 overflow-auto"
                    >
                      <pre className="text-[10px] leading-4 text-zinc-300 whitespace-pre-wrap break-words">
                        {(vmUpdateRunState.logs || []).length > 0
                          ? vmUpdateRunState.logs.join('\n')
                          : 'No output yet.'}
                      </pre>
                    </div>
                  </div>
                )}

                {isRestrictedVmSessionMode ? (
                  <div className="px-4 pb-4">
                    <a
                      href={VOICE_BOSS_URL}
                      className="w-full inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium border border-zinc-600/40 bg-zinc-700/50 text-zinc-200 hover:bg-zinc-600/60 transition-colors"
                    >
                      Go to Voice Boss
                    </a>
                  </div>
                ) : (
                  <div className="px-4 pb-4 grid grid-cols-3 gap-2">
                    <button
                      onClick={fetchVmSessions}
                      disabled={vmSessionsLoading}
                      className={`w-full px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        vmSessionsLoading
                          ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                          : 'bg-zinc-700/70 border-zinc-500/50 text-zinc-100 hover:bg-zinc-600/80'
                      }`}
                    >
                      Refresh
                    </button>
                    <button
                      onClick={checkVmUpdates}
                      disabled={vmUpdatesLoading || vmUpdateAllLoading || vmSessionsLoading || visibleVmSessions.length === 0}
                      className={`w-full px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        (vmUpdatesLoading || vmUpdateAllLoading || vmSessionsLoading || visibleVmSessions.length === 0)
                          ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                          : 'bg-zinc-700/50 border-zinc-600/40 text-zinc-200 hover:bg-zinc-600/60'
                      }`}
                    >
                      {vmUpdatesLoading ? 'Checking...' : 'Check Updates'}
                    </button>
                    <button
                      onClick={runUpdateAll}
                      disabled={vmUpdateAllLoading || vmUpdatesLoading || vmSessionsLoading || visibleVmSessions.length === 0}
                      className={`w-full px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        (vmUpdateAllLoading || vmUpdatesLoading || vmSessionsLoading || visibleVmSessions.length === 0)
                          ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                          : 'bg-zinc-700/40 border-zinc-600/40 text-zinc-200 hover:bg-zinc-600/50'
                      }`}
                    >
                      {vmUpdateAllLoading ? 'Updating...' : 'Update All'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
