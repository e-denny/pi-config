#!/usr/bin/env python3
"""
pi-speech-to-text local worker (faster-whisper backend)

Reads framed 16 kHz mono s16le audio from stdin and emits JSON lines on
stdout — a local faster-whisper backend for the pi extension.

stdin protocol (one JSON object per line):
  {"type":"window","seq":<int>,"data":"<base64 s16le>"}   transcribe one window of audio
  {"type":"end"}                                          stop after the current window, then exit
  EOF                                                     same as {"type":"end"}

stdout protocol (one JSON object per line):
  {"type":"ready","model":...,"sampleRate":16000}   model loaded, accepting windows
  {"type":"segment","text":"...","seq":<int>}       transcription of window <seq>
  {"type":"error","message":"..."}                  fatal error

Each worker process loads its own copy of the model once and then loops over
windows. The Node side runs several of these in PARALLEL (PI_STT_WORKERS),
dispatches 5-second audio windows round-robin, and re-assembles the segments
in sequence order, so text keeps landing every few seconds during long
dictations. PI_STT_CPU_THREADS limits the threads each process uses so the
workers don't oversubscribe the machine's cores.
"""
import base64
import json
import os
import sys

import numpy as np


def log(msg: str) -> None:
    sys.stderr.write(f"[stt_worker:{os.getpid()}] {msg}\n")
    sys.stderr.flush()


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def transcribe(model, audio: bytes, beam: int, language, vad: bool, temperatures=None) -> str:
    # Raw s16le has no container header, so hand faster-whisper a float32
    # array directly (16 kHz is Whisper's native rate).
    audio_array = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
    kwargs = {
        "beam_size": beam,
        "language": language,
        "vad_filter": vad,
    }
    if temperatures is not None:
        # faster-whisper retries hard windows at higher temperatures; the
        # caller can cap this for lower worst-case latency.
        kwargs["temperature"] = temperatures
    segments, _info = model.transcribe(audio_array, **kwargs)
    return "".join(seg.text for seg in segments).strip()


def main() -> None:
    model_size = os.environ.get("PI_STT_MODEL", "small")
    device = os.environ.get("PI_STT_DEVICE", "cpu")
    compute = os.environ.get("PI_STT_COMPUTE", "int8")
    beam = int(os.environ.get("PI_STT_BEAM", "1"))
    language = os.environ.get("PI_STT_LANGUAGE") or None
    vad = os.environ.get("PI_STT_VAD", "1") != "0"
    cpu_threads = int(os.environ.get("PI_STT_CPU_THREADS", "0") or 0)
    temperatures_raw = os.environ.get("PI_STT_TEMPERATURES") or None
    temperatures = (
        [float(t) for t in temperatures_raw.split(",") if t.strip()]
        if temperatures_raw
        else None
    )

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        send({
            "type": "error",
            "message": (
                f"faster-whisper not installed in this venv ({sys.executable}): {e}. "
                "Run: .venv/bin/pip install faster-whisper"
            ),
        })
        return

    # Warmup load happens once; subsequent windows reuse the loaded model.
    try:
        log(f"loading WhisperModel({model_size!r}, device={device!r}, compute_type={compute!r}, cpu_threads={cpu_threads})…")
        model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute,
            cpu_threads=cpu_threads,
        )
    except Exception as e:
        send({"type": "error", "message": f"Failed to load Whisper model '{model_size}': {e}"})
        return

    log(f"ready: model={model_size} device={device} compute={compute} threads={cpu_threads}")
    send({"type": "ready", "model": model_size, "sampleRate": 16000})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mtype = msg.get("type")
        if mtype == "window":
            seq = msg.get("seq")
            audio = base64.b64decode(msg.get("data", ""))
            if not audio:
                send({"type": "segment", "text": "", "seq": seq})
                continue
            try:
                text = transcribe(model, audio, beam, language, vad, temperatures)
            except Exception as e:
                send({"type": "error", "message": f"Transcription failed: {e}"})
                return
            send({"type": "segment", "text": text, "seq": seq})
        elif mtype == "end":
            break


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001 — report anything to the extension
        send({"type": "error", "message": f"stt_worker crashed: {e}"})
