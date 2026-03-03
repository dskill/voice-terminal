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
  onOpenSettings,
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

      <button
        onClick={onOpenSettings}
        className="w-8 h-8 rounded-md bg-slate-700/50 text-slate-300 border border-slate-600/30 hover:bg-slate-600 hover:text-white transition-colors flex items-center justify-center"
        title="Open settings"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
        </svg>
      </button>
    </div>
  );
}
