import React from 'react';

function StatusBadge({ label, connected }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-[0.65rem] font-medium ${
        connected
          ? 'bg-cyan-900/30 text-cyan-300 border border-cyan-700/30'
          : 'bg-rose-900/30 text-rose-300 border border-rose-700/30'
      }`}
    >
      {label}
    </span>
  );
}

export default function Controls({
  isConnected,
  claudeRunning,
  onRefresh,
}) {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap px-3 py-3">
      <StatusBadge label={`WS: ${isConnected ? 'On' : 'Off'}`} connected={isConnected} />
      <StatusBadge
        label={`Claude: ${claudeRunning ? 'On' : 'Off'}`}
        connected={claudeRunning}
      />

      <button
        onClick={onRefresh}
        className="px-2 py-0.5 rounded text-[0.65rem] bg-slate-800/70 text-slate-300 border border-slate-700/50 hover:bg-slate-700 hover:text-white hover:border-slate-500 transition-colors"
      >
        Refresh
      </button>
    </div>
  );
}
