#!/usr/bin/env node
/**
 * pi-speech-to-text worker
 *
 * Captures microphone audio and transcribes it with a LOCAL faster-whisper
 * model (via stt_worker.py). Prints JSON lines to stdout for the pi extension.
 *
 * stdout protocol (one JSON object per line):
 *   {"type":"ready","model":...,"sampleRate":...}        model loaded, listening
 *   {"type":"delta","text":"..."}                        partial (unused locally)
 *   {"type":"segment","text":"..."}                      finalized segment text
 *   {"type":"done","text":"...","language":...}          final transcript
 *   {"type":"status","message":"..."}                    informational state
 *   {"type":"error","message":"..."}                     fatal error
 *   {"type":"exited","code":...}                         worker is done
 *
 * Control via stdin: a line "stop" triggers a graceful end (flushes the
 * remaining audio, waits for transcription.done, then exits). EOF on stdin
 * has the same effect.
 *
 * Audio is buffered locally and transcribed in windows:
 *   - every PI_STT_FLUSH_MS (default 15000 = 15s of speech) the buffered
 *     window is sent to faster-whisper, and
 *   - when PI_STT_SILENCE_MS of low-level audio passes, the window is
 *     flushed early so the text for what you just said lands promptly.
 *
 * faster-whisper is a batch model: results arrive per window (no word-level
 * partials), so keep flush windows short for a responsive dictation feel.
 */
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // pcm_s16le
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 350; // ~1% of full scale, mic noise tolerant

const args = parseArgs();
const MODEL = args.model || process.env.PI_STT_MODEL || "small";
const DEVICE = args.device || process.env.PI_STT_DEVICE || "cpu";
const COMPUTE = args.compute || process.env.PI_STT_COMPUTE || "int8";
const FLUSH_MS = intArg("flushMs", "PI_STT_FLUSH_MS", 15000);
const SILENCE_MS = intArg("silenceMs", "PI_STT_SILENCE_MS", 1500);
const DEVICE_OVERRIDE = args.deviceOverride || process.env.PI_STT_DEVICE || "";
const AUDIO_FILE = args.audioFile || ""; // test mode: stream a raw PCM file instead of the mic
const AUDIO_PACE_MS = intArg("audioPaceMs", "PI_STT_AUDIO_PACE_MS", 100);

// Locate a python that has faster-whisper: prefer the extension's venv.
function pickPython() {
  const explicit = args.python || process.env.PI_STT_PYTHON;
  if (explicit) return explicit;
  const venvPy =
    platform() === "win32"
      ? join(HERE, ".venv", "Scripts", "python.exe")
      : join(HERE, ".venv", "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  // Fall back to a system python; stt_worker.py reports a clear error if
  // faster-whisper isn't installed there.
  return "python3";
}

const PYTHON = pickPython();
const WORKER_PY = join(HERE, "stt_worker.py");

let py = null; // faster-whisper subprocess
let mic = null;
let pyReady = false;
let ending = false;
let doneReceived = false;
let audioBuffer = Buffer.alloc(0); // pending window not yet transcribed
let windowBytes = 0; // bytes accumulated since last flush
let lastAudioAt = 0;
let silentSince = null;
let lastFlushAt = 0;
let micStderr = "";
let pyStderr = "";
let finalTimer = null;

// ---------------------------------------------------------------------------
// stdout protocol
// ---------------------------------------------------------------------------
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------------------
// mic capture: pick the first available tool (ffmpeg > arecord > sox)
// ---------------------------------------------------------------------------
function have(bin) {
  try {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 4000 });
    return r.error === undefined && r.status === 0;
  } catch {
    return false;
  }
}

function pickMicCommand() {
  const ffmpegDevice =
    DEVICE_OVERRIDE ||
    (platform() === "linux" ? "default"
      : platform() === "darwin" ? ":0"
      : "audio=Microphone");
  const candidates = [];
  if (have("ffmpeg")) {
    candidates.push({
      name: "ffmpeg",
      cmd: "ffmpeg",
      args: [
        "-hide_banner", "-loglevel", "error",
        "-f", platform() === "linux" ? "alsa" : platform() === "darwin" ? "avfoundation" : "dshow",
        "-i", ffmpegDevice,
        "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-",
      ],
    });
  }
  if (platform() === "linux" && have("arecord")) {
    const rargs = ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"];
    if (DEVICE_OVERRIDE) rargs.push("-D", DEVICE_OVERRIDE);
    candidates.push({ name: "arecord", cmd: "arecord", args: rargs });
  }
  if (have("sox")) {
    candidates.push({
      name: "sox",
      cmd: "sox",
      args: ["-t", platform() === "linux" ? "alsa" : "coreaudio", DEVICE_OVERRIDE || "default", "-t", "raw", "-r", String(SAMPLE_RATE), "-c", "1", "-e", "signed", "-b", "16", "-"],
    });
  }
  return candidates[0] ?? null;
}

async function startMic() {
  if (AUDIO_FILE) {
    // Test mode: replay a raw s16le PCM file as if it were the mic.
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(AUDIO_FILE);
    let offset = 0;
    const chunkBytes = Math.floor(BYTES_PER_SEC * (AUDIO_PACE_MS / 1000));
    const timer = setInterval(() => {
      if (offset >= data.length) {
        clearInterval(timer);
        if (!ending) stopListening(); // EOF of test file == end of speech
        return;
      }
      const end = Math.min(offset + chunkBytes, data.length);
      onAudioChunk(data.subarray(offset, end));
      offset = end;
    }, AUDIO_PACE_MS);
    mic = { kind: "file", kill: () => clearInterval(timer) };
    return true;
  }

  const pick = pickMicCommand();
  if (!pick) return false;
  if (mic) return true; // reuse the running mic across sessions

  return new Promise((resolve) => {
    mic = spawn(pick.cmd, pick.args, { stdio: ["ignore", "pipe", "pipe"] });
    mic.on("error", (err) => {
      send({ type: "error", message: `Failed to start ${pick.name}: ${err.message}` });
      resolve(false);
    });
    mic.on("spawn", () => resolve(true));
    mic.stderr.on("data", (d) => {
      micStderr += d.toString();
      if (micStderr.length > 4000) micStderr = micStderr.slice(-4000);
    });
    mic.on("exit", (code) => {
      if (!ending && code !== 0) {
        const tail = micStderr.trim().split("\n").slice(-3).join(" ");
        send({ type: "error", message: `Microphone (${pick.name}) exited (${code}): ${tail}` });
        stopListening();
      }
    });
    mic.stdout.on("data", (chunk) => onAudioChunk(chunk));
  });
}

// ---------------------------------------------------------------------------
// audio pipeline: buffer + VAD/micro-batch flush → local transcription
// ---------------------------------------------------------------------------
function onAudioChunk(chunk) {
  if (ending || !pyReady || !py || py.exitCode !== null) return;
  audioBuffer = Buffer.concat([audioBuffer, chunk]);
  windowBytes += chunk.length;
  lastAudioAt = Date.now();

  // --- VAD: flush after a stretch of silence so final text lands promptly ---
  const rms = computeRms(chunk);
  if (rms < SILENCE_RMS_THRESHOLD) {
    if (silentSince === null) silentSince = Date.now();
    if (Date.now() - silentSince >= SILENCE_MS) flushWindow();
  } else {
    silentSince = null;
  }

  // --- micro-batch: flush every FLUSH_MS worth of audio (default 15s) ---
  if (windowBytes >= (FLUSH_MS / 1000) * BYTES_PER_SEC) {
    windowBytes = 0;
    flushWindow();
  }
}

function flushWindow() {
  if (!py || !pyReady || ending) return;
  const now = Date.now();
  if (now - lastFlushAt < 500) return; // never flush twice within 500ms
  lastFlushAt = now;
  if (audioBuffer.length === 0) return;
  py.stdin.write(JSON.stringify({ type: "audio", data: audioBuffer.toString("base64") }) + "\n");
  py.stdin.write(JSON.stringify({ type: "flush" }) + "\n");
  audioBuffer = Buffer.alloc(0);
  windowBytes = 0;
  silentSince = null;
}

function computeRms(buf) {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  const n = buf.length >> 1;
  return n ? Math.sqrt(sum / n) : 0;
}

// ---------------------------------------------------------------------------
// local faster-whisper subprocess
// ---------------------------------------------------------------------------
function startPython() {
  py = spawn(PYTHON, [WORKER_PY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_STT_MODEL: MODEL,
      PI_STT_DEVICE: DEVICE,
      PI_STT_COMPUTE: COMPUTE,
    },
  });

  py.on("error", (err) => {
    send({ type: "error", message: `Failed to start faster-whisper worker: ${err.message}` });
    cleanup(1);
  });

  py.stderr.setEncoding("utf8");
  py.stderr.on("data", (d) => {
    pyStderr += d;
    if (pyStderr.length > 4000) pyStderr = pyStderr.slice(-4000);
  });

  py.stdout.setEncoding("utf8");
  let buf = "";
  py.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        handlePyMessage(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  });

  py.on("exit", (code) => {
    py = null;
    if (!doneReceived) {
      const tail = pyStderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      if (!ending) {
        send({ type: "error", message: `Local Whisper worker exited unexpectedly (${code})${tail ? `: ${tail}` : ""}` });
      }
      cleanup(1);
    }
  });
}

function handlePyMessage(msg) {
  switch (msg.type) {
    case "ready":
      pyReady = true;
      send({ type: "ready", model: msg.model ?? MODEL, sampleRate: msg.sampleRate ?? SAMPLE_RATE });
      void startMic().then((ok) => {
        if (!ok && !ending) {
          send({ type: "error", message: "No mic capture tool found (need ffmpeg, arecord, or sox)." });
          cleanup(1);
        }
      });
      break;
    case "segment":
      if (msg.text) send({ type: "segment", text: msg.text });
      break;
    case "done":
      doneReceived = true;
      send({ type: "done", text: msg.text ?? "", language: msg.language ?? null });
      cleanup(0);
      break;
    case "status":
      send({ type: "status", message: msg.message ?? "" });
      break;
    case "error":
      send({ type: "error", message: msg.message ?? "unknown error" });
      cleanup(1);
      break;
    default:
      break;
  }
}

function active() {
  return !doneReceived || !ending;
}

// ---------------------------------------------------------------------------
// stop / cleanup
// ---------------------------------------------------------------------------
function stopListening() {
  if (ending) return;
  ending = true;
  if (mic && typeof mic.kill === "function") mic.kill("SIGTERM");
  if (py && py.exitCode === null) {
    // Send the final audio window, then end — python replies with done.
    if (audioBuffer.length > 0) {
      py.stdin.write(JSON.stringify({ type: "audio", data: audioBuffer.toString("base64") }) + "\n");
      audioBuffer = Buffer.alloc(0);
    }
    py.stdin.write(JSON.stringify({ type: "end" }) + "\n");
    // Fall back if python never replies. If the model is still loading (first
    // run downloads it), give it plenty of time; once ready, transcription of
    // any remaining window takes seconds.
    const fallbackMs = pyReady ? 30000 : 600000;
    finalTimer = setTimeout(() => cleanup(0), fallbackMs);
  } else {
    cleanup(0);
  }
}

function cleanup(code) {
  if (finalTimer) clearTimeout(finalTimer);
  if (mic && typeof mic.kill === "function") mic.kill("SIGTERM");
  if (py && py.exitCode === null) {
    try {
      py.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        py.kill("SIGTERM");
      } catch {}
    }, 500);
  }
  send({ type: "exited", code });
  process.exit(code);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (d.includes("stop")) stopListening();
});
process.stdin.on("end", stopListening);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// ---------------------------------------------------------------------------
function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const rawKey = a.slice(2);
    // normalize --base-url / --audio-file to camelCase (baseUrl, audioFile)
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = argv[i + 1];
    out[key] = val !== undefined && !val.startsWith("--") ? val : "true";
    if (val !== undefined && !val.startsWith("--")) i++;
  }
  return out;
}

function intArg(argName, envName, def) {
  const raw = args[argName] ?? process.env[envName];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : def;
}

startPython();
