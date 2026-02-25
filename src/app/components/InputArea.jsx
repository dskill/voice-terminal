import React, { useRef, useEffect } from 'react';

export default function InputArea({ value, onChange, onSend, onCancel, visible }) {
  const textareaRef = useRef(null);

  useEffect(() => {
    if (visible && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [visible]);

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
    <div className="w-full max-w-lg flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Edit or type your message..."
        className="w-full px-4 py-3 rounded-lg border border-blue-500/50 bg-slate-950 text-slate-100 text-base font-sans resize-none min-h-[60px] max-h-[150px] overflow-y-auto focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/30 placeholder:text-slate-600"
      />
      <div className="flex gap-2 justify-center">
        <button
          onClick={onCancel}
          className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onSend}
          className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
