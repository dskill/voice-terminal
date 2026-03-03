import React from 'react';

export default function ToolCall({ name, input }) {
  let preview = '';
  if (input) {
    if (input.command) preview = input.command;
    else if (input.file_path) preview = input.file_path;
    else if (input.pattern) preview = input.pattern;
    else preview = JSON.stringify(input);
  }

  return (
    <span className="inline-flex items-start gap-1.5 px-2 py-0.5 mr-1.5 mb-1 rounded bg-slate-800/80 border border-slate-700/80 text-xs max-w-full">
      <span className="font-medium text-cyan-300">{name}</span>
      {preview && (
        <span className="text-slate-400 font-mono text-[0.65rem] whitespace-pre-wrap break-all">
          {preview}
        </span>
      )}
    </span>
  );
}
