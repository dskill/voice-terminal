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

      // Unlock AudioContext on this user gesture (important for mobile browsers)
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume();
        ctx.close();
        addLog('Audio output unlocked');
      } catch (e) {
        addLog('Audio unlock skipped');
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
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-zinc-950/98 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-6 max-w-lg w-full px-6">
        <h1 className="text-2xl font-semibold text-zinc-100">Voice Terminal</h1>

        <button
          onClick={handleStart}
          disabled={status === 'initializing'}
          className="px-8 py-4 text-lg font-medium rounded-xl bg-gradient-to-r from-cyan-600 to-cyan-800 text-white shadow-lg shadow-cyan-900/30 hover:shadow-cyan-800/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === 'idle' && 'Initialize'}
          {status === 'initializing' && 'Initializing...'}
          {status === 'error' && 'Failed — Retry'}
          {status === 'ready' && 'Starting...'}
        </button>

        {logs.length > 0 && (
          <div className="w-full max-h-64 overflow-y-auto rounded-lg bg-zinc-900 border border-zinc-800 p-3 font-mono text-xs leading-relaxed">
            {logs.map((log, i) => (
              <div key={i} className={log.isError ? 'text-red-400' : 'text-emerald-400/80'}>
                {log.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
