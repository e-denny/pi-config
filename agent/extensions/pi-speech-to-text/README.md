# pi-speech-to-text

Dictate into pi's input prompt with your microphone — **fully local, no API
key, no cloud**. **Hold Alt+M** while the prompt is focused: the microphone
starts immediately and audio is transcribed by **faster-whisper** running a
Whisper `small` model on your own machine. Segments are written into the
prompt as they are transcribed, and a live widget above the editor shows the
accumulated text while you talk. **Release Alt+M to stop**; the final
transcript replaces the partial text. Every other key — including the Space
bar — works completely normally.

Because Alt+M is a modified key, the terminal reports its press, repeat and
release as distinct events, so hold-to-dictate needs no tap-vs-hold timing:
press starts, release stops.

Audio is cut into ~5 s windows that are dispatched to **two parallel
faster-whisper processes** (each limited to half the physical cores), so while
one window is being transcribed on one set of CPUs, the next window is already
being captured and sent to the other. During a long dictation text keeps
landing every few seconds. `/stt` remains as a manual toggle fallback, and in
terminals without Kitty keyboard protocol support Alt+M toggles instead.

## Requirements

1. **A terminal with Kitty keyboard protocol support** — kitty, ghostty,
   wezterm, foot, konsole, etc. Hold-to-dictate needs key-release events,
   which only the Kitty keyboard protocol provides. In other terminals
   Alt+M acts as a toggle instead (and the extension warns once).
2. **Python dependencies** (one-time, ~250 MB model downloaded on first use):

   ```
   cd ~/.pi/agent/extensions/pi-speech-to-text
   python3 -m venv .venv
   .venv/bin/pip install faster-whisper
   ```

3. **Microphone capture tool** — one of: `ffmpeg` (preferred), `arecord`
   (Linux, ALSA), `sox`.

4. Reload pi if you added the extension after starting it: `/reload`

No API keys, no accounts, no network required (the Whisper model is downloaded
once on first run, then cached).

## Usage

| Action | How |
|--------|-----|
| Start dictating | Hold **Alt+M** while the prompt is focused |
| Stop dictating | Release **Alt+M** |
| Manual toggle (fallback) | `/stt on` / `/stt off` |
| Toggle (non-Kitty terminals) | `Alt+M` |

While dictating:

- The mic stays on for the whole hold, including long pauses. Audio is cut
  into fixed `PI_STT_WINDOW_MS` windows (default 5 s); windows that contain no
  speech are dropped without touching the model, so pauses cost no CPU. If you
  resume talking after a pause, the next window is transcribed normally.
- Each speech window is sent to the next free faster-whisper process and
  results are re-assembled in order, so the transcript is always chronological.
  On release, the final partial window is transcribed and the authoritative
  transcript replaces the partial text.
- If no speech is detected for `PI_STT_MAX_SILENCE_MS` (default 2 min — e.g.
  the key-up event was lost by switching windows), the session stops itself.
- Any text already in the prompt when you start is preserved above the
  transcript.
- The first hold takes a few seconds: the Whisper models load into memory,
  then listening starts. Audio spoken during that load is buffered, not lost.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_STT_MODEL` | `small` | Whisper model size: `tiny`, `base`, `small`, `medium`, `large-v3` |
| `PI_STT_DEVICE` | `cpu` | `cpu` (default) or `cuda`/`auto` if you have a GPU |
| `PI_STT_COMPUTE` | `int8` | Quantization: `int8` (fast, low memory) or `float16`/`float32` |
| `PI_STT_BEAM` | `1` | Beam size (higher = more accurate, slower) |
| `PI_STT_LANGUAGE` | *(auto)* | Force a language code, e.g. `en` (auto-detect otherwise) |
| `PI_STT_VAD` | `1` | Silence/VAD filtering of non-speech audio |
| `PI_STT_WORKERS` | `2` | Parallel faster-whisper processes (1 = serial). Each loads its own model copy (~0.5–1 GB RAM each) |
| `PI_STT_CPU_THREADS` | `physical_cores / workers` | Threads per worker. Kept below the physical core count to avoid oversubscription |
| `PI_STT_WINDOW_MS` | `5000` | Audio window transcribed per job (shorter = snappier, more boundary artifacts) |
| `PI_STT_MAX_SILENCE_MS` | `120000` | Auto-stop after this much continuous silence (`0` disables) |
| `PI_STT_TEMPERATURES` | *(defaults)* | Comma-separated decode temperatures, e.g. `0.0` for minimum latency (faster-whisper retries harder windows at higher temperatures) |
| `PI_STT_DEVICE` | *(auto)* | Mic device override for ffmpeg/arecord/sox |
| `PI_STT_PYTHON` | `<ext>/.venv/bin/python` | Python binary with faster-whisper installed |

Model size vs. speed on a CPU-only machine (like a Ryzen 7 APU): `tiny`/`base`
are far faster than real-time, `small` runs ~5–8× real-time, `medium` keeps up
with real-time, `large-v3` is real-time-ish and best reserved for offline
batch transcription.

## How it works

- The pi extension (`index.ts`) installs a raw-key listener: holding **Alt+M**
  starts the microphone on the key press and stops it on the key release
  (Kitty keyboard protocol events — see Requirements). All other keys pass
  through untouched.
- A worker process (`worker.mjs`) captures the mic (16 kHz mono s16le),
  cuts the audio into fixed windows, drops pure-silence windows, and
  dispatches each speech window to the next free `stt_worker.py` process,
  tagging it with a sequence number. Results are re-ordered by sequence
  number so the transcript is always chronological.
- Each `stt_worker.py` loads faster-whisper once and keeps it warm; on
  shutdown every worker receives `end` and the final transcript is assembled
  from the ordered segments.
- There is no network dependency and nothing is uploaded — audio never leaves
  your machine.

## Files

- `index.ts` — the pi extension: hold-Alt+M key handling, `/stt` fallback,
  live widget, editor population, worker lifecycle.
- `worker.mjs` — Node worker: mic capture, window slicing, silence dropping,
  parallel dispatch + in-order reassembly, auto-stop guard.
- `stt_worker.py` — Python worker: faster-whisper model load + window
  transcription (one process per `PI_STT_WORKERS`).
- `package.json` — pi package manifest (`pi install`-able).
