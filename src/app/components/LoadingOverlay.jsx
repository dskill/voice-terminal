import React, { useState } from 'react';

export default function LoadingOverlay({ onStart }) {
  const [status, setStatus] = useState('idle'); // idle | initializing | ready | error
  const [logs, setLogs] = useState([]);

  function addLog(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { text: `[${time}] ${msg}`, isError }]);
  }

  async function handleStart() {
    setStatus('initializing');
    setLogs([]);

    try {
      addLog('Checking browser capabilities...');

      addLog('Requesting microphone permission...');
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        addLog('Microphone permission granted');
      } catch (e) {
        addLog(`Microphone permission denied: ${e.message}`, true);
        throw e;
      }

      // Unlock TTS on this user gesture (important for mobile browsers)
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
        addLog('Audio output unlocked');
      }

      addLog('Ready!');
      setStatus('ready');

      setTimeout(() => onStart(), 500);
    } catch (error) {
      addLog(`Initialization failed: ${error.message}`, true);
      setStatus('error');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/95 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-6 max-w-lg w-full px-6">
        <h1 className="text-2xl font-semibold text-slate-100">Voice Terminal</h1>

        <button
          onClick={handleStart}
          disabled={status === 'initializing'}
          className="px-8 py-4 text-lg font-medium rounded-xl bg-gradient-to-r from-blue-500 to-blue-700 text-white shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {status === 'idle' && 'Start Voice Terminal'}
          {status === 'initializing' && 'Initializing...'}
          {status === 'error' && 'Failed — Try Again'}
          {status === 'ready' && 'Starting...'}
        </button>

        {logs.length > 0 && (
          <div className="w-full max-h-64 overflow-y-auto rounded-lg bg-slate-900 border border-slate-700 p-3 font-mono text-xs leading-relaxed">
            {logs.map((log, i) => (
              <div key={i} className={log.isError ? 'text-red-400' : 'text-emerald-400'}>
                {log.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
