# Voice Terminal - Claude Context

Voice-driven interface for controlling exe.dev VMs via Claude Code. User speaks commands from their phone/browser, Claude executes them on the VM.

## Current State (WIP)

The app is functional but actively being refined. Recent focus has been on UI/UX for mobile.

## Architecture

```
Browser (iPhone/Desktop)
├── index.html          - UI layout, CSS
├── main.js             - App logic, WebSocket client
│   ├── Browser Speech Recognition API (continuous mode)
│   ├── Browser SpeechSynthesis API (TTS)
│   └── WebSocket connection to server
│
Server (Node.js on exe.dev VM)
├── server.js           - WebSocket server
│   ├── Spawns `claude --print --output-format stream-json`
│   ├── Maintains persistent Claude Code session
│   ├── Stores conversation history for reconnects
│   └── Extracts [SPOKEN: ...] summary from responses
```

## Key Files

- `public/index.html` - All CSS inline in `<style>`, HTML structure
- `public/main.js` - Single file with all client logic
- `src/server.js` - WebSocket server, Claude Code process management

## How It Works

1. User taps "Start Voice Terminal" - requests mic permission, connects WebSocket
2. Server auto-starts Claude Code session with `--dangerously-skip-permissions`
3. User taps mic button - starts browser speech recognition (continuous mode)
4. User taps again to stop - transcription appears in editable text field
5. User can edit, then tap Send (or Enter) or Cancel (or Escape)
6. Server receives transcript, sends to Claude via stream-json input
7. Claude responds with `[SPOKEN: summary]` at the end
8. Server extracts summary, sends full response + spoken summary to client
9. Client shows response in history, speaks summary via TTS

## UI Structure

- **Header** - Just the title "Voice Terminal"
- **Transcript Area** - Scrollable conversation history
- **Controls** (fixed at bottom):
  - Status indicators (WS, Claude)
  - Start/Stop session button
  - Clear history button
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

- Switched from WebGPU Whisper/TTS to browser-native APIs (simpler, faster)
- Single session model (no session picker)
- Edit-before-send UI (fix garbled transcriptions, or type instead)
- Controls moved to fixed bottom panel
- Proper flexbox layout for mobile (100dvh, controls don't overlap history)
- Clear history and refresh buttons for testing

## Known Issues / TODOs

- History can still get covered by input area when typing long messages
- Speech recognition quality varies by browser/device
- No way to interrupt Claude while it's responding

## Running

```bash
npm install
tmux new-session -d -s voice-terminal -c /path/to/voice-terminal 'npm run dev'
```

**Important:** The server spawns a Claude Code subprocess. If you run `npm run dev` directly from within a Claude Code session, the subprocess will fail because Claude Code sets a `CLAUDECODE` environment variable to prevent nested sessions. Running in tmux gives the server a clean shell environment without that variable.

To view logs: `tmux attach -t voice-terminal`
To restart: `tmux kill-session -t voice-terminal` then re-run the command above.

Access at `https://your-vm.exe.xyz:3456/`

## Development Tips

- Use Refresh button in the app to test changes without restarting server
- Clear button resets both client UI and server conversation history
- Server auto-starts Claude session on startup
- Check browser console for speech recognition errors
