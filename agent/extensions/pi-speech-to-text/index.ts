/**
 * pi-speech-to-text
 *
 * Toggle speech-to-text with a keybinding while the input prompt is focused.
 * Press `Alt+M` (or run `/stt`) to start dictating: microphone audio streams
 * to Mistral's realtime transcription WebSocket, partial transcriptions are
 * streamed into the prompt as you speak, and a live widget above the editor
 * shows the transcript permutating while listening. Press the key again to
 * stop; the final authoritative transcript replaces the partial text.
 *
 * Requirements:
 *   - MISTRAL_API_KEY environment variable
 *   - a mic capture tool: ffmpeg (any OS), arecord (Linux), or sox
 *
 * Configuration (environment variables):
 *   MISTRAL_API_KEY        API key (required)
 *   PI_STT_MODEL           model id (default voxtral-mini-transcribe-realtime-2602)
 *   PI_STT_DELAY_MS        target streaming delay: low = live text as you
 *                          speak, high = more accurate but arrives later
 *                          (default 800)
 *   PI_STT_FLUSH_MS        micro-batch window: audio is sent to Mistral in
 *                          batches of this many seconds worth (default 15000
 *                          = 15s of speech per batch)
 *   PI_STT_SILENCE_MS      after this much silence, the current batch is
 *                          flushed so the text you just said lands promptly
 *                          (default 1500)
 *   PI_STT_DEVICE          optional mic device override for ffmpeg/arecord
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "worker.mjs");
const WIDGET = "pi-stt";
const EDITOR_MIN_INTERVAL_MS = 120;
const CONFIG_FILE = join(getAgentDir(), "pi-speech-to-text.json");

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
        ? "🎤 Connecting to Mistral…"
        : status === "finalizing"
          ? "🎤 Finalizing transcript…"
          : "🎤 Listening — speak now (Alt+M to stop)";
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
  // token / config file
  // -------------------------------------------------------------------------
  function readApiKey(): string | null {
    try {
      if (existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { apiKey?: string };
        if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim();
      }
    } catch {
      // fall through to env
    }
    const env = process.env.MISTRAL_API_KEY;
    return env && env.trim() ? env.trim() : null;
  }

  function saveApiKey(key: string): { ok: boolean; message: string } {
    if (!key) return { ok: false, message: "No token provided" };
    try {
      writeFileSync(CONFIG_FILE, `${JSON.stringify({ apiKey: key.trim() }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(CONFIG_FILE, 0o600);
      return { ok: true, message: `Saved Mistral token to ${CONFIG_FILE}` };
    } catch (err) {
      return { ok: false, message: `Failed to save token: ${(err as Error).message}` };
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
    const apiKey = readApiKey();
    if (!apiKey) {
      ctx.ui.notify(
        "pi-speech-to-text: no Mistral token. Run `/stt key <TOKEN>` or set MISTRAL_API_KEY",
        "error",
      );
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
    ctx.ui.setStatus(WIDGET, "🎤 Connecting…");

    worker = spawn(process.execPath, [WORKER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MISTRAL_API_KEY: apiKey },
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
        ctx.ui.setStatus(WIDGET, "🎤 Listening — Alt+M to stop");
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
        // worker is retrying a transient Mistral backend error
        status = "connecting";
        updateWidget(ctx);
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
    description: "Toggle speech-to-text (mic → Mistral → prompt)",
    handler: async (ctx) => {
      await toggle(ctx);
    },
  });

  pi.registerCommand("stt", {
    description: "Toggle mic speech-to-text (Mistral realtime); /stt on|off|key",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg.startsWith("key ")) {
        const token = arg.slice(4).trim();
        const res = saveApiKey(token);
        ctx.ui.notify(res.message, res.ok ? "info" : "error");
        return;
      }
      if (arg === "key") {
        const has = readApiKey();
        ctx.ui.notify(
          has
            ? `Mistral token is configured (${CONFIG_FILE} or MISTRAL_API_KEY)`
            : `No Mistral token yet — run /stt key <TOKEN> or set MISTRAL_API_KEY`,
          has ? "info" : "warning",
        );
        return;
      }
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
        ctx.ui.notify("Usage: /stt [on|off|key <TOKEN>|key]", "warning");
      }
    },
  });

  pi.on("session_shutdown", () => {
    forceStop();
  });
}
