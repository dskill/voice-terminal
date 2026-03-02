# Voice Terminal

> **Work in Progress** - This is an experimental voice interface for controlling VMs via Claude Code.

Speak commands, see them transcribed, edit if needed, and hear Claude's responses read back to you.

## Features

- **Tap-to-talk voice input** - Browser audio capture with server-side `faster-whisper` STT
- **Edit before send** - Review and edit transcription before sending to Claude
- **Persistent sessions** - Claude Code session survives page refreshes/reconnects
- **Text-to-speech** - Responses include a spoken summary read aloud
- **Mobile-friendly** - Fixed bottom controls, proper viewport handling

## Setup

```bash
cd /path/to/voice-terminal
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-stt.txt
tmux new-session -d -s voice-terminal -c /path/to/voice-terminal '. .venv/bin/activate && npm run dev'
```

**Note:** The server spawns a Claude Code subprocess. If you run `npm run dev` directly from within a Claude Code session, the subprocess will fail because Claude Code sets a `CLAUDECODE` environment variable to prevent nested sessions. Running in tmux gives the server a clean shell environment without that variable.

To view logs: `tmux attach -t voice-terminal`
To restart: `tmux kill-session -t voice-terminal` then re-run the command above.

Access at `https://your-vm.exe.xyz:3456/`

## Usage

1. Click "Start Voice Terminal" to initialize
2. Tap the mic button and speak (it listens until you tap again)
3. Review/edit the transcription in the text field
4. Tap "Send" or press Enter to send to Claude
5. Listen to the spoken summary

## Controls

- **Restart** - Restart Claude session and reset in-memory conversation state
- **Refresh** - Reload the page (useful for testing changes)
- **Cancel** - Discard current transcription without sending
- **Spacebar** - Toggle recording (desktop)
- **Escape** - Cancel current transcription

## Reconnect behavior

- Server keeps running if you close the web app.
- On reconnect/refresh, history is restored from server memory.
- If a response is still in progress, in-flight text/tool activity resumes in the UI.
- If spoken summary audio was missed while disconnected, it is replayed after reconnect.

## Requirements

- Node.js 18+
- Python 3.9+
- `venv` module available (`python3 -m venv`)
- Claude Code CLI installed and authenticated
- Modern browser with `MediaRecorder` support

## Server STT

- Speech-to-text now runs on the server via `faster-whisper` (CPU).
- Default model: `distil-small.en`
- Optional env vars:
  - `STT_MODEL` (example: `base.en`, `tiny.en`)
  - `STT_COMPUTE_TYPE` (default: `int8`)
  - `STT_CPU_THREADS` (default: `4`)
