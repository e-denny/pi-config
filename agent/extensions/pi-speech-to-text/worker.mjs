#!/usr/bin/env node
/**
 * pi-speech-to-text worker
 *
 * Captures microphone audio, streams it to Mistral realtime speech-to-text
 * over WebSocket, and prints JSON lines to stdout for the pi extension.
 *
 * stdout protocol (one JSON object per line):
 *   {"type":"ready","model":...,"sampleRate":...}        session established
 *   {"type":"delta","text":"..."}                        partial (live) text
 *   {"type":"segment","text":"..."}                      finalized segment text
 *   {"type":"done","text":"...","language":...}          final transcript
 *   {"type":"error","message":"..."}                     fatal error
 *   {"type":"exited","code":...}                         worker is done
 *
 * Control via stdin: a line "stop" triggers a graceful end (sends
 * input_audio.end, waits for transcription.done, then exits). EOF on stdin
 * has the same effect.
 *
 * Audio is sent in small `input_audio.append` chunks (each well under
 * Mistral's 262144-byte per-message cap) and flushed in micro-batches:
 *   - every PI_STT_FLUSH_MS (default 15000 = 15s of speech) an
 *     `input_audio.flush` forces the server to finalize that window, and
 *   - when PI_STT_SILENCE_MS of low-level audio passes, a flush is sent so
 *     the text for what you just said lands promptly.
 *
 * `target_streaming_delay_ms` (PI_STT_DELAY_MS, default 800) controls how
 * eagerly partial deltas are emitted: low latency = text appears as you
 * speak, higher latency = more accurate but arrives after you finish.
 */
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // pcm_s16le
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const MAX_APPEND_BYTES = 262144; // Mistral per-message cap (decoded)
const SILENCE_RMS_THRESHOLD = 350; // ~1% of full scale, mic noise tolerant

const args = parseArgs();
const API_KEY = args.apiKey || process.env.MISTRAL_API_KEY;
const MODEL =
  args.model || process.env.PI_STT_MODEL || "voxtral-mini-transcribe-realtime-2602";
const BASE_URL =
  args.baseUrl || process.env.PI_STT_BASE_URL || "wss://api.mistral.ai";
const DELAY_MS = intArg("delayMs", "PI_STT_DELAY_MS", 800);
const FLUSH_MS = intArg("flushMs", "PI_STT_FLUSH_MS", 15000);
const SILENCE_MS = intArg("silenceMs", "PI_STT_SILENCE_MS", 1500);
const DEVICE = args.device || process.env.PI_STT_DEVICE || "";
const AUDIO_FILE = args.audioFile || ""; // test mode: stream a raw PCM file instead of the mic
const AUDIO_PACE_MS = intArg("audioPaceMs", "PI_STT_AUDIO_PACE_MS", 100);

if (!API_KEY) {
  send({ type: "error", message: "MISTRAL_API_KEY is not set" });
  process.exit(1);
}

const WS_URL = `${BASE_URL.replace(/^http/, "ws")}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(MODEL)}`;

let ws = null;
let mic = null;
let wsReady = false;
let ending = false;
let doneReceived = false;
let audioWindowBytes = 0; // bytes since last flush (micro-batch window)
let lastAudioAt = 0;
let silentSince = null;
let lastFlushAt = 0;
let micStderr = "";
let wsStderr = "";
let finalTimer = null;
let retries = 0;
let retryTimer = null;
const MAX_RETRIES = 3;

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
    DEVICE ||
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
    const args = ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"];
    if (DEVICE) args.push("-D", DEVICE);
    candidates.push({ name: "arecord", cmd: "arecord", args });
  }
  if (have("sox")) {
    candidates.push({
      name: "sox",
      cmd: "sox",
      args: ["-t", platform() === "linux" ? "alsa" : "coreaudio", DEVICE || "default", "-t", "raw", "-r", String(SAMPLE_RATE), "-c", "1", "-e", "signed", "-b", "16", "-"],
    });
  }
  return candidates[0] ?? null;
}

async function startMic() {
  if (AUDIO_FILE) {
    // Test mode: replay a raw s16le PCM file as if it were the mic.
    const { createReadStream } = await import("node:fs");
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
  if (mic) return true; // reuse the running mic across session retries

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

function onAudioChunk(chunk) {
  if (ending || !wsReady || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "input_audio.append", audio: chunk.toString("base64") }));
  audioWindowBytes += chunk.length;
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
  if (audioWindowBytes >= (FLUSH_MS / 1000) * BYTES_PER_SEC) {
    audioWindowBytes = 0;
    flushWindow();
  }
}

function flushWindow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - lastFlushAt < 500) return; // never flush twice within 500ms
  lastFlushAt = now;
  audioWindowBytes = 0;
  ws.send(JSON.stringify({ type: "input_audio.flush" }));
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
// Mistral realtime WebSocket
// ---------------------------------------------------------------------------
// Transient server errors (vLLM TooManyRequestsError, streaming timeouts,
// premature closes) bubble up from Mistral's realtime backend as error events
// or early closes. Retry the session with backoff instead of dying — the
// backend is occasionally capacity-limited.
function isTransient(msg) {
  const s = String(msg ?? "").toLowerCase();
  // vLLM error class names arrive camelCased with no spaces
  // (e.g. "TooManyRequestsError", "EngineBusyError", "RateLimitError")
  return /too many requests|toomanyrequests|429|timeout|overloaded|rate\s*limit|ratelimit|capacity|unavailable|temporarily|busy/i.test(s);
}

function restartSession(reason) {
  if (ending || retries >= MAX_RETRIES || retryTimer) return false;
  retries++;
  const delay = 2000 * retries; // 2s, 4s, 8s backoff
  wsReady = false;
  if (mic && mic.kind === "file") mic.kill(); // stop replay of a test file
  if (retryTimer) clearTimeout(retryTimer);
  send({ type: "status", message: `Mistral busy (${reason}) — retrying in ${(delay / 1000).toFixed(0)}s (${retries}/${MAX_RETRIES})` });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (ending) return;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "retry");
    } catch {}
    ws = null;
    openSocket();
  }, delay);
  return true;
}

function openSocket() {
  ws = new WebSocket(WS_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const thisWs = ws; // distinguish this socket from any retry socket

  ws.addEventListener("open", () => {
    // No audio until we know the session's negotiated format.
  });

  ws.addEventListener("message", (ev) => {
    let data = ev.data;
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
    else if (data && typeof data === "object" && typeof data.text === "function") data = data.text();
    if (typeof data !== "string") return;
    if (thisWs !== ws) return; // stale socket from a superseded session

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "session.created": {
        // Announce format, then start feeding audio.
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              audio_format: { encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
              target_streaming_delay_ms: DELAY_MS,
            },
          }),
        );
        break;
      }
      case "session.updated": {
        wsReady = true;
        send({ type: "ready", model: MODEL, sampleRate: SAMPLE_RATE });
        void startMic().then((ok) => {
          if (!ok && !ending) {
            send({ type: "error", message: "No mic capture tool found (need ffmpeg, arecord, or sox)." });
            cleanup(1);
          }
        });
        break;
      }
      case "transcription.language":
        break; // informational
      case "transcription.text.delta":
        if (msg.text) send({ type: "delta", text: msg.text });
        break;
      case "transcription.segment":
        if (msg.text) send({ type: "segment", text: msg.text });
        break;
      case "transcription.done":
        doneReceived = true;
        send({ type: "done", text: msg.text ?? "", language: msg.language ?? null });
        cleanup(0);
        break;
      case "error": {
        const detail = msg.error?.message ?? msg.error ?? "unknown error";
        const detailStr = typeof detail === "string" ? detail : JSON.stringify(detail);
        if (isTransient(detailStr)) {
          if (restartSession(detailStr)) break; // retry scheduled
          if (retryTimer) break; // already retrying — ignore duplicate trigger
        }
        send({ type: "error", message: `Mistral: ${detailStr}` });
        cleanup(1);
        break;
      }
      default:
        break;
    }
  });

  ws.addEventListener("close", (ev) => {
    if (thisWs !== ws) return; // stale socket from a superseded session
    if (!doneReceived && !ending) {
      const reason = `Mistral WebSocket closed unexpectedly (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`;
      // Capacity errors often surface as an early close before the session is
      // ready (or as an error event matching isTransient) — retry those.
      if (restartSession(reason)) return; // retry scheduled
      if (retryTimer) return; // retry already pending — ignore close of the old socket
      send({ type: "error", message: reason });
    }
    cleanup(doneReceived ? 0 : 1);
  });

  ws.addEventListener("error", () => {
    // 'close' follows; do the reporting there.
  });
}

// ---------------------------------------------------------------------------
// stop / cleanup
// ---------------------------------------------------------------------------
function stopListening() {
  if (ending) return;
  ending = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (mic && typeof mic.kill === "function") mic.kill("SIGTERM");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input_audio.end" }));
    // Mistral finalizes and sends transcription.done; fall back if slow.
    finalTimer = setTimeout(() => cleanup(0), 10000);
  } else {
    cleanup(0);
  }
}

function cleanup(code) {
  if (finalTimer) clearTimeout(finalTimer);
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (mic && typeof mic.kill === "function") mic.kill("SIGTERM");
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "done");
  } catch {}
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

openSocket();
