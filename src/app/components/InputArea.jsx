import React, { useRef } from 'react';

export default function InputArea({ value, onChange, onSend, onCancel, visible }) {
  const textareaRef = useRef(null);

  if (!visible) return null;

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }

  return (
    <div className="w-full max-w-lg flex items-start gap-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Tap to edit..."
        className="flex-1 px-4 py-3 rounded-lg border border-blue-500/50 bg-slate-950 text-slate-100 text-base font-sans resize-none min-h-[60px] max-h-[150px] overflow-y-auto focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/30 placeholder:text-slate-600"
      />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        className="mt-2 w-8 h-8 flex items-center justify-center rounded-full bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white transition-colors touch-none select-none"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
