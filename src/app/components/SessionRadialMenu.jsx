import React, { useMemo } from 'react';

function RingButton({ x, y, label, sublabel, active, onClick, plus = false }) {
  return (
    <button
      onClick={onClick}
      className={`absolute w-24 h-24 rounded-full border shadow-lg px-2 text-center transition-colors ${
        active
          ? 'bg-emerald-700/90 border-emerald-400 text-white'
          : plus
            ? 'bg-blue-700/90 border-blue-400 text-white hover:bg-blue-600/90'
            : 'bg-slate-800/90 border-slate-600 text-slate-100 hover:bg-slate-700/90'
      }`}
      style={{
        left: `calc(50% + ${x}px - 3rem)`,
        top: `calc(50% + ${y}px - 3rem)`,
      }}
    >
      <div className="text-xs font-semibold truncate">{label}</div>
      {sublabel && <div className="text-[10px] text-slate-300 truncate mt-1">{sublabel}</div>}
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
  onClose,
}) {
  const sessionItems = useMemo(() => sessions.slice(0, 8), [sessions]);
  const radius = 170;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()}>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] h-[420px] max-w-[95vw] max-h-[80vh]">
          {sessionItems.map((session, index) => {
            const angle = (-Math.PI / 2) + (2 * Math.PI * index) / Math.max(sessionItems.length, 1);
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            return (
              <RingButton
                key={session.name}
                x={x}
                y={y}
                label={session.name}
                sublabel={session.label}
                active={activeSession === session.name}
                onClick={() => onSelectSession(session.name)}
              />
            );
          })}

          <RingButton
            x={-80}
            y={85}
            label="+ Claude"
            sublabel="new session"
            plus
            onClick={onCreateClaude}
          />
          <RingButton
            x={80}
            y={85}
            label="+ Codex"
            sublabel="new session"
            plus
            onClick={onCreateCodex}
          />

          <button
            onClick={() => onSelectSession(null)}
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-28 h-28 rounded-full border-2 text-sm font-semibold shadow-xl transition-colors ${
              !activeSession
                ? 'bg-amber-600 border-amber-300 text-white'
                : 'bg-slate-900/90 border-slate-500 text-slate-100 hover:bg-slate-800'
            }`}
          >
            None
          </button>

          <button
            onClick={onClose}
            className="absolute right-0 -top-2 px-3 py-1 rounded-md bg-slate-800/90 border border-slate-600 text-slate-200 text-xs hover:bg-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
