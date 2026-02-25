import React, { useEffect, useRef } from 'react';
import Message from './Message';

export default function TranscriptArea({ messages, streamingMessage }) {
  const areaRef = useRef(null);

  useEffect(() => {
    if (areaRef.current) {
      requestAnimationFrame(() => {
        areaRef.current.scrollTop = areaRef.current.scrollHeight;
      });
    }
  }, [messages, streamingMessage?.text]);

  return (
    <div
      ref={areaRef}
      className="flex-1 overflow-y-auto rounded-xl bg-slate-950/60 border border-slate-800/50 p-4 min-h-[100px]"
    >
      {messages.map((msg, i) => (
        <Message
          key={i}
          type={msg.type}
          content={msg.content}
          spokenSummary={msg.spokenSummary}
          metadata={msg.metadata}
          toolCalls={msg.toolCalls}
        />
      ))}

      {streamingMessage && (
        <Message
          type="assistant"
          content={streamingMessage.text}
          toolCalls={streamingMessage.toolCalls}
          isStreaming
        />
      )}

      {messages.length === 0 && !streamingMessage && (
        <div className="text-center text-slate-600 py-12">
          <div className="text-4xl mb-3">🎙</div>
          <div className="text-sm">Tap the mic button to start talking</div>
        </div>
      )}
    </div>
  );
}
