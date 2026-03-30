import React from 'react';

export default function Header() {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-zinc-900/80 border-b border-zinc-800/60 backdrop-blur-sm">
      <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
        Voice Terminal
      </h1>
    </header>
  );
}
