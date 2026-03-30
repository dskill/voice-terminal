import React from 'react';

function StatusBadge({ label, connected }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-[0.65rem] font-medium ${
        connected
          ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/30'
          : 'bg-red-950/30 text-red-400 border border-red-900/30'
      }`}
    >
      {label}
    </span>
  );
}

export default function Controls({
  isConnected,
  sessionRunning,
  orchestratorLabel,
  audioEnabled,
  audioUnlocked
}) {
  const audioLabel = !audioEnabled ? 'Audio: Off' : (audioUnlocked ? 'Audio: On' : 'Audio: Locked');
  const audioConnected = audioEnabled && audioUnlocked;
  const statusOrchestratorLabel = (
    orchestratorLabel === 'Claude Sonnet 4.6' || orchestratorLabel === 'Claude Opus 4.6'
  ) ? 'LLM' : orchestratorLabel;

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap px-3 py-2">
      <StatusBadge label={`WS: ${isConnected ? 'On' : 'Off'}`} connected={isConnected} />
      <StatusBadge
        label={`${statusOrchestratorLabel}: ${sessionRunning ? 'On' : 'Off'}`}
        connected={sessionRunning}
      />
      <StatusBadge label={audioLabel} connected={audioConnected} />
    </div>
  );
}
