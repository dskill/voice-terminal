import React from 'react';

export default function ToolCall({ name, input }) {
  let preview = '';
  if (input) {
    if (input.command) preview = input.command.slice(0, 50);
    else if (input.file_path) preview = input.file_path;
    else if (input.pattern) preview = input.pattern;
    else preview = JSON.stringify(input).slice(0, 50);
    if (preview.length >= 50) preview += '...';
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 mr-1.5 mb-1 rounded bg-blue-500/10 border border-blue-500/20 text-xs">
      <span className="font-medium text-blue-400">{name}</span>
      {preview && (
        <span className="text-slate-500 font-mono text-[0.65rem] truncate max-w-[200px]">
          {preview}
        </span>
      )}
    </span>
  );
}
