# Voice Terminal - Claude Context

Voice-driven interface for controlling exe.dev VMs via Claude Code. User speaks commands from their phone/browser, Claude executes them on the VM.

## Current State (WIP)

The app is functional but actively being refined. Recent focus has been on UI/UX for mobile.

## Architecture

```
Browser (iPhone/Desktop)
├── index.html          - UI layout, CSS
├── main.js             - App logic, WebSocket client
│   ├── MediaRecorder audio capture
│   ├── Web Audio queued PCM playback for streamed TTS
│   └── WebSocket connection to server
│
Server (Node.js on exe.dev VM)
├── server.js           - WebSocket server
│   ├── Spawns `claude --print --output-format stream-json`
│   ├── Spawns Python `faster-whisper` STT worker
│   ├── Streams Piper TTS PCM over WebSocket
│   ├── Maintains persistent Claude Code session
│   ├── Stores conversation history for reconnects
│   └── Extracts [SPOKEN: ...] summary from responses
```

## Key Files

- `src/app/App.jsx` - Main client app flow
- `src/app/components/Controls.jsx` - Session/restart controls
- `src/app/hooks/useSpeechRecognition.js` - MediaRecorder audio capture
- `src/server.js` - WebSocket server, Claude Code process management

## How It Works

1. User taps "Start Voice Terminal" - requests mic permission, connects WebSocket
2. Server auto-starts Claude Code session with `--dangerously-skip-permissions`
3. User taps mic button - starts browser audio capture (MediaRecorder)
4. User taps again to stop - audio sent to server STT, transcription appears in editable text field
5. User can edit, then tap Send (or Enter) or Cancel (or Escape)
6. Server receives transcript, sends to Claude via stream-json input
7. Claude responds with `[SPOKEN: summary]` at the end
8. Server extracts summary, streams Piper audio chunks over WebSocket
9. Client shows response in history and starts playback before synthesis is complete

## UI Structure

- **Header** - Just the title "Voice Terminal"
- **Transcript Area** - Scrollable conversation history
- **Controls** (fixed at bottom):
  - Status indicators (WS, Claude)
  - Restart session button
  - Refresh button
  - Live transcript display
  - Editable input area (hidden until recording stops)
  - Mic button

## Voice Prompt

Every message to Claude is prefixed with:
```
You are being controlled via a voice interface. Be concise. After completing requests, end your response with a spoken summary in this format: [SPOKEN: your 1-2 sentence summary]. Keep it conversational - it will be read aloud.
```

## Recent Changes

- Switched STT from browser-native recognition to server-side `faster-whisper`
- Single session model (no session picker)
- Edit-before-send UI (fix garbled transcriptions, or type instead)
- Controls moved to fixed bottom panel
- Proper flexbox layout for mobile (100dvh, controls don't overlap history)
- Restart and refresh buttons for testing

## Launching Codex Sessions

Always start Codex with `--model gpt-5.4` to ensure the latest model is used:

```bash
tmux new-session -d -s <session-name> -c /home/exedev/voice-terminal 'codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.4'
```

## Known Issues / TODOs

- History can still get covered by input area when typing long messages
- Need more long-session testing for reconnect/audio replay edge cases
- No way to interrupt Claude while it's responding

## Running

```bash
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-stt.txt
tmux new-session -d -s voice-terminal -c /path/to/voice-terminal '. .venv/bin/activate && npm run dev'
```

**Important:** The server spawns Claude Code and a Python STT worker subprocess. If you run `npm run dev` directly from within a Claude Code session, the Claude subprocess will fail because Claude Code sets a `CLAUDECODE` environment variable to prevent nested sessions. Running in tmux gives the server a clean shell environment without that variable.

To view logs: `tmux attach -t voice-terminal`
To restart: `tmux kill-session -t voice-terminal` then re-run the command above.

Access at `https://your-vm.exe.xyz:3456/`

## Development Tips

- Use Refresh button in the app to test changes without restarting server
- Restart button resets Claude session and in-memory conversation history
- Server auto-starts Claude session on startup
- Check browser console for capture/WS audio errors
