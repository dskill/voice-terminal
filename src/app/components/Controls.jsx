import React from 'react';

function StatusBadge({ label, connected }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-[0.65rem] font-medium ${
        connected
          ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-700/30'
          : 'bg-red-900/50 text-red-400 border border-red-700/30'
      }`}
    >
      {label}
    </span>
  );
}

export default function Controls({
  isConnected,
  claudeRunning,
  onRestartSession,
  onRefresh,
}) {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap px-2 pb-2">
      <StatusBadge label={`WS: ${isConnected ? 'On' : 'Off'}`} connected={isConnected} />
      <StatusBadge
        label={`Claude: ${claudeRunning ? 'On' : 'Off'}`}
        connected={claudeRunning}
      />

      <button
        onClick={onRestartSession}
        disabled={!isConnected}
        className="px-3 py-0.5 rounded text-[0.65rem] font-medium border transition-colors disabled:opacity-40 bg-amber-600/80 border-amber-500/50 text-white hover:bg-amber-500"
      >
        Restart
      </button>

      <button
        onClick={onRefresh}
        className="px-2 py-0.5 rounded text-[0.65rem] bg-slate-700/50 text-slate-400 border border-slate-600/30 hover:bg-blue-600 hover:text-white hover:border-blue-500 transition-colors"
      >
        Refresh
      </button>
    </div>
  );
}
