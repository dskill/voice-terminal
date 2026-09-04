import React from 'react';
import MicWaveform from './MicWaveform';

export default function MicButton({ isRecording, analyserRef, isProcessing, isSendMode, disabled, onClick, onCancel, onLongPress }) {
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
      <MicWaveform analyserRef={analyserRef} active={isRecording} />
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        {icon}
      </svg>
    </button>
  );
}
