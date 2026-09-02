# pi-speech-to-text-whispercpp

Dictate into pi's input prompt with your microphone — **fully local, no API
key, no cloud, no Python**. **Hold Alt+M** while the prompt is focused: the
microphone starts immediately and audio is transcribed by **whisper.cpp**
running as a persistent local server on your own machine. Segments are
written into the prompt as they are transcribed, and a live widget above the
editor shows the accumulated text while you talk. **Release Alt+M to stop**;
the final transcript replaces the partial text. Every other key — including
the Space bar — works completely normally.

This is a redesign of `pi-speech-to-text` that swaps the faster-whisper
backend for **whisper.cpp**, following the architecture of Allen Kuo's
[*Choosing a Real-Time Whisper Engine*](https://allenkuo.medium.com/choosing-a-real-time-whisper-engine-c4eeb5885e22):

> *Do not integrate whisper.cpp as a CLI command. Keep it alive as a
> persistent backend.*

The old extension spawned a fresh faster-whisper Python process per window.
This one starts `whisper-server` (whisper.cpp's HTTP server) **once**, the
model loads **once**, and every 5 s audio window is POSTed to it as a WAV.
On the article's benchmark that turned whisper.cpp from the slowest-looking
candidate (CLI, dominated by per-invocation model load) into the fastest
(server mode: ~30 % lower mean latency than faster-whisper and roughly half
the P95 tail). Serialized, in-order requests beat parallel workers here:
with a single backend, determinism beats optimistic concurrency.

## Requirements

1. **whisper.cpp** with the `whisper-server` binary on PATH:

   ```bash
   # Arch
   sudo pacman -S whisper-cpp
   # macOS
   brew install whisper-cpp
   # or build from https://github.com/ggml-org/whisper.cpp and point
   # PI_STT_WHISPER_SERVER at your binary
   ```

2. **A terminal with Kitty keyboard protocol support** — kitty, ghostty,
   wezterm, foot, konsole, etc. Hold-to-dictate needs key-release events,
   which only the Kitty keyboard protocol provides. In other terminals
   Alt+M acts as a toggle instead (and the extension warns once).

3. **Microphone capture tool** — one of: `ffmpeg` (preferred), `arecord`
   (Linux, ALSA), `sox`.

4. **The model** is downloaded automatically on first use
   (`ggml-small.en.bin`, ~0.5 GB, cached in `<extension>/models/`). No
   accounts, no network after that.

5. Reload pi if you added the extension after starting it: `/reload`

No `npm install`, no venv, no Python dependencies — the extension is pure
Node.js plus the system whisper.cpp binaries.

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
  speech are dropped before they reach the model, so pauses cost no CPU.
- Windows are transcribed **strictly in order** by the single persistent
  backend, so the transcript is always chronological. On release, the final
  partial window is transcribed and the authoritative transcript replaces the
  partial text.
- If the model falls behind, the audio queue is bounded (`PI_STT_MAX_QUEUE`)
  and drops its oldest windows to stay real-time, rather than piling up stale
  audio.
- If no speech is detected for `PI_STT_MAX_SILENCE_MS` (default 2 min — e.g.
  the key-up event was lost by switching windows), the session stops itself.
- Any text already in the prompt when you start is preserved above the
  transcript.
- The **first** hold takes a few seconds: the model downloads (first run) and
  whisper-server loads it. The worker then keeps the server warm, so every
  later hold of Alt+M starts transcribing almost instantly.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_STT_MODEL` | `small.en` | GGML model: `tiny.en`, `base.en`, `small.en`, `small`, `medium`, `large-v3`, … (bare names resolve to `<extension>/models/ggml-<name>.bin`; a path ending in `.bin` is used as-is) |
| `PI_STT_LANGUAGE` | *(auto)* | Force a language code, e.g. `en`. Empty: `.en` models use `en`, multilingual models auto-detect per window |
| `PI_STT_THREADS` | `cores (max 8)` | whisper.cpp compute threads |
| `PI_STT_BEAM` | `1` | Beam size (higher = more accurate, slower) |
| `PI_STT_BEST_OF` | `1` | Best-of candidates (higher = more accurate, slower) |
| `PI_STT_TEMPERATURE` | `0.0` | Sampling temperature for decoding |
| `PI_STT_WINDOW_MS` | `5000` | Audio window transcribed per job (shorter = snappier, more boundary artifacts) |
| `PI_STT_MAX_QUEUE` | `8` | Bounded window queue; oldest windows are dropped beyond this |
| `PI_STT_MAX_SILENCE_MS` | `120000` | Auto-stop after this much continuous silence (`0` disables) |
| `PI_STT_WHISPER_SERVER` | `whisper-server` | whisper-server binary (PATH lookup by default) |
| `PI_STT_PORT` | `0` | whisper-server port (`0` = pick a free port) |
| `PI_STT_DEVICE` | *(auto)* | Mic device override for ffmpeg/arecord/sox |
| `PI_STT_SERVER_VAD` | `0` | `1` to enable whisper.cpp's neural VAD (silero v6.2.0, ~1 MB, auto-downloaded to `models/`). Rejects non-speech *within* a window and splits windows at silences |
| `PI_STT_VAD_MODEL` | *(auto)* | Path to a custom ggml VAD model (default: auto-downloaded silero v6.2.0) |

Model size vs. speed on a CPU-only machine (like a Ryzen 7 APU): `tiny.en`/
`base.en` are far faster than real-time, `small.en` transcribes a 5 s window
in ~100–250 ms and is the accuracy/latency sweet spot the article settled on,
`medium` keeps up with real-time, `large-v3` is best reserved for offline
batch transcription.

## How it works

- The pi extension (`index.ts`) installs a raw-key listener: holding **Alt+M**
  starts the microphone on the key press and stops it on the key release
  (Kitty keyboard protocol events — see Requirements). All other keys pass
  through untouched.
- A long-lived worker process (`worker.mjs`) is spawned once per pi session.
  On boot it downloads the model if needed, starts `whisper-server` on a free
  localhost port, and waits. The model loads **once**; every dictation
  session reuses the warm server.
- During a session the worker captures the mic (16 kHz mono s16le), cuts the
  audio into fixed windows, drops pure-silence windows, and POSTs each speech
  window to `whisper-server /inference` as a WAV (multipart form, one request
  in flight at a time — a single ASR scheduler). Results come back in order
  and are streamed to the editor as they land.
- On release, the final partial window is transcribed and the worker emits
  the authoritative transcript. The server stays up for the next dictation.
- There is no network dependency and nothing is uploaded — audio never leaves
  your machine (except the one-time model download).

## Files

- `index.ts` — the pi extension: hold-Alt+M key handling, `/stt` fallback,
  live widget, editor population, worker lifecycle.
- `worker.mjs` — Node worker: model download, whisper-server lifecycle, mic
  capture, window slicing, silence dropping, bounded queue + serialized
  dispatch, auto-stop guard.
- `package.json` — pi package manifest (`pi install`-able).
