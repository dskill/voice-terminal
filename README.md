# Voice Terminal

> **Work in Progress**

Voice-driven interface for controlling VMs via Claude Code. Speak commands, get responses read back to you.

## Features

- Push-to-talk voice input (browser native speech recognition)
- Persistent Claude Code session with streaming responses
- Text-to-speech responses (browser native)
- Session survives page refreshes/reconnects

## Setup

```bash
npm install
npm run dev
```

Access at `https://your-vm.exe.xyz:3456/`

## Usage

1. Click "Start Voice Terminal"
2. Hold the mic button (or spacebar) and speak
3. Release to send command to Claude
4. Listen to the spoken response

## Requirements

- Node.js 18+
- Claude Code CLI installed
- Chrome recommended (Safari has limited speech recognition support)
