import React from 'react';

export default function MicButton({ isRecording, isProcessing, isSendMode, disabled, onClick }) {
  let bgClass = 'bg-gradient-to-br from-blue-500 to-blue-700 shadow-blue-500/30 animate-glow';
  let extraClass = '';

  if (isRecording) {
    bgClass = 'bg-gradient-to-br from-red-500 to-red-700 shadow-red-500/40 scale-110';
    extraClass = 'animate-pulse-recording';
  } else if (isProcessing) {
    bgClass = 'bg-gradient-to-br from-amber-500 to-amber-700 shadow-amber-500/30';
    extraClass = 'animate-pulse';
  } else if (isSendMode) {
    bgClass = 'bg-gradient-to-br from-green-500 to-green-700 shadow-green-500/30';
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

  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      className={`
        w-20 h-20 rounded-full flex items-center justify-center
        text-white shadow-lg transition-all duration-200
        disabled:opacity-40 disabled:cursor-not-allowed disabled:animate-none
        touch-none select-none
        ${bgClass} ${extraClass}
      `}
    >
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        {isSendMode ? sendIcon : micIcon}
      </svg>
    </button>
  );
}
