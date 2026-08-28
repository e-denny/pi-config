# pi-speech-to-text

Dictate into pi's input prompt with your microphone. Press **`Alt+M`** while the
prompt is focused to start listening: audio streams from your mic to **Mistral's
realtime transcription** (`voxtral-mini-transcribe-realtime-2602`) and the
transcript is written into the prompt **as you speak**. A live widget above the
editor shows the text permutating while you talk. Press `Alt+M` again to stop;
the final, authoritative transcript replaces the partial text.

## Setup

1. **Get a Mistral API token** at <https://console.mistral.ai> (API Keys →
   Create new key).
2. **Store the token** in a file — run this inside pi:

   ```
   /stt key <your-token>
   ```

   It is saved to `~/.pi/agent/pi-speech-to-text.json` with `0600` permissions.
   (Alternatively, set the `MISTRAL_API_KEY` environment variable.)

3. **Microphone capture tool** — one of these must be installed:
   - `ffmpeg` (works on Linux/macOS/Windows) — preferred
   - `arecord` (Linux, ALSA)
   - `sox`

4. Reload pi if you added the extension after starting it: `/reload`

> **Install (once the repo is up):** `pi install git:github.com/e-denny/pi-speech-to-text` — or clone and run `/reload` if you're developing locally.

## Usage

| Action | How |
|--------|-----|
| Toggle listening | `Alt+M` (or `/stt`) |
| Start / stop | `/stt on` / `/stt off` |
| Save token | `/stt key <TOKEN>` |
| Check token | `/stt key` |

While listening:

- The editor text is populated with partial transcriptions as they arrive, so
  with low Mistral latency you see the text appear while you speak; if the
  service is slow, the partials arrive later and the accurate final text lands
  when you stop.
- A widget above the editor shows `🎤 Listening…` plus the live transcript, and
  the footer status shows the same — a visual cue that speech is being
  recorded/transcribed.
- Any text already in the prompt when you start is preserved above the
  transcript.

## How it works

- A small worker process (`worker.mjs`) captures the mic (16 kHz mono s16le) and
  speaks the Mistral realtime WebSocket protocol (`/v1/audio/transcriptions/realtime`).
- Audio is streamed in small `input_audio.append` messages and committed in
  **micro-batches**: every `PI_STT_FLUSH_MS` (default **15000 ms = 15 s of
  speech**) the worker sends `input_audio.flush` so Mistral finalizes that
  window. When you fall silent for `PI_STT_SILENCE_MS` (default 1500 ms), the
  current batch is flushed early so what you just said lands promptly.
- Partial events (`transcription.text.delta`) stream live into the editor;
  finalized segments and the final `transcription.done` text replace the
  partials so the prompt ends up with accurate text.
- **Transient backend errors are retried automatically.** Mistral's realtime
  backend occasionally returns capacity errors (vLLM `TooManyRequestsError`,
  streaming timeouts, early socket closes) and sometimes its engine core
  crashes (`EngineDeadError`) — the backend restarts it and the next session
  works. The worker reconnects up to 3 times with backoff (2s/4s/8s for
  capacity errors, 5s/10s/15s for engine crashes) before giving up; the widget
  shows the retry state. Non-transient errors (e.g. bad API key) fail
  immediately.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_STT_MODEL` | `voxtral-mini-transcribe-realtime-2602` | Mistral realtime model |
| `PI_STT_DELAY_MS` | `800` | `target_streaming_delay_ms`: lower = live text as you speak, higher = more accurate but later |
| `PI_STT_FLUSH_MS` | `15000` | Micro-batch window — audio is committed to Mistral every N ms of speech |
| `PI_STT_SILENCE_MS` | `1500` | Silence before an early flush of the current batch |
| `PI_STT_DEVICE` | *(auto)* | Mic device override for ffmpeg/arecord/sox |
| `PI_STT_BASE_URL` | `wss://api.mistral.ai` | Endpoint override |
| `MISTRAL_API_KEY` | — | Token (fallback if no config file) |

## Files

- `index.ts` — the pi extension: keybinding, `/stt` command, live widget,
  editor population, worker lifecycle.
- `worker.mjs` — Node worker: mic capture + Mistral realtime WebSocket →
  JSON-lines transcript events on stdout.
- `package.json` — pi package manifest (`pi install`-able).
