import React, { useMemo } from 'react';

function SessionPill({ label, sublabel, active, onClick, plus = false, state = null, unreadCount = 0, onReview = null }) {
  const showStatus = !plus && !!state;
  const isWorking = state === 'working';
  const hasReview = !plus && !!onReview;
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-2xl border shadow-lg px-4 py-3 text-left transition-colors ${
        active
          ? 'bg-cyan-800/65 border-cyan-500/60 text-white'
          : plus
            ? 'bg-indigo-800/65 border-indigo-500/50 text-white hover:bg-indigo-700/70'
            : 'bg-slate-900/90 border-slate-700 text-slate-100 hover:bg-slate-800/90'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold break-words whitespace-normal">{label}</div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasReview && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReview();
              }}
              className="px-3 h-8 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-cyan-200 border border-slate-600/60 flex items-center justify-center text-xs font-semibold"
              title="Review this session"
            >
              Review
            </button>
          )}
          {(showStatus || unreadCount > 0) && (
            <div className="flex items-center gap-1.5 shrink-0">
              {showStatus && (
                <span
                  className={`inline-block w-2 h-2 rounded-full ${isWorking ? 'bg-emerald-400' : 'bg-slate-400'}`}
                  title={isWorking ? 'Working' : 'Idle'}
                />
              )}
              {unreadCount > 0 && (
                <span className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-cyan-500 text-[10px] leading-[1.1rem] text-white font-semibold text-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
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
  statusBySession,
  unreadCompletions,
  onSelectSession,
  onReviewSession,
  onCreateClaude,
  onCreateCodex,
  onClose
}) {
  const sessionItems = useMemo(() => sessions || [], [sessions]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div className="w-full max-w-xl max-h-[85vh] rounded-3xl border border-slate-700 bg-slate-900/95 shadow-2xl overflow-hidden pointer-events-auto" onClick={(e) => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-slate-800">
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
                    state={statusBySession?.[session.name]?.state || null}
                    unreadCount={Number(unreadCompletions?.[session.name] || 0)}
                    onClick={() => onSelectSession(session.name)}
                    onReview={() => onReviewSession(session.name)}
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
