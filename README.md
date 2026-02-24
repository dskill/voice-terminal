# Voice Terminal

> **Work in Progress** - This is an experimental voice interface for controlling VMs via Claude Code.

Speak commands, see them transcribed, edit if needed, and hear Claude's responses read back to you.

## Features

- **Tap-to-talk voice input** - Browser native speech recognition (continuous until you tap to stop)
- **Edit before send** - Review and edit transcription before sending to Claude
- **Persistent sessions** - Claude Code session survives page refreshes/reconnects
- **Text-to-speech** - Responses include a spoken summary read aloud
- **Mobile-friendly** - Fixed bottom controls, proper viewport handling

## Setup

```bash
npm install
npm run dev
```

Access at `https://your-vm.exe.xyz:3456/`

## Usage

1. Click "Start Voice Terminal" to initialize
2. Tap the mic button and speak (it listens until you tap again)
3. Review/edit the transcription in the text field
4. Tap "Send" or press Enter to send to Claude
5. Listen to the spoken summary

## Controls

- **Start/Stop** - Toggle Claude Code session
- **Clear** - Clear conversation history (client and server)
- **Refresh** - Reload the page (useful for testing changes)
- **Cancel** - Discard current transcription without sending
- **Spacebar** - Toggle recording (desktop)
- **Escape** - Cancel current transcription

## Requirements

- Node.js 18+
- Claude Code CLI installed and authenticated
- Modern browser with Speech Recognition API (Chrome recommended, Safari limited)
