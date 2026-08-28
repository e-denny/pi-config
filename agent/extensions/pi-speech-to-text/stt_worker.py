#!/usr/bin/env python3
"""
pi-speech-to-text local worker (faster-whisper backend)

Reads framed 16 kHz mono s16le audio from stdin and emits JSON lines on
stdout — a local faster-whisper backend for the pi extension.

stdin protocol (one JSON object per line):
  {"type":"audio","data":"<base64 s16le>"}   append audio to the current window
  {"type":"flush"}                           transcribe the accumulated window
  {"type":"end"}                             transcribe remainder, then exit
  EOF                                        same as {"type":"end"}

stdout protocol (one JSON object per line):
  {"type":"ready","model":...,"sampleRate":16000}   model loaded, accepting audio
  {"type":"segment","text":"..."}                   finalized transcription of a window
  {"type":"done","text":"...","language":...}       final transcript, then exit
  {"type":"error","message":"..."}                  fatal error

faster-whisper is a batch model: it cannot emit word-by-word partials, so
segments arrive per flushed window. Keep windows short (a few seconds) for a
responsive dictation feel; with VAD enabled, silent padding inside each window
is trimmed automatically.
"""
import base64
import json
import os
import sys


def log(msg: str) -> None:
    sys.stderr.write(f"[stt_worker] {msg}\n")
    sys.stderr.flush()


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    model_size = os.environ.get("PI_STT_MODEL", "small")
    device = os.environ.get("PI_STT_DEVICE", "cpu")
    compute = os.environ.get("PI_STT_COMPUTE", "int8")
    beam = int(os.environ.get("PI_STT_BEAM", "1"))
    language = os.environ.get("PI_STT_LANGUAGE") or None
    vad = os.environ.get("PI_STT_VAD", "1") != "0"

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
        log(f"loading WhisperModel({model_size!r}, device={device!r}, compute_type={compute!r})…")
        model = WhisperModel(model_size, device=device, compute_type=compute)
    except Exception as e:
        send({"type": "error", "message": f"Failed to load Whisper model '{model_size}': {e}"})
        return

    log(f"ready: model={model_size} device={device} compute={compute}")
    send({"type": "ready", "model": model_size, "sampleRate": 16000})

    buffer = bytearray()
    transcript_parts: list[str] = []

    def transcribe_window(force: bool = False) -> None:
        """Transcribe buffered audio since the last flush (or all, if force)."""
        nonlocal buffer
        if buffer:
            window = bytes(buffer)
            buffer = bytearray()
            try:
                import numpy as np

                # Raw s16le has no container header, so hand faster-whisper a
                # float32 array directly (16 kHz is Whisper's native rate).
                audio_array = np.frombuffer(window, dtype=np.int16).astype(np.float32) / 32768.0
                segments, info = model.transcribe(
                    audio_array,
                    beam_size=beam,
                    language=language,
                    vad_filter=vad,
                )
                text = "".join(seg.text for seg in segments).strip()
            except Exception as e:
                send({"type": "error", "message": f"Transcription failed: {e}"})
                return
            if text:
                transcript_parts.append(text)
                send({"type": "segment", "text": text})
        if force:
            send({
                "type": "done",
                "text": " ".join(transcript_parts).strip(),
                "language": getattr(info, "language", None) if buffer else None,
            })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mtype = msg.get("type")
        if mtype == "audio":
            buffer.extend(base64.b64decode(msg.get("data", "")))
        elif mtype == "flush":
            transcribe_window(force=False)
        elif mtype == "end":
            transcribe_window(force=True)
            return
    # EOF == end
    transcribe_window(force=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001 — report anything to the extension
        send({"type": "error", "message": f"stt_worker crashed: {e}"})
