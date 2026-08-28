#!/usr/bin/env node
/**
 * pi-speech-to-text worker
 *
 * Captures microphone audio and transcribes it with LOCAL faster-whisper
 * processes (stt_worker.py), running several workers in PARALLEL: while one
 * 5-second window of audio is being transcribed on one CPU, the next windows
 * are already being captured and dispatched to the other workers, so text
 * keeps landing every few seconds during long dictations.
 *
 * stdout protocol (one JSON object per line):
 *   {"type":"ready","model":...,"sampleRate":...}        workers loaded, listening
 *   {"type":"segment","text":"..."}                      finalized segment text
 *   {"type":"done","text":"...","language":...}          final transcript
 *   {"type":"status","message":"..."}                    informational state
 *   {"type":"error","message":"..."}                     fatal error
 *   {"type":"exited","code":...}                         worker is done
 *
 * Control via stdin: a line "stop" ends the session gracefully (kills the
 * mic, transcribes the final partial window, waits for in-flight windows,
 * shuts the workers down and emits done). EOF on stdin has the same effect.
 *
 * Audio is captured continuously while a session is active and cut into fixed
 * PI_STT_WINDOW_MS windows (default 5000 = 5 s of audio per transcription
 * job). Each window is dispatched to the next free faster-whisper worker and
 * results are re-ordered by sequence number, so the transcript is always
 * chronological. Windows that contain no speech (RMS below the silence
 * threshold) are dropped and never sent to a worker — a long pause keeps the
 * microphone active but costs no CPU. PI_STT_MAX_SILENCE_MS of continuous
 * silence auto-stops the session (stuck-space-bar guard).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { cpus, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // pcm_s16le
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 350; // ~1% of full scale, mic noise tolerant
const MAX_BUFFER_SECONDS = 120; // cap audio buffered while workers still load

const args = parseArgs();
const MODEL = args.model || process.env.PI_STT_MODEL || "small";
const DEVICE = args.device || process.env.PI_STT_DEVICE || "cpu";
const COMPUTE = args.compute || process.env.PI_STT_COMPUTE || "int8";
const BEAM = intArg("beam", "PI_STT_BEAM", 1);
const LANGUAGE = args.language || process.env.PI_STT_LANGUAGE || "";
const VAD = args.vad !== "0" && (process.env.PI_STT_VAD ?? "1") !== "0";
const WINDOW_MS = intArg("windowMs", "PI_STT_WINDOW_MS", 5000);
const WORKERS = Math.max(1, Math.min(8, intArg("workers", "PI_STT_WORKERS", 2)));
const MAX_SILENCE_MS = intArg("maxSilenceMs", "PI_STT_MAX_SILENCE_MS", 120000);
const DEVICE_OVERRIDE = args.deviceOverride || process.env.PI_STT_DEVICE || "";
const AUDIO_FILE = args.audioFile || ""; // test mode: stream a raw PCM file instead of the mic
const AUDIO_PACE_MS = intArg("audioPaceMs", "PI_STT_AUDIO_PACE_MS", 100);
const AUDIO_SPEED = Math.max(0.1, Number(args.audioSpeed) || Number(process.env.PI_STT_AUDIO_SPEED) || 1); // test-mode replay speed (1 = realtime)
// Physical core count (SMT-aware): on Linux read it from /proc/cpuinfo so we
// don't oversubscribe hyperthreads; fall back to logical CPU count.
function physicalCores() {
  try {
    if (platform() === "linux") {
      const info = readFileSync("/proc/cpuinfo", "utf8");
      const perChip = [...info.matchAll(/^cpu cores\s*:\s*(\d+)/gm)].map((m) => Number(m[1]))[0];
      const sockets =
        new Set([...info.matchAll(/^physical id\s*:\s*(\d+)/gm)].map((m) => m[1])).size || 1;
      if (perChip) return perChip * sockets;
    }
  } catch {}
  return cpus().length;
}

const CPU_THREADS = Math.max(
  1,
  Math.min(8, intArg("cpuThreads", "PI_STT_CPU_THREADS", Math.max(1, Math.floor(physicalCores() / WORKERS))))
);

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

let pyPool = []; // faster-whisper subprocess pool: {proc, ready, busy, busySeq}
let pendingWindows = []; // windows waiting for a free worker: {seq, data}
let nextSeq = 0; // sequence number of the next dispatched window
let results = new Map(); // seq -> text, in arrival order
let nextEmitSeq = 0; // next seq to emit (in-order gate)
let emitted = []; // ordered non-empty segment texts (final transcript source)
let mic = null;
let ending = false;
let audioBuffer = Buffer.alloc(0); // undivided audio still being captured
let lastSpeechAt = 0; // armed once workers are ready; silence guard anchor
let finalTimer = null;
let micStderr = "";
let pyErrTail = "";
const DEBUG = process.env.PI_STT_DEBUG === "1";

function debug(...parts) {
  if (DEBUG) process.stderr.write(`[stt ${Date.now()}] ${parts.join(" ")}\n`);
}

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
    const chunkBytes = Math.max(64, Math.floor(BYTES_PER_SEC * (AUDIO_PACE_MS / 1000) * AUDIO_SPEED));
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
// audio pipeline: buffer → fixed windows → parallel worker dispatch
// ---------------------------------------------------------------------------
function onAudioChunk(chunk) {
  if (ending) return;
  audioBuffer = Buffer.concat([audioBuffer, chunk]);

  const targetBytes = Math.floor((WINDOW_MS / 1000) * BYTES_PER_SEC);
  while (audioBuffer.length >= targetBytes) {
    const windowBuf = Buffer.from(audioBuffer.subarray(0, targetBytes));
    audioBuffer = Buffer.from(audioBuffer.subarray(targetBytes));
    if (computeRms(windowBuf) >= SILENCE_RMS_THRESHOLD) {
      // Window contains speech → transcribe it.
      lastSpeechAt = Date.now();
      dispatchWindow(windowBuf);
    }
    // else: pure-silence window — dropped, never sent to a worker. The mic
    // stays on; if speech resumes it lands in the next window.
  }

  // Cap buffering while workers are still loading (e.g. first-run download).
  const capBytes = MAX_BUFFER_SECONDS * BYTES_PER_SEC;
  if (audioBuffer.length > capBytes) {
    audioBuffer = Buffer.from(audioBuffer.subarray(audioBuffer.length - capBytes));
  }

  // Stuck-space-bar guard: no speech for a long stretch → stop politely.
  if (MAX_SILENCE_MS > 0 && lastSpeechAt > 0 && Date.now() - lastSpeechAt > MAX_SILENCE_MS) {
    send({ type: "status", message: "No speech detected for a while — stopped listening" });
    stopListening();
  }
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
// parallel dispatch: windows → free workers, results re-ordered by seq
// ---------------------------------------------------------------------------
function dispatchWindow(data) {
  const seq = nextSeq++;
  const w = pyPool.find((p) => p.ready && !p.busy);
  if (w) sendWindow(w, seq, data);
  else pendingWindows.push({ seq, data });
  debug("dispatch seq", seq, w ? `→ worker#${pyPool.indexOf(w)}` : "(queued)");
}

function sendWindow(w, seq, data) {
  w.busy = true;
  w.busySeq = seq;
  try {
    w.proc.stdin.write(JSON.stringify({ type: "window", seq, data: data.toString("base64") }) + "\n");
  } catch {
    // worker died between readiness check and write; it will surface via exit
  }
}

function pump(w) {
  while (pendingWindows.length > 0 && w.ready && !w.busy) {
    const next = pendingWindows.shift();
    sendWindow(w, next.seq, next.data);
  }
}

function emitInOrder() {
  while (results.has(nextEmitSeq)) {
    const text = results.get(nextEmitSeq);
    results.delete(nextEmitSeq);
    nextEmitSeq += 1;
    if (text) {
      emitted.push(text);
      send({ type: "segment", text });
    }
  }
}

// ---------------------------------------------------------------------------
// faster-whisper subprocess pool
// ---------------------------------------------------------------------------
function startPythonPool() {
  const pyEnv = {
    ...process.env,
    PI_STT_MODEL: MODEL,
    PI_STT_DEVICE: DEVICE,
    PI_STT_COMPUTE: COMPUTE,
    PI_STT_CPU_THREADS: String(CPU_THREADS),
    PI_STT_BEAM: String(BEAM),
    PI_STT_VAD: VAD ? "1" : "0",
  };
  if (LANGUAGE) pyEnv.PI_STT_LANGUAGE = LANGUAGE;

  for (let i = 0; i < WORKERS; i++) {
    const w = { proc: null, ready: false, busy: false, busySeq: null, ended: false };
    pyPool.push(w);

    w.proc = spawn(PYTHON, [WORKER_PY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: pyEnv,
    });

    w.proc.on("error", (err) => {
      send({ type: "error", message: `Failed to start faster-whisper worker: ${err.message}` });
      cleanup(1);
    });

    w.proc.stderr.setEncoding("utf8");
    w.proc.stderr.on("data", (d) => {
      pyErrTail += d.toString();
      if (pyErrTail.length > 4000) pyErrTail = pyErrTail.slice(-4000);
    });

    w.proc.stdout.setEncoding("utf8");
    let buf = "";
    w.proc.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          handlePyMessage(JSON.parse(line), w);
        } catch {
          /* ignore malformed line */
        }
      }
    });

    w.proc.on("exit", (code) => {
      w.proc = null;
      w.ready = false;
      w.busy = false;
      if (ending) {
        maybeFinish();
        return;
      }
      const tail = pyErrTail.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      send({ type: "error", message: `Local Whisper worker exited unexpectedly (${code})${tail ? `: ${tail}` : ""}` });
      cleanup(1);
    });
  }

  // Start capturing right away; audio buffers until a worker is ready.
  void startMic().then((ok) => {
    if (!ok && !ending) {
      send({ type: "error", message: "No mic capture tool found (need ffmpeg, arecord, or sox)." });
      cleanup(1);
    }
  });
}

function handlePyMessage(msg, w) {
  switch (msg.type) {
    case "ready":
      w.ready = true;
      if (!ending && pyPool.every((p) => p.ready)) {
        send({ type: "ready", model: msg.model ?? MODEL, sampleRate: msg.sampleRate ?? SAMPLE_RATE });
        lastSpeechAt = Date.now(); // arm the silence guard now that listening works
      }
      pump(w);
      break;
    case "segment":
      if (!Number.isInteger(msg.seq)) {
        send({ type: "error", message: "Worker replied with a missing sequence number" });
        cleanup(1);
        return;
      }
      results.set(msg.seq, msg.text ?? "");
      w.busy = false;
      w.busySeq = null;
      pump(w);
      emitInOrder();
      debug("result seq", msg.seq, "→", JSON.stringify((msg.text ?? "").slice(0, 30)));
      if (ending) tryFinishSession();
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

// ---------------------------------------------------------------------------
// stop / cleanup
// ---------------------------------------------------------------------------
function stopListening() {
  if (ending) return;
  ending = true;
  if (mic && typeof mic.kill === "function") mic.kill("SIGTERM");
  // Final partial window (the tail of what was just said).
  if (audioBuffer.length > 0) {
    if (computeRms(audioBuffer) >= SILENCE_RMS_THRESHOLD) dispatchWindow(audioBuffer);
    audioBuffer = Buffer.alloc(0);
  }
  tryFinishSession();
}

function tryFinishSession() {
  if (!ending) return;
  // All windows accounted for and no worker is mid-transcription.
  if (pendingWindows.length > 0) return;
  if (pyPool.some((w) => w.busy)) return;

  for (const w of pyPool) {
    if (w.proc && w.proc.exitCode === null && !w.ended) {
      w.ended = true;
      try {
        w.proc.stdin.write(JSON.stringify({ type: "end" }) + "\n");
      } catch {
        /* worker already gone */
      }
    }
  }
  if (pyPool.every((w) => !w.proc || w.proc.exitCode !== null)) {
    finishDone();
    return;
  }
  // Fall back if a worker never exits (model still loading, first-run
  // download, etc.). Once ready, transcription of any remaining window takes
  // seconds; before ready, give the model download plenty of time.
  if (finalTimer) clearTimeout(finalTimer);
  const grace = pyPool.every((w) => w.ready) ? 30000 : 600000;
  finalTimer = setTimeout(() => finishDone(), grace);
}

function maybeFinish() {
  if (!ending) return;
  if (pyPool.every((w) => !w.proc || w.proc.exitCode !== null)) {
    if (finalTimer) clearTimeout(finalTimer);
    finishDone();
  }
}

function finishDone() {
  if (finalTimer) clearTimeout(finalTimer);
  send({ type: "done", text: emitted.join(" ").trim(), language: null });
  cleanup(0);
}

function cleanup(code) {
  if (finalTimer) clearTimeout(finalTimer);
  if (mic && typeof mic.kill === "function") mic.kill("SIGTERM");
  for (const w of pyPool) {
    if (w.proc && w.proc.exitCode === null) {
      try {
        w.proc.stdin.end();
      } catch {}
      setTimeout(() => {
        try {
          w.proc.kill("SIGTERM");
        } catch {}
      }, 500);
    }
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

startPythonPool();
