/**
 * pi-speech-to-text
 *
 * Hold Alt+M to dictate. While the input prompt is focused, press and hold
 * Alt+M: the microphone starts immediately and audio is transcribed LOCALLY
 * by faster-whisper (a Whisper `base` model runs on this machine via
 * stt_worker.py). Segments are written into the prompt as they are
 * transcribed and a live widget above the editor shows the transcript while
 * listening. Release Alt+M to stop; the final authoritative transcript
 * replaces the partial text.
 *
 * Alt+M is a modified key, so the terminal reports press/repeat/release as
 * distinct events — no tap-vs-hold timing is needed, and the Space bar (and
 * all other keys) are completely untouched.
 *
 * Parallel transcription: audio is cut into ~5 s windows (PI_STT_WINDOW_MS)
 * and distributed over PI_STT_WORKERS faster-whisper processes, so text
 * keeps landing every few seconds during long dictations.
 *
 * `/stt on|off` remains as a manual toggle, and in terminals without Kitty
 * keyboard protocol support Alt+M toggles instead of hold-to-dictate.
 *
 * Requirements:
 *   - faster-whisper installed in .venv (see README)
 *   - a mic capture tool: ffmpeg (any OS), arecord (Linux), or sox
 *   - a terminal with Kitty keyboard protocol support (kitty, ghostty,
 *     wezterm, foot, konsole) so key-release events are visible. Without it
 *     the extension falls back to the Alt+M toggle.
 *
 * Configuration (environment variables):
 *   PI_STT_MODEL           Whisper model size (default "base")
 *   PI_STT_DEVICE          "cpu" (default) — no GPU needed
 *   PI_STT_COMPUTE         quantization (default "int8")
 *   PI_STT_WORKERS         parallel faster-whisper processes (default 2)
 *   PI_STT_WINDOW_MS       audio window transcribed per job (default 5000)
 *   PI_STT_MAX_SILENCE_MS  auto-stop after this much silence (default 120000)
 *   PI_STT_DEVICE          optional mic device override for ffmpeg/arecord
 *   PI_STT_PYTHON          python binary with faster-whisper (default:
 *                          <extension>/.venv/bin/python)
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
  model?: string;
  language?: string | null;
  sampleRate?: number;
}

export default function (pi: ExtensionAPI) {
  let active = false;  let worker: ChildProcessWithoutNullStreams | null = null;
  let workerErr = "";
  let prefix = ""; // editor content captured at toggle-on
  let segments: string[] = []; // finalized segment texts
  let partial = ""; // live partial text from deltas
  let finalText: string | null = null; // authoritative final transcript
  let status: "idle" | "connecting" | "listening" | "finalizing" = "idle";
  let lastEditorAt = 0;
  let editorTimer: NodeJS.Timeout | null = null;
  let pendingDone = ""; // done text received during shutdown, before worker exit

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
        "pi-speech-to-text: hold-Alt+M dictation needs a Kitty-keyboard-protocol terminal (kitty, ghostty, wezterm, foot). Using Alt+M toggle instead.",
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
  // worker lifecycle
  // -------------------------------------------------------------------------
  function start(ctx: ExtensionContext) {
    if (active) return;
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("pi-speech-to-text needs the interactive TUI", "error");
      return;
    }

    prefix = ctx.ui.getEditorText() ?? "";
    segments = [];
    partial = "";
    finalText = null;
    pendingDone = "";
    workerErr = "";
    active = true;
    status = "connecting";

    updateWidget(ctx);
    ctx.ui.setStatus(WIDGET, "🎤 Starting local Whisper…");

    worker = spawn(process.execPath, [WORKER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    worker.on("error", (err) => {
      ctx.ui.notify(`pi-speech-to-text: ${err.message}`, "error");
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
      if (code !== 0 && !finalText && active) {
        const tail = workerErr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
        ctx.ui.notify(`pi-speech-to-text stopped (${code})${tail ? `: ${tail}` : ""}`, "error");
      }
      if (active) finalizeStop(ctx);
    });
  }

  function handleWorkerMessage(msg: WorkerMessage, ctx: ExtensionContext) {
    switch (msg.type) {
      case "ready":
        status = "listening";
        ctx.ui.setStatus(WIDGET, "🎤 Listening — release Alt+M to stop");
        updateWidget(ctx);
        break;
      case "delta": {
        const text = msg.text ?? "";
        if (text && !partial.endsWith(text)) partial += text;
        updateWidget(ctx);
        scheduleEditorUpdate(ctx, false);
        break;
      }
      case "segment": {
        const text = (msg.text ?? "").trim();
        if (text) segments.push(text);
        partial = "";
        updateWidget(ctx);
        scheduleEditorUpdate(ctx, true);
        break;
      }
      case "done":
        finalText = msg.text ?? "";
        pendingDone = finalText;
        status = "finalizing";
        updateWidget(ctx);
        scheduleEditorUpdate(ctx, true);
        break;
      case "status":
        // worker reported an informational state (e.g. auto-stopped after a
        // long stretch of silence, or the model is still loading)
        if (msg.message) ctx.ui.notify(`pi-speech-to-text: ${msg.message}`, "info");
        break;
      case "error":
        ctx.ui.notify(`pi-speech-to-text: ${msg.message ?? "unknown error"}`, "error");
        break;
      default:
        break;
    }
  }

  function stop(ctx: ExtensionContext) {
    if (!active) return;
    if (status === "connecting" || status === "listening") {
      status = "finalizing";
      updateWidget(ctx);
      ctx.ui.setStatus(WIDGET, "🎤 Finalizing transcript…");
      worker?.stdin.write("stop\n");
    }
    // finalizeStop runs when the worker exits (it sends input_audio.end,
    // receives transcription.done, then exits).
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
        worker.kill("SIGTERM");
      } catch {}
      worker = null;
    }
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
    description: "Toggle mic speech-to-text (local faster-whisper); /stt on|off",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const low = arg.toLowerCase();
      if (low === "on") {
        if (active) ctx.ui.notify("pi-speech-to-text already listening", "info");
        else start(ctx);
      } else if (low === "off") {
        if (active) stop(ctx);
        else ctx.ui.notify("pi-speech-to-text is not active", "info");
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
