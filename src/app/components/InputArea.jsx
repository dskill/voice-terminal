import React, { useRef } from 'react';

export default function InputArea({ value, onChange, onSend, onCancel, onUploadFiles = () => {}, visible }) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  if (!visible) return null;

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      onSend();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }

  function handleFileChange(e) {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onUploadFiles(files);
    }
    // Allow selecting the same file(s) again on the next pick.
    e.target.value = '';
  }

  return (
    <div className="w-full max-w-lg flex items-start gap-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Tap to edit..."
        className="flex-1 px-4 py-3 rounded-lg border border-slate-700 bg-slate-900 text-slate-100 text-base font-sans resize-none min-h-[60px] max-h-[150px] overflow-y-auto focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 placeholder:text-slate-500"
      />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          fileInputRef.current?.click();
        }}
        className="mt-2 w-9 h-9 flex items-center justify-center rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors touch-none select-none"
        title="Attach files"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 1 1 4.95 4.95l-8.5 8.49a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49" />
        </svg>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        className="hidden"
      />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          onSend();
        }}
        className="mt-2 w-9 h-9 flex items-center justify-center rounded-full bg-cyan-700 hover:bg-cyan-600 text-white transition-colors touch-none select-none"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </button>
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        className="mt-2 w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors touch-none select-none"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
