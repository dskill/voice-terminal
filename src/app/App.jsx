import React, { useState, useCallback, useEffect, useRef } from 'react';
import useWebSocket from './hooks/useWebSocket';
import useSpeechRecognition from './hooks/useSpeechRecognition';
import useTTS from './hooks/useTTS';
import LoadingOverlay from './components/LoadingOverlay';
import Header from './components/Header';
import TranscriptArea from './components/TranscriptArea';
import Controls from './components/Controls';
import MicButton from './components/MicButton';
import InputArea from './components/InputArea';

export default function App() {
  const [initialized, setInitialized] = useState(false);
  const [messages, setMessages] = useState([]);
  const [streamingMessage, setStreamingMessage] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [contextPercent, setContextPercent] = useState(0);

  const ws = useWebSocket();
  const speech = useSpeechRecognition();
  const tts = useTTS();
  const ttsMetaRef = useRef(null);

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
        }));
        setMessages(restored);
      }
    });

    ws.setHandler('session-init', (data) => {
      addMessage('status', `Session started (${formatModelName(data.model || '')})`);
    });

    ws.setHandler('session-ended', (data) => {
      addMessage('status', `Claude session ended (code: ${data.code})`);
    });

    ws.setHandler('status', (data) => {
      setLiveText(data.message);
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
        const toolCalls = prev?.toolCalls || [];
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
  }, [ws.setHandler, addMessage, tts.playAudio]);

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
      setInputText(text);
      setShowInput(true);
      setLiveText('Review or tap send');
    } catch (err) {
      setLiveText(`Transcription failed: ${err.message || 'unknown error'}`);
      setShowInput(false);
      setInputText('');
    } finally {
      setIsTranscribing(false);
    }
  }, [speech, ws]);

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
    ws.sendCommand(text);
  }, [inputText, addMessage, ws]);

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

  const toggleSession = useCallback(() => {
    if (ws.claudeRunning) {
      ws.stopSession();
    } else {
      ws.startSession();
    }
  }, [ws]);

  const handleClearHistory = useCallback(() => {
    ws.clearHistory();
    setMessages([]);
    addMessage('status', 'History cleared.');
  }, [ws, addMessage]);

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
      <Header />

      <div className="flex-1 flex flex-col p-4 overflow-hidden min-h-0">
        <TranscriptArea messages={messages} streamingMessage={streamingMessage} />

        <div className="flex-shrink-0 flex flex-col items-center gap-3 pt-4 border-t border-slate-800/50 mt-4">
          <Controls
            isConnected={ws.isConnected}
            claudeRunning={ws.claudeRunning}
            currentModel={ws.currentModel}
            contextPercent={contextPercent}
            onToggleSession={toggleSession}
            onClearHistory={handleClearHistory}
            onRefresh={() => location.reload()}
          />

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

          <MicButton
            isRecording={speech.isListening}
            isProcessing={isProcessing}
            isSendMode={showInput}
            disabled={!ws.claudeRunning || isTranscribing}
            onClick={showInput ? sendMessage : toggleRecording}
            onCancel={cancelProcessing}
          />
        </div>
      </div>
    </div>
  );
}

function formatModelName(model) {
  if (!model) return 'Unknown';
  const match = model.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return `${name} ${match[2]}.${match[3]}`;
  }
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model;
}
