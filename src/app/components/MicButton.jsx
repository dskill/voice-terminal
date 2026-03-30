import React from 'react';

export default function MicButton({ isRecording, audioLevel = 0, isProcessing, isSendMode, disabled, onClick, onCancel, onLongPress }) {
  let bgClass = 'bg-gradient-to-br from-zinc-600 to-zinc-800 shadow-zinc-900/40 border border-zinc-500/20';
  let extraClass = '';

  if (isRecording) {
    bgClass = 'bg-gradient-to-br from-rose-500 to-red-700 shadow-red-900/50 scale-110 border border-rose-400/30';
    extraClass = 'animate-pulse-recording';
  } else if (isProcessing) {
    bgClass = 'bg-gradient-to-br from-indigo-600 to-indigo-800 shadow-indigo-900/40 border border-indigo-500/25';
    extraClass = 'animate-pulse';
  } else if (isSendMode) {
    bgClass = 'bg-gradient-to-br from-cyan-600 to-cyan-800 shadow-cyan-900/40 border border-cyan-500/25';
  }

  const micIcon = (
    <>
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
    </>
  );

  const sendIcon = (
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
  );

  const cancelIcon = (
    <>
      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </>
  );

  const handleClick = isProcessing ? onCancel : onClick;
  const isDisabled = isProcessing ? false : disabled;
  const longPressTimeoutRef = React.useRef(null);
  const longPressTriggeredRef = React.useRef(false);
  const buttonRef = React.useRef(null);

  let icon = micIcon;
  if (isProcessing) icon = cancelIcon;
  else if (isSendMode) icon = sendIcon;

  function clearLongPressTimer() {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  }

  function handlePointerDown(e) {
    e.preventDefault();
    if (isDisabled) return;

    longPressTriggeredRef.current = false;
    clearLongPressTimer();
    longPressTimeoutRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      if (onLongPress) onLongPress();
    }, 450);
  }

  function handlePointerUp(e) {
    e.preventDefault();
    if (isDisabled) return;

    clearLongPressTimer();
    if (!longPressTriggeredRef.current) {
      handleClick();
    }
    longPressTriggeredRef.current = false;
  }

  function handlePointerCancel() {
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
  }

  React.useEffect(() => {
    const buttonEl = buttonRef.current;
    if (!buttonEl) return undefined;

    const handleTouchStart = (e) => {
      e.preventDefault();
    };

    buttonEl.addEventListener('touchstart', handleTouchStart, { passive: false });

    return () => {
      buttonEl.removeEventListener('touchstart', handleTouchStart);
    };
  }, []);

  return (
    <button
      ref={buttonRef}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      disabled={isDisabled}
      style={{
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
      }}
      className={`
        relative w-20 h-20 rounded-full flex items-center justify-center
        text-white shadow-lg transition-all duration-200
        hover:brightness-110 active:scale-95
        disabled:opacity-40 disabled:cursor-not-allowed disabled:animate-none disabled:hover:brightness-100
        touch-none
        ${bgClass} ${extraClass}
      `}
    >
      {isRecording && (
        <div className="absolute -inset-8 pointer-events-none">
          {Array.from({ length: 18 }).map((_, i) => {
            const angle = (360 / 18) * i;
            const mod = 0.55 + (Math.sin(i * 1.7) ** 2) * 0.45;
            const level = Math.max(0.15, Math.min(1, audioLevel * 10 * mod + 0.12));
            const height = 8 + Math.round(level * 22);
            return (
              <div
                key={i}
                className="absolute left-1/2 top-1/2 overflow-visible pointer-events-none"
                style={{
                  transform: `rotate(${angle}deg)`,
                  width: '3px',
                  height: 0,
                  marginLeft: '-1.5px',
                }}
              >
                <span
                  className="block w-[3px] rounded-full bg-rose-300/90 shadow-[0_0_10px_rgba(251,113,133,0.8)] transition-[height] duration-75 absolute pointer-events-none"
                  style={{ height: `${height}px`, bottom: '44px' }}
                />
              </div>
            );
          })}
        </div>
      )}
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        {icon}
      </svg>
    </button>
  );
}
