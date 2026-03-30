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
    <span className="inline-flex items-start gap-1.5 px-2 py-0.5 mr-1.5 mb-1 rounded bg-sky-950/40 border border-sky-800/30 text-xs max-w-full">
      <span className="font-medium font-mono text-sky-300">{name}</span>
      {preview && (
        <span className="text-sky-200/50 font-mono text-[0.6rem] whitespace-pre-wrap break-all">
          {preview}
        </span>
      )}
    </span>
  );
}
