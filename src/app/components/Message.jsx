import React from 'react';
import ToolCall from './ToolCall';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost) {
  if (!cost) return '';
  if (cost < 0.01) return `${(cost * 100).toFixed(2)}¢`;
  return `$${cost.toFixed(4)}`;
}

const typeStyles = {
  user: 'bg-blue-950/40 border-l-blue-500',
  assistant: 'bg-emerald-950/30 border-l-emerald-500',
  error: 'bg-red-950/30 border-l-red-500',
  status: 'bg-slate-800/50 border-l-violet-500 italic',
};

const typeLabels = {
  user: 'You',
  assistant: 'Claude',
  error: 'Error',
  status: 'Status',
};

export default function Message({ type, content, spokenSummary, metadata, toolCalls, isStreaming }) {
  const style = typeStyles[type] || typeStyles.status;
  const label = typeLabels[type] || type;

  const metaParts = [];
  if (metadata) {
    if (metadata.durationMs) metaParts.push(formatDuration(metadata.durationMs));
    if (metadata.totalCostUsd) metaParts.push(formatCost(metadata.totalCostUsd));
    if (metadata.numTurns) metaParts.push(`${metadata.numTurns} turn${metadata.numTurns > 1 ? 's' : ''}`);
  }

  return (
    <div className={`rounded-lg border-l-[3px] p-3 mb-3 ${style} ${isStreaming ? 'border-l-amber-500' : ''}`}>
      <div className="text-[0.65rem] uppercase tracking-wider text-slate-500 mb-1">{label}</div>

      {toolCalls && toolCalls.length > 0 && (
        <div className="mb-2 flex flex-wrap">
          {toolCalls.map((tc, i) => (
            <ToolCall key={i} name={tc.toolName} input={tc.input} />
          ))}
        </div>
      )}

      <div className={`whitespace-pre-wrap break-words font-mono text-sm leading-relaxed ${isStreaming ? 'opacity-80' : ''}`}>
        {content}
      </div>

      {spokenSummary && (
        <div className="mt-2 pt-2 border-t border-white/5 text-amber-400 text-sm">
          <span className="font-semibold">Spoken:</span> {spokenSummary}
        </div>
      )}

      {metaParts.length > 0 && (
        <div className="mt-2 text-[0.65rem] text-slate-600">
          {metaParts.join(' · ')}
        </div>
      )}
    </div>
  );
}
