import React from 'react';

export default function SettingsPanel({
  open,
  autoSend,
  onToggleAutoSend,
  ttsEnabled,
  onToggleTTSEnabled,
  onRestartSession,
  onClose
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="w-full max-w-md rounded-2xl border border-slate-600 bg-slate-900/95 shadow-2xl pointer-events-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-slate-700">
            <div className="text-base font-semibold text-slate-100">Settings</div>
            <div className="text-xs text-slate-400 mt-1">Voice terminal controls and behavior.</div>
          </div>

          <div className="p-4 space-y-4">
            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700">
              <div>
                <div className="text-sm text-slate-100 font-medium">Auto-send</div>
                <div className="text-xs text-slate-400">Send transcript immediately after transcription.</div>
              </div>
              <input
                type="checkbox"
                checked={autoSend}
                onChange={(e) => onToggleAutoSend(e.target.checked)}
                className="w-4 h-4 accent-emerald-500"
              />
            </label>

            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700">
              <div>
                <div className="text-sm text-slate-100 font-medium">Enable TTS</div>
                <div className="text-xs text-slate-400">Play spoken response audio for Claude replies.</div>
              </div>
              <input
                type="checkbox"
                checked={ttsEnabled}
                onChange={(e) => onToggleTTSEnabled(e.target.checked)}
                className="w-4 h-4 accent-emerald-500"
              />
            </label>

            <button
              onClick={onRestartSession}
              className="w-full px-3 py-2 rounded-lg text-sm font-medium border bg-amber-600/80 border-amber-500/50 text-white hover:bg-amber-500 transition-colors"
            >
              Restart Claude Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
