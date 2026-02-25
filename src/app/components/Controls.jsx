import React from 'react';

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
  return model.split('-').slice(1, 3).join(' ');
}

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

function ContextBar({ percent }) {
  let fillColor = 'bg-emerald-500';
  if (percent >= 80) fillColor = 'bg-red-500';
  else if (percent >= 60) fillColor = 'bg-amber-500';

  return (
    <div className="w-14 h-1.5 bg-slate-700 rounded-full overflow-hidden" title={`Context: ${percent}%`}>
      <div
        className={`h-full ${fillColor} transition-all duration-300`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export default function Controls({
  isConnected,
  claudeRunning,
  currentModel,
  contextPercent,
  onToggleSession,
  onClearHistory,
  onRefresh,
}) {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap px-2 pb-2">
      <StatusBadge label={`WS: ${isConnected ? 'On' : 'Off'}`} connected={isConnected} />
      <StatusBadge
        label={`Claude: ${claudeRunning ? formatModelName(currentModel) : 'Off'}`}
        connected={claudeRunning}
      />

      <button
        onClick={onToggleSession}
        disabled={!isConnected}
        className={`px-3 py-0.5 rounded text-[0.65rem] font-medium border transition-colors disabled:opacity-40 ${
          claudeRunning
            ? 'bg-red-600/80 border-red-500/50 text-white hover:bg-red-500'
            : 'bg-blue-600/80 border-blue-500/50 text-white hover:bg-blue-500'
        }`}
      >
        {claudeRunning ? 'Stop' : 'Start'}
      </button>

      <button
        onClick={onClearHistory}
        className="px-2 py-0.5 rounded text-[0.65rem] bg-slate-700/50 text-slate-400 border border-slate-600/30 hover:bg-red-600 hover:text-white hover:border-red-500 transition-colors"
      >
        Clear
      </button>

      <button
        onClick={onRefresh}
        className="px-2 py-0.5 rounded text-[0.65rem] bg-slate-700/50 text-slate-400 border border-slate-600/30 hover:bg-blue-600 hover:text-white hover:border-blue-500 transition-colors"
      >
        Refresh
      </button>

      <ContextBar percent={contextPercent} />
    </div>
  );
}
