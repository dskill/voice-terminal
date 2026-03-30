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
  }, [messages, streamingMessage?.text, streamingMessage?.toolCalls?.length, streamingMessage?.timeline?.length]);

  return (
    <div
      ref={areaRef}
      className="flex-1 overflow-y-auto rounded-lg bg-zinc-950/60 border border-zinc-800/50 p-4 min-h-[100px]"
    >
      {messages.map((msg, i) => (
        <Message
          key={i}
          type={msg.type}
          content={msg.content}
          spokenSummary={msg.spokenSummary}
          metadata={msg.metadata}
          toolCalls={msg.toolCalls}
          timeline={msg.timeline}
        />
      ))}

      {streamingMessage && (
        <Message
          type="assistant"
          content={streamingMessage.text}
          toolCalls={streamingMessage.toolCalls}
          timeline={streamingMessage.timeline}
          isStreaming
        />
      )}

      {messages.length === 0 && !streamingMessage && (
        <div className="text-center text-zinc-500 py-12">
          <div className="text-4xl mb-3">🎙</div>
          <div className="text-sm">Tap the mic button to start talking</div>
        </div>
      )}
    </div>
  );
}
