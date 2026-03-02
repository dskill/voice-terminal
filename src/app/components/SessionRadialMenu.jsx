import React, { useMemo } from 'react';

function SessionPill({ label, sublabel, active, onClick, plus = false }) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-2xl border shadow-lg px-4 py-3 text-left transition-colors ${
        active
          ? 'bg-emerald-700/90 border-emerald-400 text-white'
          : plus
            ? 'bg-blue-700/90 border-blue-400 text-white hover:bg-blue-600/90'
            : 'bg-slate-800/90 border-slate-600 text-slate-100 hover:bg-slate-700/90'
      }`}
    >
      <div className="text-sm font-semibold break-words whitespace-normal">{label}</div>
      {sublabel && (
        <div className="text-xs text-slate-300 break-words whitespace-normal mt-1">
          {sublabel}
        </div>
      )}
    </button>
  );
}

export default function SessionRadialMenu({
  open,
  sessions,
  activeSession,
  onSelectSession,
  onCreateClaude,
  onCreateCodex,
  onClose
}) {
  const sessionItems = useMemo(() => sessions || [], [sessions]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-0 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        <div className="w-full max-w-xl max-h-[85vh] rounded-3xl border border-slate-600 bg-slate-900/95 shadow-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-700">
            <div className="text-base font-semibold text-slate-100">Tmux Sessions</div>
            <div className="text-xs text-slate-400 mt-1">
              Tap a session to attach. Tap outside this panel to close.
            </div>
          </div>

          <div className="p-4 space-y-3 overflow-y-auto max-h-[62vh]">
            <SessionPill
              label="None"
              sublabel="Detach from tmux session targeting"
              active={!activeSession}
              onClick={() => onSelectSession(null)}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SessionPill
                label="+ Claude"
                sublabel="Create new tmux session and run claude --dangerously-skip-permissions"
                plus
                onClick={onCreateClaude}
              />
              <SessionPill
                label="+ Codex"
                sublabel="Create new tmux session and run codex --sandbox danger-full-access --ask-for-approval never"
                plus
                onClick={onCreateCodex}
              />
            </div>

            {sessionItems.length > 0 ? (
              <div className="space-y-2">
                {sessionItems.map((session) => (
                  <SessionPill
                    key={session.name}
                    label={session.name}
                    sublabel={session.label}
                    active={activeSession === session.name}
                    onClick={() => onSelectSession(session.name)}
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-slate-400 px-1 py-2">
                No tmux sessions found.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
