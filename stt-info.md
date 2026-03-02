# STT Approach

## Current approach

- STT runs on the server, not on the mobile device.
- The browser records audio with `MediaRecorder` and sends it over WebSocket.
- Node forwards the audio to a persistent Python worker (`src/stt_worker.py`).
- The worker uses `faster-whisper` on CPU and returns plain text.
- The client shows that text in the editable input field before sending to Claude.

## Why this approach

- Better transcription quality than iOS/browser-native speech recognition in our tests.
- Keeps the existing UX: record, review/edit transcript, then submit.
- `faster-whisper` is practical on CPU with `int8` compute, which fits VM constraints.
- Persistent worker avoids cold-start overhead on each recording.

## Current defaults

- Model: `distil-small.en`
- Device: CPU
- Compute type: `int8`
- Language: English (`en`)

Configured via env vars:

- `STT_MODEL` (default: `distil-small.en`)
- `STT_COMPUTE_TYPE` (default: `int8`)
- `STT_CPU_THREADS` (default: `4`)

## Model options to consider later

- `tiny.en`
  - Fastest, lowest CPU usage.
  - Lower accuracy, especially with noisy or fast speech.
- `base.en`
  - Faster/lighter than `distil-small.en`.
  - Usually a small quality drop vs `distil-small.en`.
- `small.en`
  - Better accuracy than `base.en` in many cases.
  - Higher latency and CPU load.
- `medium.en`
  - Higher quality but likely too heavy for a constrained CPU VM in real-time UX.

## Non-Whisper alternatives to revisit

- `whisper.cpp` with quantized GGML/GGUF models
  - Very CPU-friendly and mature.
  - Would require a different integration path and model/runtime management.
- `Moonshine`
  - Designed for low-latency edge STT.
  - Smaller ecosystem and less battle-tested in this stack.
- `Vosk`
  - Lightweight and simple streaming.
  - Typically lower accuracy than modern Whisper-family models.
