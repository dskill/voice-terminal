# Voice Terminal

> **Work in Progress** - This is an experimental voice interface for controlling VMs via Claude Code.

Speak commands, see them transcribed, edit if needed, and hear Claude's responses read back to you.

## Features

- **Tap-to-talk voice input** - Browser audio capture with server-side `faster-whisper` STT
- **Edit before send** - Review and edit transcription before sending to Claude
- **Persistent sessions** - Claude Code session survives page refreshes/reconnects
- **Text-to-speech** - Responses include a spoken summary read aloud
- **Mobile-friendly** - Fixed bottom controls, proper viewport handling

## Built Files

The `dist/` folder is committed to the repo so instances can serve the app without a local build step. **Always run `npm run build` before committing front-end changes**, then include the updated `dist/` in your commit.

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

Access at `https://your-vm.exe.xyz:3456/`

## Restarting

- **UI "Restart" button**: restarts only the orchestrator session (Claude/Codex process) and clears in-memory conversation state. It does **not** restart `node src/server.js`.
- **Full server restart (recommended after server code/prompt-file changes)**:

```bash
tmux attach -t voice-terminal
# inside tmux pane voice-terminal:0.0
Ctrl+C
npm run dev
```

- **Hard restart from outside tmux**:

```bash
tmux kill-session -t voice-terminal
tmux new-session -d -s voice-terminal -c /path/to/voice-terminal '. .venv/bin/activate && npm run dev'
```

## Usage

1. Click "Start Voice Terminal" to initialize
2. Tap the mic button and speak (it listens until you tap again)
3. Review/edit the transcription in the text field
4. Tap "Send" or press Enter to send to Claude
5. Listen to the spoken summary

## Controls

- **Restart** - Restart orchestrator session and reset in-memory conversation state (not a Node server restart)
- **Refresh** - Reload the page (useful for testing changes)
- **Cancel / mic button while processing** - If Claude is speaking, stops TTS immediately. Otherwise cancels the current transcription or in-progress request.
- **Spacebar** - Toggle recording (desktop)
- **Escape** - Cancel current transcription

## Reconnect behavior

- Server keeps running if you close the web app.
- On reconnect/refresh, history is restored from server memory.
- If a response is still in progress, in-flight text/tool activity resumes in the UI.
- If spoken summary audio was missed while disconnected, it is replayed after reconnect.

## Production vs Development

- `npm run dev` — builds once, then watches for changes and auto-rebuilds. Use this during development.
- `npm start` — just runs the Node server, no build step. Use this on a production instance where `dist/` is already committed and up to date.

## Orchestrator System Prompt

The Claude Code subprocess is launched with `--append-system-prompt-file orchestrator-system-prompt.md`. This file defines Claude's role as a voice-driven orchestrator: it instructs Claude to be concise, end responses with a `[SPOKEN: ...]` summary for TTS, and use the `tmux-broker` CLI to manage sub-agent tmux sessions rather than raw tmux commands.

Edit `orchestrator-system-prompt.md` to change Claude's behavior or add context about your VM environment. A server restart is required for changes to take effect.

## tmux-broker

`tmux-broker` is a CLI binary included in the repo that the orchestrator uses to reliably send input to and read output from tmux sessions. It provides load-buffer/paste-buffer I/O, stream logs with cursor-based reads, and persisted session state — replacing fragile raw `tmux send-keys` usage.

The server adds `tmux-broker` to `PATH` when spawning the Claude subprocess so it's available without any additional setup.

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

## Troubleshooting

If you see:

`ModuleNotFoundError: No module named 'faster_whisper'`

the server was started without the project venv on `PATH`.

Fix:

```bash
cd /path/to/voice-terminal
python3 -m venv .venv
.venv/bin/pip install -r requirements-stt.txt
npm run build
PATH="/path/to/voice-terminal/.venv/bin:$PATH" npm run server
```

If the server is already running, restart it after installing the package and rebuilding.
