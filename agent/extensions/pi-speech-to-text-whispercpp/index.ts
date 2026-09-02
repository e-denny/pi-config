/**
 * pi-speech-to-text-whispercpp
 *
 * Hold Alt+M to dictate. While the input prompt is focused, press and hold
 * Alt+M: the microphone starts immediately and audio is transcribed LOCALLY
 * by whisper.cpp — a persistent `whisper-server` backend runs the model and
 * the worker POSTs 5 s audio windows to it as WAVs (the "persistent backend,
 * not CLI" pattern from Allen Kuo's "Choosing a Real-Time Whisper Engine").
 * Segments are written into the prompt as they are transcribed and a live
 * widget above the editor shows the transcript while listening. Release
 * Alt+M to stop; the final authoritative transcript replaces the partial
 * text.
 *
 * The backend is long-lived: the first dictation starts whisper-server and
 * loads the model once; subsequent dictations reuse the warm server, so a
 * second hold of Alt+M starts transcribing almost instantly. No Python, no
 * faster-whisper, no venv.
 *
 * Alt+M is a modified key, so the terminal reports press/repeat/release as
 * distinct events — no tap-vs-hold timing is needed, and the Space bar (and
 * all other keys) are completely untouched.
 *
 * `/stt on|off` remains as a manual toggle, and in terminals without Kitty
 * keyboard protocol support Alt+M toggles instead of hold-to-dictate.
 *
 * Requirements:
 *   - whisper.cpp installed with `whisper-server` on PATH (Arch: `sudo
 *     pacman -S whisper-cpp`; brew: `brew install whisper-cpp`; or set
 *     PI_STT_WHISPER_SERVER to a custom binary). The ggml model is
 *     downloaded on first use (~0.1-0.5 GB) and cached in <ext>/models/.
 *   - a mic capture tool: ffmpeg (any OS), arecord (Linux), or sox
 *   - a terminal with Kitty keyboard protocol support (kitty, ghostty,
 *     wezterm, foot, konsole) so key-release events are visible. Without it
 *     the extension falls back to the Alt+M toggle.
 *
 * Configuration (environment variables):
 *   PI_STT_MODEL           ggml model: "small.en" (default), "base.en",
 *                          "tiny.en", "small", "medium", "large-v3", ... or a
 *                          full path to a ggml-*.bin file
 *   PI_STT_LANGUAGE        force a language code ("en", "de", ...) or leave
 *                          empty: .en models force "en", multilingual models
 *                          auto-detect per window
 *   PI_STT_THREADS         whisper.cpp compute threads (default: cores, max 8)
 *   PI_STT_BEAM            beam size for beam search (default 1 = greedy)
 *   PI_STT_WINDOW_MS       audio window transcribed per job (default 5000)
 *   PI_STT_MAX_QUEUE       bounded ASR queue, drop-oldest beyond this (default 8)
 *   PI_STT_MAX_SILENCE_MS  auto-stop after this much silence (default 120000)
 *   PI_STT_WHISPER_SERVER  whisper-server binary (default: PATH lookup)
 *   PI_STT_PORT            whisper-server port (default 0 = pick a free port)
 *   PI_STT_GPU             "1" to allow GPU backends (Metal/CUDA/Vulkan);
 *                          default CPU-only
 *   PI_STT_DEVICE          optional mic device override for ffmpeg/arecord
 *   PI_STT_SERVER_VAD      "1" to enable whisper.cpp's neural VAD (silero
 *                          v6.2.0, ~1 MB, auto-downloaded to models/)
 *   PI_STT_VAD_MODEL       optional path to a custom ggml VAD model
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  isKeyRelease,
  isKittyProtocolActive,
  matchesKey,
} from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "worker.mjs");
const WIDGET = "pi-stt";
const EDITOR_MIN_INTERVAL_MS = 120;

interface WorkerMessage {
  type: string;
  text?: string;
  message?: string;
  code?: number;
  seq?: number;
  model?: string;
  language?: string | null;
  sampleRate?: number;
}

export default function (pi: ExtensionAPI) {
  let active = false; // a dictation session is in progress
  let worker: ChildProcessWithoutNullStreams | null = null;
  let workerReady = false; // whisper-server is up inside the worker
  let wantStart = false; // start requested while the worker/server was warming
  let currentSeq = 0; // session sequence number (tags start/segment/done)
  let workerErr = "";
  let prefix = ""; // editor content captured at toggle-on
  let segments: string[] = []; // finalized segment texts
  let partial = ""; // live partial text from deltas (unused by whisper.cpp)
  let finalText: string | null = null; // authoritative final transcript
  let status: "idle" | "connecting" | "listening" | "finalizing" = "idle";
  let lastEditorAt = 0;
  let editorTimer: NodeJS.Timeout | null = null;
  let pendingDone = ""; // done text received during shutdown

  // --- hold-Alt+M-to-dictate state --------------------------------------
  let dictating = false; // Alt+M currently held, dictation active
  let holdUnsub: (() => void) | null = null;
  let sessionCtx: ExtensionContext | null = null;

  // CSI-u sequences for the M key (key code 109). Alt+M is a modified key,
  // so the terminal always reports it as a CSI-u event and press/repeat/
  // release are distinguishable: press = \x1b[109;3u, repeat = \x1b[109;3:2u,
  // release = \x1b[109;3:3u. The release may arrive as \x1b[109;1:3u if Alt
  // was released before M.
  const M_KEY_RELEASE = /^\x1b\[109;(\d+):3u$/;

  /** True for an M-key release without Shift (even encoded-mods value ⇒ Shift held). */
  function isMKeyRelease(data: string): boolean {
    const m = data.match(M_KEY_RELEASE);
    if (!m) return false;
    return (Number(m[1]) & 1) === 1;
  }

  /**
   * Install the raw-key listener that turns "hold Alt+M" into dictation:
   * press starts the mic immediately, release stops it. Requires the Kitty
   * keyboard protocol (key-release events); otherwise Alt+M acts as a toggle.
   */
  function installHoldToDictate(ctx: ExtensionContext) {
    if (holdUnsub) return;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    if (!isKittyProtocolActive()) {
      ctx.ui.notify(
        "pi-speech-to-text-whispercpp: hold-Alt+M dictation needs a Kitty-keyboard-protocol terminal (kitty, ghostty, wezterm, foot). Using Alt+M toggle instead.",
        "warning",
      );
      return;
    }
    holdUnsub = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data)) {
        // Stop on the release of M (Alt may already be up, in which case the
        // terminal reports mods=0). Shift-modified releases (typing "M") are
        // ignored so they don't interrupt dictation.
        if (dictating && isMKeyRelease(data)) {
          dictating = false;
          void stop(sessionCtx ?? ctx);
          return { consume: true };
        }
        return undefined; // releases of any other key pass through
      }
      // press or repeat of Alt+M: start dictation and never let it reach the editor
      if (matchesKey(data, Key.alt("m"))) {
        if (!dictating) {
          dictating = true;
          start(sessionCtx ?? ctx);
        }
        return { consume: true };
      }
      return undefined; // every other key (including Space) passes through untouched
    });
  }

  // -------------------------------------------------------------------------
  // transcript composition
  // -------------------------------------------------------------------------
  function transcriptBody(): string {
    if (finalText !== null) return finalText;
    const parts = [...segments];
    if (partial) parts.push(partial);
    return parts.join(" ").trim();
  }

  function fullEditorText(): string {
    const body = transcriptBody();
    if (!prefix) return body;
    return body ? `${prefix}\n${body}` : prefix;
  }

  // -------------------------------------------------------------------------
  // UI updates
  // -------------------------------------------------------------------------
  function updateWidget(ctx: ExtensionContext) {
    if (!active) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    const body = transcriptBody();
    const short =
      body.length > 160 ? `${body.slice(0, 157)}…` : body || "…listening…";
    const statusLine =
      status === "connecting"
        ? "🎤 Starting local Whisper…"
        : status === "finalizing"
          ? "🎤 Finalizing transcript…"
          : "🎤 Listening — release Alt+M to stop";
    ctx.ui.setWidget(WIDGET, [statusLine, short]);
  }

  function scheduleEditorUpdate(ctx: ExtensionContext, force = false) {
    const now = Date.now();
    const apply = () => {
      lastEditorAt = Date.now();
      ctx.ui.setEditorText(fullEditorText());
    };
    if (force || now - lastEditorAt >= EDITOR_MIN_INTERVAL_MS) {
      if (editorTimer) {
        clearTimeout(editorTimer);
        editorTimer = null;
      }
      apply();
    } else if (!editorTimer) {
      editorTimer = setTimeout(() => {
        editorTimer = null;
        apply();
      }, EDITOR_MIN_INTERVAL_MS - (now - lastEditorAt));
    }
  }

  // -------------------------------------------------------------------------
  // worker lifecycle (one long-lived worker per pi session)
  // -------------------------------------------------------------------------
  function spawnWorker(ctx: ExtensionContext) {
    if (worker) return;
    workerErr = "";
    workerReady = false;
    worker = spawn(process.execPath, [WORKER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    worker.on("error", (err) => {
      worker = null;
      workerReady = false;
      ctx.ui.notify(`pi-speech-to-text-whispercpp: ${err.message}`, "error");
      finalizeStop(ctx);
    });

    worker.stdout.setEncoding("utf8");
    let buf = "";
    worker.stdout.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          handleWorkerMessage(JSON.parse(line) as WorkerMessage, ctx);
        } catch {
          /* ignore malformed line */
        }
      }
    });

    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (d: string) => {
      workerErr += d;
      if (workerErr.length > 4000) workerErr = workerErr.slice(-4000);
    });

    worker.on("exit", (code) => {
      worker = null;
      workerReady = false;
      if (code !== 0 && active && !finalText) {
        const tail = workerErr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
        ctx.ui.notify(`pi-speech-to-text-whispercpp stopped (${code})${tail ? `: ${tail}` : ""}`, "error");
      }
      if (active) finalizeStop(ctx); // the worker respawns on the next start
    });
  }

  function sendWorker(msg: object) {
    try {
      worker?.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* worker dying; its exit handler covers it */
    }
  }

  function handleWorkerMessage(msg: WorkerMessage, ctx: ExtensionContext) {
    switch (msg.type) {
      case "ready":
        workerReady = true;
        if (wantStart) {
          wantStart = false;
          currentSeq += 1;
          sendWorker({ type: "start", seq: currentSeq });
        }
        break;
      case "listening":
        if (active && msg.seq === currentSeq) {
          status = "listening";
          ctx.ui.setStatus(WIDGET, "🎤 Listening — release Alt+M to stop");
          updateWidget(ctx);
        }
        break;
      case "delta": {
        // whisper.cpp returns whole windows, not token deltas — kept for
        // forward compatibility with future streaming backends.
        const text = msg.text ?? "";
        if (text && !partial.endsWith(text)) partial += text;
        updateWidget(ctx);
        scheduleEditorUpdate(ctx, false);
        break;
      }
      case "segment": {
        if (msg.seq !== currentSeq) return; // stale session
        const text = (msg.text ?? "").trim();
        if (text) segments.push(text);
        partial = "";
        updateWidget(ctx);
        scheduleEditorUpdate(ctx, true);
        break;
      }
      case "done": {
        if (msg.seq !== currentSeq) return; // stale session
        finalText = msg.text ?? "";
        pendingDone = finalText;
        status = "finalizing";
        updateWidget(ctx);
        scheduleEditorUpdate(ctx, true);
        finalizeStop(ctx); // worker stays alive; next start is near-instant
        break;
      }
      case "status":
        // worker reported an informational state (e.g. model download,
        // auto-stopped after a long stretch of silence)
        if (msg.message) ctx.ui.notify(`pi-speech-to-text-whispercpp: ${msg.message}`, "info");
        break;
      case "error":
        ctx.ui.notify(`pi-speech-to-text-whispercpp: ${msg.message ?? "unknown error"}`, "error");
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // session control
  // -------------------------------------------------------------------------
  function start(ctx: ExtensionContext) {
    if (active) return;
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("pi-speech-to-text-whispercpp needs the interactive TUI", "error");
      return;
    }

    prefix = ctx.ui.getEditorText() ?? "";
    segments = [];
    partial = "";
    finalText = null;
    pendingDone = "";
    active = true;
    status = "connecting";

    updateWidget(ctx);
    ctx.ui.setStatus(WIDGET, "🎤 Starting local Whisper…");

    if (!worker) {
      wantStart = true;
      spawnWorker(ctx);
      return; // "ready" -> (wantStart) -> sends "start"
    }
    if (!workerReady) {
      wantStart = true;
      return; // server still warming; "ready" will send the start
    }
    currentSeq += 1;
    sendWorker({ type: "start", seq: currentSeq });
  }

  function stop(ctx: ExtensionContext) {
    if (!active) return;
    if (status === "connecting" || status === "listening") {
      status = "finalizing";
      updateWidget(ctx);
      ctx.ui.setStatus(WIDGET, "🎤 Finalizing transcript…");
      if (workerReady) sendWorker({ type: "stop" });
      else {
        // The session never actually started on the worker side (server was
        // still warming) — finish it locally; no done message will arrive.
        wantStart = false;
        finalizeStop(ctx);
      }
    }
    // Otherwise a "done" is already on its way -> finalizeStop on arrival.
  }

  function finalizeStop(ctx: ExtensionContext) {
    if (!active) return;
    active = false;
    status = "idle";
    if (editorTimer) {
      clearTimeout(editorTimer);
      editorTimer = null;
    }
    if (finalText !== null || pendingDone) {
      finalText = finalText ?? pendingDone;
      ctx.ui.setEditorText(fullEditorText());
    }
    ctx.ui.setWidget(WIDGET, undefined);
    ctx.ui.setStatus(WIDGET, undefined);
  }

  function forceStop() {
    // hard cleanup on shutdown; ui may be gone
    dictating = false;
    if (worker) {
      try {
        worker.stdin.write('{"type":"exit"}\n');
        setTimeout(() => {
          try {
            worker?.kill("SIGTERM");
          } catch {}
        }, 500);
      } catch {
        try {
          worker?.kill("SIGTERM");
        } catch {}
      }
    }
    worker = null;
    workerReady = false;
    active = false;
    status = "idle";
  }

  // -------------------------------------------------------------------------
  // registration
  // -------------------------------------------------------------------------
  const toggle = async (ctx: ExtensionContext) => {
    if (active) stop(ctx);
    else start(ctx);
  };

  pi.registerShortcut(Key.alt("m"), {
    description: "Toggle speech-to-text (fallback for non-Kitty terminals; hold Alt+M to dictate)",
    handler: async (ctx) => {
      await toggle(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    installHoldToDictate(ctx);
  });

  pi.registerCommand("stt", {
    description: "Toggle mic speech-to-text (local whisper.cpp); /stt on|off",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const low = arg.toLowerCase();
      if (low === "on") {
        if (active) ctx.ui.notify("pi-speech-to-text-whispercpp already listening", "info");
        else start(ctx);
      } else if (low === "off") {
        if (active) stop(ctx);
        else ctx.ui.notify("pi-speech-to-text-whispercpp is not active", "info");
      } else if (arg === "") {
        await toggle(ctx);
      } else {
        ctx.ui.notify("Usage: /stt [on|off]", "warning");
      }
    },
  });

  pi.on("session_shutdown", () => {
    forceStop();
  });
}
