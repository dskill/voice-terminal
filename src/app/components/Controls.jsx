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
  sessionRunning,
  orchestratorLabel,
  audioEnabled,
  audioUnlocked
}) {
  const audioLabel = !audioEnabled ? 'Audio: Off' : (audioUnlocked ? 'Audio: On' : 'Audio: Locked');
  const audioConnected = audioEnabled && audioUnlocked;

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap px-3 py-3">
      <StatusBadge label={`WS: ${isConnected ? 'On' : 'Off'}`} connected={isConnected} />
      <StatusBadge
        label={`${orchestratorLabel}: ${sessionRunning ? 'On' : 'Off'}`}
        connected={sessionRunning}
      />
      <StatusBadge label={audioLabel} connected={audioConnected} />
    </div>
  );
}
