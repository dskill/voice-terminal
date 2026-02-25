# Voice Terminal — React + Tailwind UI Rewrite Plan

## Goal
Rewrite the vanilla HTML/JS frontend as a React app with Tailwind CSS, keeping the Express/WebSocket backend unchanged. The new UI should be modular, visually polished, and easy to iterate on.

## Current Architecture
- **Backend** (`src/server.js`): Express + WebSocket server that spawns a persistent Claude CLI process. Stays **untouched**.
- **Frontend** (`public/index.html` + `public/main.js`): ~1200 lines of vanilla JS/HTML/CSS. All UI state managed through direct DOM manipulation.
- **Workers** (`public/tts-worker.js`, `public/whisper-worker.js`): Web workers for Hugging Face TTS/Whisper. Currently unused in the active flow (browser-native Speech Recognition + SpeechSynthesis are used instead). Will keep these files as-is for future use.
- **Build**: Vite, currently just bundling static files from `public/`.

## New Architecture

### Tech Stack
- **React 18** (JSX, functional components, hooks)
- **Tailwind CSS v3** (utility-first styling, easy to tweak visuals)
- **Vite** (already in use — just add React plugin)
- No state management library — `useState` + `useContext` is sufficient

### Project Structure
```
voice-terminal/
├── src/
│   ├── server.js              # UNCHANGED - Express/WS backend
│   ├── app/                   # NEW - React frontend
│   │   ├── main.jsx           # Entry point, renders <App />
│   │   ├── index.html         # HTML shell (moves from public/)
│   │   ├── App.jsx            # Root component, WebSocket provider
│   │   ├── index.css          # Tailwind directives + custom styles
│   │   ├── hooks/
│   │   │   ├── useWebSocket.js    # WebSocket connection + reconnect logic
│   │   │   ├── useSpeechRecognition.js  # Browser speech recognition
│   │   │   └── useTTS.js         # Text-to-speech (browser native)
│   │   └── components/
│   │       ├── LoadingOverlay.jsx  # Start button + init log
│   │       ├── Header.jsx         # Title bar
│   │       ├── TranscriptArea.jsx # Scrollable message history
│   │       ├── Message.jsx        # Single message (user/assistant/status/error)
│   │       ├── StreamingMessage.jsx # In-progress assistant message with tool calls
│   │       ├── ToolCall.jsx       # Individual tool call badge
│   │       ├── Controls.jsx       # Bottom control bar (status, buttons, context bar)
│   │       ├── MicButton.jsx      # Mic record button with states
│   │       └── InputArea.jsx      # Edit-before-send textarea + buttons
├── public/
│   ├── tts-worker.js          # KEPT - for future use
│   └── whisper-worker.js      # KEPT - for future use
├── tailwind.config.js         # NEW
├── postcss.config.js          # NEW
└── vite.config.js             # UPDATED - add React plugin, change root
```

### Component Breakdown

#### `App.jsx` — Root Component
- Provides WebSocket context to all children
- Manages top-level state: `messages[]`, `sessionStatus`, `isRecording`, `isProcessing`
- Renders: `LoadingOverlay` → `Header` + `TranscriptArea` + `Controls`

#### `useWebSocket` Hook
- Connects to `wss://${location.host}`
- Auto-reconnect on disconnect (3s delay)
- Exposes: `send()`, `isConnected`, `claudeStatus`
- Dispatches incoming messages to state updates

#### `TranscriptArea` + `Message`
- Auto-scrolling message list
- Message types: user (blue), assistant (green), status (purple), error (red)
- Assistant messages show: tool call badges, streaming text, spoken summary, metadata (cost/duration/turns)

#### `StreamingMessage`
- Renders in-progress assistant responses
- Shows tool call badges as they arrive
- Shows partial text with streaming indicator
- Finalizes into a normal `Message` when complete

#### `Controls` + `MicButton` + `InputArea`
- Status badges (WS, Claude, context bar)
- Session start/stop button
- Large circular mic button with recording/processing animations
- Edit-before-send textarea that appears after recording stops
- Clear history + refresh buttons

#### `useSpeechRecognition` Hook
- Wraps browser `SpeechRecognition` API
- Exposes: `startListening()`, `stopListening()`, `transcript`, `isListening`

#### `useTTS` Hook
- Wraps browser `SpeechSynthesis` API
- iOS unlock on first user gesture
- Exposes: `speak(text)`, `isSpeaking`

### Styling Approach
- **Dark theme** using Tailwind's dark palette (`slate-900`, `slate-800`, etc.)
- **Accent colors**: Blue for user/primary actions, green for Claude/success, amber for warnings, red for errors
- **Animations**: Tailwind `animate-pulse` for recording, custom glow effects for the mic button
- **Responsive**: Mobile-first, works on phone + desktop
- **Typography**: `font-mono` for code/transcript, `font-sans` for UI elements

### Migration Steps

1. **Install dependencies**
   ```
   npm install react react-dom @vitejs/plugin-react
   npm install -D tailwindcss postcss autoprefixer
   npx tailwindcss init -p
   ```

2. **Update Vite config** — Add React plugin, point root to `src/app/`

3. **Set up Tailwind** — Configure content paths, add base/components/utilities to CSS

4. **Build components** — Port each UI section from vanilla JS to React components, replacing DOM manipulation with state + JSX

5. **Port WebSocket logic** — Move into `useWebSocket` hook with React state management

6. **Port speech recognition** — Move into `useSpeechRecognition` hook

7. **Port TTS** — Move into `useTTS` hook

8. **Wire up App.jsx** — Compose all components, connect hooks

9. **Update build scripts** — Ensure `vite build` outputs to `dist/` for the Express server to serve

10. **Test** — Verify WebSocket connection, recording, streaming, TTS, and edit-before-send all work

### What Changes for the Backend
**Nothing.** The backend serves static files from `dist/` (or `public/` as fallback). After the React build, `dist/` will contain the bundled app. The WebSocket protocol stays identical.

### Visual Improvements Enabled by This Rewrite
- Smooth transitions between states (recording → processing → response)
- Better message formatting with markdown rendering (future)
- Animated mic button with audio level visualization (future)
- Theme customization (future)
- Component-level styling iteration without breaking other parts
