import React from 'react';

export default function SettingsPanel({
  open,
  autoSend,
  onToggleAutoSend,
  ttsEnabled,
  onToggleTTSEnabled,
  orchestrator,
  orchestratorOptions,
  onSelectOrchestrator,
  onRefresh,
  onRestartSession,
  onClose
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="w-full max-w-md rounded-lg border border-zinc-700/50 bg-zinc-900/98 shadow-2xl pointer-events-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-zinc-800/60">
            <div className="text-base font-semibold text-zinc-100">Settings</div>
            <div className="text-xs text-zinc-400 mt-1">Controls and behavior.</div>
          </div>

          <div className="p-4 space-y-3">
            <label className="flex flex-col gap-2 px-3 py-2 rounded bg-zinc-950/50 border border-zinc-800/50">
              <div>
                <div className="text-sm text-zinc-300 font-medium">Orchestrator</div>
                <div className="text-xs text-zinc-500">Backend agent for voice commands.</div>
              </div>
              <select
                value={orchestrator}
                onChange={(e) => onSelectOrchestrator(e.target.value)}
                className="w-full rounded border border-zinc-700/60 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900 transition-colors cursor-pointer"
              >
                {orchestratorOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-zinc-950/50 border border-zinc-800/50">
              <div>
                <div className="text-sm text-zinc-300 font-medium">Auto-send</div>
                <div className="text-xs text-zinc-500">Send transcript immediately after transcription.</div>
              </div>
              <input
                type="checkbox"
                checked={autoSend}
                onChange={(e) => onToggleAutoSend(e.target.checked)}
                className="w-4 h-4 accent-emerald-500"
              />
            </label>

            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-zinc-950/50 border border-zinc-800/50">
              <div>
                <div className="text-sm text-zinc-300 font-medium">Audio Output</div>
                <div className="text-xs text-zinc-500">Mute/unmute spoken response audio.</div>
              </div>
              <button
                onClick={() => onToggleTTSEnabled(!ttsEnabled)}
                className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
                  ttsEnabled
                    ? 'bg-emerald-950/40 border-emerald-800/40 text-emerald-400 hover:bg-emerald-950/60'
                    : 'bg-red-950/30 border-red-900/30 text-red-400 hover:bg-red-950/50'
                }`}
              >
                {ttsEnabled ? 'Audio On' : 'Audio Off'}
              </button>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={onRefresh}
                className="w-full px-3 py-2 rounded text-sm font-medium border bg-zinc-800/60 border-zinc-700/40 text-zinc-300 hover:bg-zinc-700/60 transition-colors"
              >
                Refresh App
              </button>

              <button
                onClick={onRestartSession}
                className="w-full px-3 py-2 rounded text-sm font-medium border bg-zinc-800/60 border-zinc-700/40 text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors"
              >
                Restart Session
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
