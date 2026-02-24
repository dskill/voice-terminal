# Voice Terminal

Voice-driven interface for controlling VMs via Claude Code.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (iPhone/Desktop)                                    │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Whisper Worker  │  │  TTS Worker     │                   │
│  │ (WebGPU STT)    │  │  (WebGPU TTS)   │                   │
│  └────────┬────────┘  └────────▲────────┘                   │
│           │                    │                             │
│  ┌────────▼────────────────────┴────────┐                   │
│  │            main.js                    │                   │
│  │  - Audio recording (MediaRecorder)   │                   │
│  │  - WebSocket client                  │                   │
│  │  - UI controls                       │                   │
│  └────────────────┬─────────────────────┘                   │
└───────────────────┼─────────────────────────────────────────┘
                    │ WSS
┌───────────────────▼─────────────────────────────────────────┐
│  Server (Node.js)                                            │
│  ┌──────────────────────────────────────┐                   │
│  │           server.js                   │                   │
│  │  - WebSocket server                  │                   │
│  │  - Spawns `claude --print`           │                   │
│  │  - Extracts <spoken-summary>         │                   │
│  └────────────────┬─────────────────────┘                   │
└───────────────────┼─────────────────────────────────────────┘
                    │ CLI
┌───────────────────▼─────────────────────────────────────────┐
│  Claude Code CLI                                             │
│  - Executes user requests                                   │
│  - Returns response with <spoken-summary> tag               │
└─────────────────────────────────────────────────────────────┘
```

## Models (Client-Side, WebGPU)

- **STT**: `onnx-community/whisper-tiny.en` (~40MB)
- **TTS**: `onnx-community/Supertonic-TTS-ONNX` (~60MB)

Both run via HuggingFace Transformers.js with WebGPU acceleration (WASM fallback).

## Development

```bash
npm install
npm run build   # Build frontend with Vite
npm run server  # Start server only
npm run dev     # Build + server with watch mode
```

## Production

```bash
npm run build
npm start       # Start server (serves from dist/)
```

Access at: `https://bice-box.exe.xyz:3456/`

## How It Works

1. User clicks "Start" to load Whisper & TTS models (~100MB download, cached in IndexedDB)
2. User holds mic button → MediaRecorder captures audio
3. Audio sent to Whisper worker → transcript text
4. Transcript sent via WebSocket to server
5. Server invokes `claude --print` with the transcript
6. Claude executes request and includes `<spoken-summary>` tag
7. Server extracts summary, sends back to client
8. Client's TTS worker speaks the summary

## Files

```
voice-terminal/
├── package.json
├── vite.config.js
├── CLAUDE.md
├── src/
│   └── server.js         # WebSocket server + Claude CLI
├── public/               # Source files
│   ├── index.html
│   ├── main.js           # App logic
│   ├── whisper-worker.js # STT worker
│   └── tts-worker.js     # TTS worker
└── dist/                 # Built files (served in production)
```

## Spoken Summary Format

The server prepends instructions to every voice command asking Claude to end responses with:

```
<spoken-summary>Brief 1-3 sentence summary</spoken-summary>
```

If no tag found, the server falls back to using the last paragraph.
