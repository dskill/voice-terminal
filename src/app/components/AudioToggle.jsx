import React from 'react';

// Mute control for the main page. This used to live in the settings panel,
// which meant silencing the app mid-response took three taps.
//
// It carries the audio-unlock state too: iOS only lets an AudioContext start
// from a user gesture, so when audio is enabled but still locked, tapping this
// is the gesture that unlocks it rather than a no-op toggle.
export default function AudioToggle({ enabled, unlocked, onToggle, onUnlock }) {
  const locked = enabled && !unlocked;

  let styleClass = 'bg-zinc-800/85 text-zinc-300 border-zinc-600/50 hover:bg-zinc-700 hover:text-white';
  let title = 'Mute audio';
  if (!enabled) {
    styleClass = 'bg-red-950/50 text-red-300 border-red-900/50 hover:bg-red-900/50 hover:text-red-100';
    title = 'Unmute audio';
  } else if (locked) {
    styleClass = 'bg-amber-900/40 text-amber-200 border-amber-600/40 hover:bg-amber-800/50';
    title = 'Audio is enabled but locked — tap to enable playback';
  }

  const speakerBody = <path d="M4 9v6h4l5 4V5L8 9H4z" />;

  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        if (locked) onUnlock();
        else onToggle(!enabled);
      }}
      className={`relative w-9 h-9 rounded-md border transition-colors flex items-center justify-center touch-none select-none ${styleClass}`}
      title={title}
      aria-label={title}
      aria-pressed={!enabled}
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        {speakerBody}
        {enabled ? (
          <>
            <path
              d="M15.5 8.5a4.5 4.5 0 0 1 0 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M18 6a8 8 0 0 1 0 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity={locked ? 0.35 : 1}
            />
          </>
        ) : (
          <path
            d="M16 9.5l5 5m0-5l-5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>
      {locked && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400" />
      )}
    </button>
  );
}
