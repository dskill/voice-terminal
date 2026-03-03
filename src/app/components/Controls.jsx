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
        className="px-2 py-0.5 rounded text-[0.65rem] bg-slate-700/50 text-slate-400 border border-slate-600/30 hover:bg-blue-600 hover:text-white hover:border-blue-500 transition-colors"
      >
        Refresh
      </button>
    </div>
  );
}
