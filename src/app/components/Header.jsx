import React from 'react';

export default function Header() {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-slate-800/80 border-b border-slate-700/50 backdrop-blur-sm">
      <h1 className="text-lg font-semibold tracking-tight text-slate-100">
        Voice Terminal
      </h1>
    </header>
  );
}
