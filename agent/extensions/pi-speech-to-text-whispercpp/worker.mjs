#!/usr/bin/env node
/**
 * pi-speech-to-text-whispercpp worker
 *
 * A persistent local ASR backend built on whisper.cpp, using the integration
 * pattern from Allen Kuo's "Choosing a Real-Time Whisper Engine":
 *
 *   https://allenkuo.medium.com/choosing-a-real-time-whisper-engine-c4eeb5885e22
 *
 * The article's central trap: do NOT shell out to `whisper-cli` per chunk.
 * CLI numbers are dominated by per-invocation model load. On his benchmark,
 * reading the whisper.cpp CLI numbers naively made it look like the slowest
 * engine (mean 746 ms / RTF 0.199) — but once model load was subtracted the
 * warm compute was the fastest of the three (mean ~199 ms / RTF 0.048), and
 * in persistent server mode it beat faster-whisper outright:
 *
 *   CT2 small                WER 0.076  mean 153 ms  P95 RTF 0.044
 *   whisper.cpp small server WER 0.074  mean 106 ms  P95 RTF 0.024
 *   whisper.cpp small.en     WER 0.064  mean 101 ms  P95 RTF 0.024
 *
 * So the engine here is whisper-server (whisper.cpp's HTTP server), kept
 * alive as a persistent backend: the model loads ONCE and the live pipeline
 * POSTs each audio window as a WAV to /inference.
 *
 * Pipeline (also per the article):
 *   capture -> bounded queue (drop-oldest) -> silence VAD -> single ASR
 *   scheduler -> persistent ASR backend -> ordered segments
 *
 * Serializing ASR jobs instead of parallelizing them is deliberate: with one
 * whisper-server behind a mutex, concurrent POSTs only reorder completion.
 * A single in-flight request keeps timing deterministic, which matters more
 * than optimistic concurrency for real-time dictation.
 *
 * This worker is long-lived: it is spawned once per pi session, starts
 * whisper-server immediately, and serves repeated dictation sessions without
 * ever reloading the model. Sessions are started/stopped over stdin.
 *
 * stdin protocol (one JSON object per line):
 *   {"type":"start","seq":N}   begin a dictation session (open mic)
 *   {"type":"stop"}            end the session (transcribe remainder, emit done)
 *   {"type":"exit"}            shut down whisper-server and exit
 *   EOF                        same as {"type":"exit"}
 *
 * stdout protocol (one JSON object per line):
 *   {"type":"ready","model":...,"sampleRate":16000}  server up, awaiting sessions
 *   {"type":"listening","seq":N}                     session N: mic streaming
 *   {"type":"segment","text":"...","seq":N}          finalized window text
 *   {"type":"done","text":"...","seq":N}             final transcript for session N
 *   {"type":"status","message":"..."}                informational state
 *   {"type":"error","message":"..."}                 fatal error
 *   {"type":"exited","code":...}                     worker is done
 *
 * Audio is captured at 16 kHz mono s16le and cut into fixed WINDOW_MS windows.
 * Windows with no speech (RMS below the silence threshold) are dropped before
 * they ever reach the model — a pause keeps the mic open but costs no CPU.
 * Speech windows are transcribed strictly in order by the single backend.
 */
import { createWriteStream, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { cpus, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // pcm_s16le
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 350; // ~1% of full scale, mic noise tolerant
const MAX_BUFFER_SECONDS = 120; // cap audio buffered while the model still loads
const MODEL_URL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
// whisper.cpp's neural VAD (silero v6.2.0 in ggml format) lives in a separate
// HF repo; it is only downloaded when PI_STT_SERVER_VAD=1.
const VAD_MODEL_URL = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin";
const VAD_MODEL_FILE = join(HERE, "models", "ggml-silero-v6.2.0.bin");

const args = parseArgs();
// Model: bare name ("small.en") or full path to a ggml-*.bin. Default is the
// article's deployment pick — small.en is English-only, quantized, and on a
// multicore CPU it transcribes 5 s windows in ~100-250 ms.
const MODEL_ARG = args.model || process.env.PI_STT_MODEL || "ggml-small.en.bin";
const LANGUAGE = args.language || process.env.PI_STT_LANGUAGE || "";
const THREADS = intArg("threads", "PI_STT_THREADS", Math.min(8, Math.max(1, physicalCores())));
const BEAM = intArg("beam", "PI_STT_BEAM", 1);
const BEST_OF = intArg("bestOf", "PI_STT_BEST_OF", 1);
const TEMPERATURE = floatArg("temperature", "PI_STT_TEMPERATURE", 0.0);
const WINDOW_MS = intArg("windowMs", "PI_STT_WINDOW_MS", 5000);
const MAX_SILENCE_MS = intArg("maxSilenceMs", "PI_STT_MAX_SILENCE_MS", 120000);
const MAX_QUEUE = intArg("maxQueue", "PI_STT_MAX_QUEUE", 8); // bounded window queue (drop-oldest)
const SERVER_BIN = args.serverBin || process.env.PI_STT_WHISPER_SERVER || "whisper-server";
const PORT = intArg("port", "PI_STT_PORT", 0); // 0 = pick a free port
const SERVER_TIMEOUT_MS = intArg("serverTimeoutMs", "PI_STT_SERVER_TIMEOUT_MS", 120000);
const DEVICE_OVERRIDE = args.deviceOverride || process.env.PI_STT_DEVICE || "";
const AUDIO_FILE = args.audioFile || ""; // test mode: stream a raw PCM file instead of the mic
const AUDIO_PACE_MS = intArg("audioPaceMs", "PI_STT_AUDIO_PACE_MS", 100);
const AUDIO_SPEED = Math.max(0.1, Number(args.audioSpeed) || Number(process.env.PI_STT_AUDIO_SPEED) || 1);
const SERVER_VAD = args.serverVad === "1" || (process.env.PI_STT_SERVER_VAD ?? "0") === "1";
// Optional VAD model override; empty = auto-download the default silero model.
const VAD_MODEL = args.vadModel || process.env.PI_STT_VAD_MODEL || "";
// GPU builds (Metal/CUDA/Vulkan) can skip the CPU-only flag with PI_STT_GPU=1.
const USE_GPU = args.gpu === "1" || process.env.PI_STT_GPU === "1";
const DEBUG = process.env.PI_STT_DEBUG === "1";

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
// model resolution + download (first run only)
// ---------------------------------------------------------------------------
function modelPath() {
  // A value with a path separator is an explicit file path; anything else is
  // a model name resolved into <extension>/models/ (e.g. "small.en" ->
  // models/ggml-small.en.bin, "ggml-tiny.en.bin" -> models/ggml-tiny.en.bin).
  if (MODEL_ARG.includes("/") || MODEL_ARG.includes("\\")) return MODEL_ARG;
  const name = MODEL_ARG.endsWith(".bin")
    ? MODEL_ARG
    : MODEL_ARG.startsWith("ggml-")
      ? `${MODEL_ARG}.bin`
      : `ggml-${MODEL_ARG}.bin`;
  return join(HERE, "models", name);
}

function effectiveLanguage(modelFile) {
  if (LANGUAGE) return LANGUAGE;
  // English-only (.en) models force "en" (skips language detection); the
  // server gets "auto" for multilingual models so it detects per window.
  return modelFile.endsWith(".en.bin") ? "en" : "auto";
}

async function ensureModel(file, url) {
  if (existsSync(file)) {
    const head = readFileSync(file).subarray(0, 4).toString();
    // ggml files store the "ggml" magic little-endian, so the on-disk bytes
    // are "lmgg". Accept both spellings to be safe.
    if (head !== "lmgg" && head !== "ggml") {
      send({ type: "error", message: `Model file '${file}' does not look like a ggml model (bad magic). Delete it and try again.` });
      process.exit(1);
    }
    return;
  }
  const name = file.split(/[\\/]/).pop();
  // Download to a .part file and rename on completion, so an interrupted
  // download can never be mistaken for a valid model on the next run.
  const partFile = `${file}.part`;
  try {
    if (existsSync(partFile)) unlinkSync(partFile); // stale partial from an interrupted run
  } catch {}
  send({ type: "status", message: `Downloading ${name}…` });
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    send({ type: "error", message: `Failed to download model ${name}: ${e.message}` });
    process.exit(1);
  }
  if (!res.ok || !res.body) {
    send({ type: "error", message: `Failed to download model ${name} (HTTP ${res.status}).` });
    process.exit(1);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const out = createWriteStream(partFile);
  let received = 0;
  let lastPct = -1;
  const ws = Readable.fromWeb(res.body);
  for await (const chunk of ws) {
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    received += chunk.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        send({ type: "status", message: `Downloading ${name}… ${pct}%` });
      }
    }
  }
  await new Promise((r) => out.end(r));
  if (total > 0 && received !== total) {
    send({ type: "error", message: `Model download incomplete (${received}/${total} bytes). Try again.` });
    process.exit(1);
  }
  renameSync(partFile, file);
  send({ type: "status", message: `Model ${name} downloaded.` });
}

// ---------------------------------------------------------------------------
// whisper-server lifecycle (persistent backend)
// ---------------------------------------------------------------------------
let server = null; // { proc, port, errTail }
let serverReady = false;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(modelFile, vadModel) {
  const port = PORT > 0 ? PORT : await pickFreePort();
  const lang = effectiveLanguage(modelFile);
  const serverArgs = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--model", modelFile,
    "-t", String(THREADS),
    "-l", lang,
  ];
  if (!USE_GPU) serverArgs.push("-ng"); // CPU-only (default); Metal/CUDA builds: PI_STT_GPU=1
  if (vadModel) {
    serverArgs.push("--vad");
    serverArgs.push("--vad-model", vadModel);
  }
  debug("spawning", SERVER_BIN, ...serverArgs);
  const proc = spawn(SERVER_BIN, serverArgs, { stdio: ["ignore", "pipe", "pipe"] });
  server = { proc, port, errTail: "" };

  proc.on("error", (err) => {
    const hint = err.code === "ENOENT"
      ? `whisper-server not found on PATH. Install whisper.cpp (e.g. 'sudo pacman -S whisper-cpp' / 'brew install whisper-cpp') or set PI_STT_WHISPER_SERVER.`
      : err.message;
    send({ type: "error", message: `Failed to start whisper-server: ${hint}` });
    cleanup(1);
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => {
    server.errTail += d;
    if (server.errTail.length > 4000) server.errTail = server.errTail.slice(-4000);
  });

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", () => { /* whisper-server logs to stdout; keep it drained */ });

  proc.on("exit", (code) => {
    const tail = (server?.errTail ?? "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
    const wasRunning = !!server;
    server = null;
    serverReady = false;
    if (wasRunning && !exiting) {
      send({ type: "error", message: `whisper-server exited unexpectedly (${code})${tail ? `: ${tail}` : ""}` });
      cleanup(1);
    }
  });

  // Model is loaded before the server starts listening, so a responding HTTP
  // endpoint means the model is warm. Poll until it answers.
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!server) return; // exited; the exit handler reported it
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        serverReady = true;
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  send({ type: "error", message: `Timed out waiting for whisper-server on port ${port}.` });
  cleanup(1);
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

function startMic() {
  return new Promise((resolve) => {
    if (AUDIO_FILE) {
      // Test mode: replay a raw s16le PCM file as if it were the mic.
      const data = readFileSync(AUDIO_FILE);
      let offset = 0;
      const chunkBytes = Math.max(64, Math.floor(BYTES_PER_SEC * (AUDIO_PACE_MS / 1000) * AUDIO_SPEED));
      const timer = setInterval(() => {
        if (offset >= data.length) {
          clearInterval(timer);
          if (!session.ending) beginEndSession(); // EOF of test file == end of speech
          return;
        }
        const end = Math.min(offset + chunkBytes, data.length);
        onAudioChunk(data.subarray(offset, end));
        offset = end;
      }, AUDIO_PACE_MS);
      session.mic = { kind: "file", kill: () => clearInterval(timer) };
      resolve(true);
      return;
    }

    const pick = pickMicCommand();
    if (!pick) {
      send({ type: "error", message: "No mic capture tool found (need ffmpeg, arecord, or sox)." });
      resolve(false);
      return;
    }
    const mic = spawn(pick.cmd, pick.args, { stdio: ["ignore", "pipe", "pipe"] });
    session.mic = mic;
    mic.on("error", (err) => {
      send({ type: "error", message: `Failed to start ${pick.name}: ${err.message}` });
      resolve(false);
    });
    mic.on("spawn", () => resolve(true));
    mic.stderr.on("data", (d) => {
      if (session.micStderr.length > 4000) session.micStderr = session.micStderr.slice(-4000);
      session.micStderr += d.toString();
    });
    mic.on("exit", (code) => {
      if (!session.ending && code !== 0) {
        const tail = session.micStderr.trim().split("\n").slice(-3).join(" ");
        send({ type: "error", message: `Microphone (${pick.name}) exited (${code}): ${tail}` });
        beginEndSession();
      }
    });
    mic.stdout.on("data", (chunk) => onAudioChunk(chunk));
  });
}

// ---------------------------------------------------------------------------
// session state (a dictation session == one mic capture + its transcript)
// ---------------------------------------------------------------------------
let pendingStart = null; // start command queued while whisper-server warms up

const session = {
  seq: null, // session sequence number from the last start command
  active: false,
  ending: false,
  finished: false, // done message already sent for this session
  mic: null,
  micStderr: "",
  audioBuffer: Buffer.alloc(0), // undivided audio still being captured
  queue: [], // speech windows waiting for the single ASR scheduler
  inFlight: false, // one POST in flight at a time (serialized scheduler)
  segments: [], // ordered non-empty window texts
  lastSpeechAt: 0, // armed once a session starts; silence guard anchor
  droppedWindows: 0,
};

// ---------------------------------------------------------------------------
// audio pipeline: buffer -> fixed windows -> silence VAD -> serialized dispatch
// ---------------------------------------------------------------------------
function onAudioChunk(chunk) {
  if (!session.active || session.ending) return;
  session.audioBuffer = Buffer.concat([session.audioBuffer, chunk]);

  const targetBytes = Math.floor((WINDOW_MS / 1000) * BYTES_PER_SEC);
  while (session.audioBuffer.length >= targetBytes) {
    const windowBuf = Buffer.from(session.audioBuffer.subarray(0, targetBytes));
    session.audioBuffer = Buffer.from(session.audioBuffer.subarray(targetBytes));
    if (computeRms(windowBuf) >= SILENCE_RMS_THRESHOLD) {
      // Window contains speech -> transcribe it.
      session.lastSpeechAt = Date.now();
      queueWindow(windowBuf);
    }
    // else: pure-silence window — dropped, never sent to the model.
  }

  // Cap buffering while the model is still warming (e.g. first-run load).
  const capBytes = MAX_BUFFER_SECONDS * BYTES_PER_SEC;
  if (session.audioBuffer.length > capBytes) {
    session.audioBuffer = Buffer.from(session.audioBuffer.subarray(session.audioBuffer.length - capBytes));
  }

  // Stuck-space-bar guard: no speech for a long stretch -> stop politely.
  if (MAX_SILENCE_MS > 0 && session.lastSpeechAt > 0 && Date.now() - session.lastSpeechAt > MAX_SILENCE_MS) {
    send({ type: "status", message: "No speech detected for a while — stopped listening" });
    beginEndSession();
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

// Bounded queue with drop-oldest: never let stale audio pile up behind a
// slow model (the article's "small bounded queue with drop-oldest" lesson).
function queueWindow(data) {
  if (session.queue.length >= MAX_QUEUE) {
    session.queue.shift();
    session.droppedWindows += 1;
    send({ type: "status", message: "ASR falling behind — dropped the oldest audio window to stay real-time" });
  }
  session.queue.push(data);
  pump();
}

// Single ASR scheduler: exactly one /inference request in flight, windows
// transcribed strictly in order. Determinism beats optimistic concurrency.
function pump() {
  if (session.inFlight) return;
  if (session.queue.length > 0) {
    const pcm = session.queue.shift();
    session.inFlight = true;
    transcribeWindow(pcm)
      .then((text) => {
        session.inFlight = false;
        // whisper.cpp splits a window into segments on pauses; join them with
        // single spaces so the transcript reads as one continuous dictation.
        const t = (text ?? "").replace(/\s+/g, " ").trim();
        if (t) {
          session.segments.push(t);
          send({ type: "segment", text: t, seq: session.seq });
        }
        if (session.ending && session.queue.length === 0) finishSession();
        else pump();
      })
      .catch((err) => {
        session.inFlight = false;
        send({ type: "error", message: `Transcription failed: ${err.message}` });
        cleanup(1);
      });
    return;
  }
  if (session.ending) finishSession();
}

// WAV wrapper around raw s16le PCM (16 kHz mono). whisper-server decodes the
// WAV header itself, so no ffmpeg --convert round-trip is needed.
function wavFromPcm(pcm) {
  const channels = 1;
  const bits = 16;
  const byteRate = SAMPLE_RATE * channels * (bits / 8);
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

async function transcribeWindow(pcm) {
  const form = new FormData();
  form.append("file", new Blob([wavFromPcm(pcm)], { type: "audio/wav" }), "window.wav");
  form.append("response_format", "json");
  form.append("language", LANGUAGE || effectiveLanguage(modelPath()));
  form.append("temperature", String(TEMPERATURE));
  if (BEAM > 1) form.append("beam_size", String(BEAM));
  if (BEST_OF > 1) form.append("best_of", String(BEST_OF));

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${server?.port}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`whisper-server /inference HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  debug("window", pcm.length / BYTES_PER_SEC, "s ->", (data.text ?? "").slice(0, 40), `(${Date.now() - t0} ms)`);
  return data.text ?? "";
}

// ---------------------------------------------------------------------------
// session control
// ---------------------------------------------------------------------------
async function beginSession(seq) {
  if (session.active) return;
  session.seq = seq;
  session.active = true;
  session.ending = false;
  session.finished = false;
  session.audioBuffer = Buffer.alloc(0);
  session.queue = [];
  session.segments = [];
  session.lastSpeechAt = Date.now(); // arm the silence guard as soon as listening starts
  session.droppedWindows = 0;

  const ok = await startMic();
  if (!ok) {
    session.active = false;
    return; // error already reported
  }
  send({ type: "listening", seq });
}

function beginEndSession() {
  if (!session.active || session.ending) return;
  session.ending = true;
  if (session.mic && typeof session.mic.kill === "function") session.mic.kill("SIGTERM");
  // Final partial window (the tail of what was just said).
  if (session.audioBuffer.length > 0) {
    if (computeRms(session.audioBuffer) >= SILENCE_RMS_THRESHOLD) queueWindow(session.audioBuffer);
    session.audioBuffer = Buffer.alloc(0);
  }
  pump(); // transcribe whatever is queued, then finishSession()
}

function finishSession() {
  if (!session.active || !session.ending || session.finished) return;
  session.finished = true;
  const text = session.segments.join(" ").trim();
  send({ type: "done", text, seq: session.seq, language: effectiveLanguage(modelPath()) });
  debug("session", session.seq, "done:", JSON.stringify(text.slice(0, 60)));
  session.active = false;
  session.mic = null;
  session.micStderr = "";
}

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------
let exiting = false;

function cleanup(code) {
  if (exiting) return; // stdin 'end' + an explicit exit command can race
  exiting = true;
  if (session.mic && typeof session.mic.kill === "function") session.mic.kill("SIGTERM");
  if (server && server.proc && server.proc.exitCode === null) {
    try {
      server.proc.kill("SIGTERM");
    } catch {}
  }
  send({ type: "exited", code });
  setTimeout(() => process.exit(code), 50);
}

process.stdin.setEncoding("utf8");
let stdinBuf = "";
process.stdin.on("data", (d) => {
  stdinBuf += d;
  let nl;
  while ((nl = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    switch (msg.type) {
      case "start":
        if (!serverReady) {
          // Shouldn't normally happen (index.ts waits for ready), but queue it.
          send({ type: "status", message: "whisper-server still starting — will begin when ready" });
          pendingStart = msg.seq;
        } else {
          void beginSession(msg.seq);
        }
        break;
      case "stop":
        beginEndSession();
        break;
      case "exit":
        cleanup(0);
        break;
      default:
        break;
    }
  }
});
process.stdin.on("end", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
process.on("SIGINT", () => cleanup(0));

// ---------------------------------------------------------------------------
function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const rawKey = a.slice(2);
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

function floatArg(argName, envName, def) {
  const raw = args[argName] ?? process.env[envName];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : def;
}

// ---------------------------------------------------------------------------
// boot: download the model if needed, start the persistent server, announce
// ---------------------------------------------------------------------------
const MODEL_FILE = modelPath();
const MODEL_NAME = MODEL_FILE.split(/[\\/]/).pop();
ensureModel(MODEL_FILE, `${MODEL_URL_BASE}/${encodeURIComponent(MODEL_NAME)}`).then(async () => {
  let vadModel = "";
  if (SERVER_VAD) {
    vadModel = VAD_MODEL || VAD_MODEL_FILE;
    if (!VAD_MODEL) await ensureModel(VAD_MODEL_FILE, VAD_MODEL_URL); // auto-download silero
  }
  await startServer(MODEL_FILE, vadModel);
  if (!server) return; // startServer reported the failure
  send({ type: "ready", model: MODEL_NAME, sampleRate: SAMPLE_RATE, serverPort: server.port });
  if (pendingStart !== null) {
    const seq = pendingStart;
    pendingStart = null;
    void beginSession(seq);
  }
});
