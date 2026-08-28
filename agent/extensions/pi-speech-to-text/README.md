# pi-speech-to-text

Dictate into pi's input prompt with your microphone — **fully local, no API
key, no cloud**. Press **`Alt+M`** while the prompt is focused to start
listening: audio from your mic is transcribed by **faster-whisper** running a
Whisper `small` model on your own machine, and the transcript is written into
the prompt as segments are transcribed. A live widget above the editor shows
the accumulated text while you talk. Press `Alt+M` again to stop; the final
transcript replaces the partial text.

## Setup

1. **Install the Python dependencies** (one-time, ~250 MB model downloaded on
   first use):

   ```
   cd ~/.pi/agent/extensions/pi-speech-to-text
   python3 -m venv .venv
   .venv/bin/pip install faster-whisper
   ```

2. **Microphone capture tool** — one of these must be installed:
   - `ffmpeg` (works on Linux/macOS/Windows) — preferred
   - `arecord` (Linux, ALSA)
   - `sox`

3. Reload pi if you added the extension after starting it: `/reload`

No API keys, no accounts, no network required (the Whisper model is downloaded
once on first run, then cached).

## Usage

| Action | How |
|--------|-----|
| Toggle listening | `Alt+M` (or `/stt`) |
| Start / stop | `/stt on` / `/stt off` |

While listening:

- Audio is transcribed in **windows**: every `PI_STT_FLUSH_MS` (default 15 s)
  of speech, or after `PI_STT_SILENCE_MS` (default 1.5 s) of silence, the
  buffered window is sent to faster-whisper and the text lands in the prompt.
  faster-whisper is a batch model, so text appears in segment-sized chunks
  rather than word-by-word.
- A widget above the editor shows `🎤 Listening…` plus the accumulated
  transcript, and the footer status shows the same — a visual cue that speech
  is being recorded.
- Any text already in the prompt when you start is preserved above the
  transcript.
- The first `Alt+M` takes a few seconds: the model loads into memory, then
  listening starts.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_STT_MODEL` | `small` | Whisper model size: `tiny`, `base`, `small`, `medium`, `large-v3` |
| `PI_STT_DEVICE` | `cpu` | `cpu` (default) or `cuda`/`auto` if you have a GPU |
| `PI_STT_COMPUTE` | `int8` | Quantization: `int8` (fast, low memory) or `float16`/`float32` |
| `PI_STT_BEAM` | `1` | Beam size (higher = more accurate, slower) |
| `PI_STT_LANGUAGE` | *(auto)* | Force a language code, e.g. `en` (auto-detect otherwise) |
| `PI_STT_VAD` | `1` | Silence/VAD filtering of non-speech audio |
| `PI_STT_FLUSH_MS` | `15000` | Micro-batch window — audio is transcribed every N ms of speech |
| `PI_STT_SILENCE_MS` | `1500` | Silence before an early flush of the current window |
| `PI_STT_DEVICE` | *(auto)* | Mic device override for ffmpeg/arecord/sox |
| `PI_STT_PYTHON` | `<ext>/.venv/bin/python` | Python binary with faster-whisper installed |

Model size vs. speed on a CPU-only machine (like a Ryzen 7 APU): `tiny`/`base`
are far faster than real-time, `small` runs ~5–8× real-time, `medium` keeps up
with real-time, `large-v3` is real-time-ish and best reserved for offline
batch transcription.

## How it works

- A small worker process (`worker.mjs`) captures the mic (16 kHz mono s16le)
  and spawns `stt_worker.py` in the extension's `.venv`.
- `stt_worker.py` loads faster-whisper once and keeps it warm; audio windows
  are streamed to it over stdin (base64 s16le) and it returns
  `{"type":"segment"}` events with the transcribed text, plus a final
  `{"type":"done"}` transcript on end.
- Segment events stream into the prompt as they are transcribed; when you
  stop, the final authoritative transcript replaces the partial text.
- There is no network dependency and nothing is uploaded — audio never leaves
  your machine.

## Files

- `index.ts` — the pi extension: keybinding, `/stt` command, live widget,
  editor population, worker lifecycle.
- `worker.mjs` — Node worker: mic capture, VAD/micro-batch flushing, local
  faster-whisper subprocess management → JSON-lines transcript events.
- `stt_worker.py` — Python worker: faster-whisper model load + transcription.
- `package.json` — pi package manifest (`pi install`-able).
