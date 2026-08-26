#!/usr/bin/env node
/**
 * subagent-view.mjs — live readable viewer for one pi-subagents run.
 *
 * Spawned by the extension inside a herdr tab (via `herdr pane run`), this
 * tails the run's artifact dir and renders the child's JSONL protocol events
 * as human-readable text: assistant output streams live, thinking blocks are
 * shown dimmed, tool calls are annotated, and a status footer ticks with
 * state · elapsed · tokens · model.
 *
 * Usage: node subagent-view.mjs <runDir>
 * The run dir is the per-run artifact directory (status.asyncDir), i.e. the
 * directory containing status.json + output.log.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node subagent-view.mjs <runDir>");
  process.exit(1);
}

const statusFile = path.join(runDir, "status.json");
const logFile = path.join(runDir, "output.log");

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "timed-out", "interrupted"]);
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let status = readStatus();
let fd = undefined;
let position = 0; // bytes of output.log already consumed
let lineBuffer = ""; // partial JSONL line
let settled = false;
let lastWasFooter = false;
let lastFooter = "";
let liveTokens = 0;
let liveCost = 0;
let model = "";
let provider = "";
let turnCount = 0;
let thinkingBuf = "";
let textBuf = ""; // buffered assistant text paragraph, flushed at boundaries

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusFile, "utf-8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Output helpers                                                      */
/* ------------------------------------------------------------------ */

function emitContent(text) {
  if (lastWasFooter) process.stdout.write(CLEAR_LINE);
  lastWasFooter = false;
  process.stdout.write(`${text}\n`);
}

function flushText() {
  if (!textBuf) return;
  emitContent(textBuf);
  textBuf = "";
}

function flushThinking() {
  if (!thinkingBuf) return;
  emitContent(`${DIM}… ${thinkingBuf.trim()}${RESET}`);
  thinkingBuf = "";
}

function truncate(text, max) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* JSONL line projection (mirrors src/index.ts readableChildLine,      */
/* plus thinking blocks and tool annotations)                          */
/* ------------------------------------------------------------------ */

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith("{")) {
    // Stray plain-text warning from the child — forward briefly.
    flushText();
    emitContent(trimmed.slice(0, 200));
    return;
  }
  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return; // truncated / malformed JSON line — never print raw
  }

  switch (evt.type) {
    case "message_update": {
      const d = evt.assistantMessageEvent;
      if (d && typeof d === "object") {
        if (d.type === "text_delta" && typeof d.delta === "string" && d.delta) {
          textBuf += d.delta;
        } else if (d.type === "text_end" || d.type === "text_start") {
          flushText();
        } else if (d.type === "thinking_start") {
          flushText();
          thinkingBuf = "";
        } else if (d.type === "thinking_delta" && typeof d.delta === "string") {
          thinkingBuf += d.delta;
        } else if (d.type === "thinking_end") {
          flushThinking();
        }
      }
      if (typeof evt.usage?.totalTokens === "number") liveTokens = evt.usage.totalTokens;
      if (typeof evt.usage?.cost?.total === "number") liveCost = evt.usage.cost.total;
      break;
    }
    case "message_start": {
      const m = evt.message;
      if (m?.role === "assistant") {
        if (m.model) model = m.model;
        if (m.provider) provider = m.provider;
      }
      break;
    }
    case "turn_start": {
      flushText();
      flushThinking();
      turnCount++;
      emitContent(`${DIM}── turn ${turnCount} ──${RESET}`);
      break;
    }
    case "tool_execution_start": {
      flushText();
      flushThinking();
      const args = typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args ?? "");
      emitContent(`${BOLD}⚙ ${evt.toolName ?? evt.name ?? "tool"}${RESET}(${truncate(args, 80)})`);
      break;
    }
    case "tool_execution_end": {
      flushText();
      flushThinking();
      const ok = !evt.isError;
      const tail = ok ? "" : `: ${truncate(evt.result ?? evt.error ?? "error", 120)}`;
      emitContent(`${ok ? "✓" : "✗"} ${evt.toolName ?? evt.name ?? "tool"}${tail}`);
      break;
    }
    case "agent_end":
    case "agent_settled":
    case "session":
    case "message_end":
      // Handled by the status footer / settle detection.
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Live tail + footer                                                  */
/* ------------------------------------------------------------------ */

function pump() {
  if (fd === undefined) {
    if (!fs.existsSync(logFile)) return;
    try {
      fd = fs.openSync(logFile, "r");
    } catch {
      return;
    }
  }
  const buf = Buffer.alloc(64 * 1024);
  let bytes;
  try {
    bytes = fs.readSync(fd, buf, 0, buf.length, position);
  } catch {
    return;
  }
  if (bytes === 0) return;
  position += bytes;
  lineBuffer += buf.subarray(0, bytes).toString("utf-8");
  let idx;
  while ((idx = lineBuffer.indexOf("\n")) !== -1) {
    const line = lineBuffer.slice(0, idx);
    lineBuffer = lineBuffer.slice(idx + 1);
    handleLine(line);
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function footerText() {
  const st = status;
  const state = st?.state ?? "running";
  const started = st?.startedAt ? Date.parse(st.startedAt) : Date.now();
  const elapsed = formatDuration(Date.now() - started);
  const mark = state === "running" || state === "queued" ? "●" : state === "completed" ? "✓" : "✗";
  const tokens = liveTokens > 0 ? ` · ↓ ${liveTokens.toLocaleString()} tokens` : "";
  const cost = liveCost > 0 ? ` · $${liveCost.toFixed(4)}` : "";
  const modelStr = model ? ` · ${provider ? `${provider}/` : ""}${model}` : "";
  return `${mark} ${state} · ${elapsed}${tokens}${cost}${modelStr}`;
}

function updateFooter() {
  const text = footerText();
  if (text !== lastFooter) {
    process.stdout.write(`${CLEAR_LINE}${text}`);
    lastWasFooter = true;
    lastFooter = text;
  }
}

function onSettled() {
  process.stdout.write(CLEAR_LINE);
  lastWasFooter = false;
  const st = status ?? {};
  const mark = st.state === "completed" ? "✓" : "✗";
  const duration = st.durationMs != null ? ` · ${formatDuration(st.durationMs)}` : "";
  const tokens =
    (st.totalTokens ?? liveTokens) > 0
      ? ` · ${(st.totalTokens ?? liveTokens).toLocaleString()} tokens`
      : "";
  const modelStr = st.model ? ` · ${st.model}` : "";
  emitContent(`${mark} run ${st.state ?? "?"}${duration}${tokens}${modelStr}`);
  if (st.error) {
    for (const errLine of truncate(st.error, 600).split("\n")) emitContent(`error: ${errLine}`);
  }
  emitContent(`${DIM}(run settled — ctrl+c to close this tab, scroll up to review)${RESET}`);
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

const st0 = status ?? {};
const cols = process.stdout.columns ?? 100;
const width = Math.min(cols, 120);
const dash = "─".repeat(Math.max(2, width - 20 - String(st0.agent ?? "").length));
console.log(`${BOLD}subagent${RESET} · ${st0.agent ?? "?"} · ${(st0.runId ?? "").slice(0, 8)} ${dash}`);
const task = st0.task ? truncate(st0.task, width - 10) : undefined;
if (task) console.log(`${DIM}task: ${task}${RESET}`);
console.log(`${DIM}dir:  ${runDir}${RESET}`);
console.log("");

/* ------------------------------------------------------------------ */
/* Main loop: pump log + update footer + settle detection              */
/* ------------------------------------------------------------------ */

const interval = setInterval(() => {
  pump();
  status = readStatus();
  if (!settled && status && TERMINAL_STATES.has(status.state)) {
    settled = true;
    pump(); // drain any final lines before the settle banner
    flushText();
    flushThinking();
    onSettled();
    return;
  }
  if (!settled) updateFooter();
}, 250);
// NOTE: deliberately NOT unref'd — the interval is what keeps this process
// alive in the herdr pane. Exiting early would drop the live view.
