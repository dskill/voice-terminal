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
  onRestartSession,
  onClose
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/95 shadow-2xl pointer-events-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-slate-800">
            <div className="text-base font-semibold text-slate-100">Settings</div>
            <div className="text-xs text-slate-400 mt-1">Voice Boss controls and behavior.</div>
          </div>

          <div className="p-4 space-y-4">
            <label className="flex flex-col gap-2 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-700">
              <div>
                <div className="text-sm text-slate-100 font-medium">Orchestrator</div>
                <div className="text-xs text-slate-400">Choose which backend agent runs voice commands.</div>
              </div>
              <select
                value={orchestrator}
                onChange={(e) => onSelectOrchestrator(e.target.value)}
                className="w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
              >
                {orchestratorOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-700">
              <div>
                <div className="text-sm text-slate-100 font-medium">Auto-send</div>
                <div className="text-xs text-slate-400">Send transcript immediately after transcription.</div>
              </div>
              <input
                type="checkbox"
                checked={autoSend}
                onChange={(e) => onToggleAutoSend(e.target.checked)}
                className="w-4 h-4 accent-cyan-500"
              />
            </label>

            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-700">
              <div>
                <div className="text-sm text-slate-100 font-medium">Enable TTS</div>
                <div className="text-xs text-slate-400">Play spoken response audio for assistant replies.</div>
              </div>
              <input
                type="checkbox"
                checked={ttsEnabled}
                onChange={(e) => onToggleTTSEnabled(e.target.checked)}
                className="w-4 h-4 accent-cyan-500"
              />
            </label>

            <button
              onClick={onRestartSession}
              className="w-full px-3 py-2 rounded-lg text-sm font-medium border bg-cyan-700/70 border-cyan-500/40 text-cyan-50 hover:bg-cyan-600/80 transition-colors"
            >
              Restart Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
