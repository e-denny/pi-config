/**
 * Run orchestration: registry, child launch/watch, foreground + async
 * execution, stop, status, and cleanup.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import type { AgentDef, RunResult, RunState, RunStatus } from "./types.ts";
import { LIFECYCLE_ARTIFACT_VERSION } from "./types.ts";
import {
  type ExtensionConfig,
  resolveArtifactRoot,
  resolveDefaultContext,
  resolveMaxDepth,
  resolveTimeoutMs,
} from "./config.ts";
import { removeTempDir, spawnChild, type SpawnedChild } from "./spawn.ts";
import { createChildProtocol, type ProtocolSnapshot } from "./child-protocol.ts";
import {
  appendEvent,
  appendOutputLog,
  createRunDir,
  ensureDir,
  writeOutputFile,
  writeStatus,
} from "./artifacts.ts";

export const SUBAGENT_STOP_REQUEST_EVENT = "subagent:stop-request";

export interface LaunchSpec {
  agent: AgentDef;
  task: string;
  /** Pre-assigned run id (lets callers subscribe to stop events before launch). */
  runId?: string;
  context?: "fresh" | "fork";
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  async: boolean;
  sessionDir?: string;
  parentSessionFile?: string;
  parentSessionId?: string;
  sessionId: string;
}

export interface AsyncReceipt {
  runId: string;
  asyncDir: string;
  agent: string;
}

interface RunEntry {
  status: RunStatus;
  dir: string;
  spawned?: SpawnedChild;
  protocol: ReturnType<typeof createChildProtocol>;
  timedOut: boolean;
  stopped: boolean;
  settled: boolean;
  timeoutHandle?: NodeJS.Timeout;
  foreground?: {
    resolve: (result: RunResult) => void;
    reject: (error: Error) => void;
  };
  stderr: string[];
}

interface RegistryState {
  runs: Map<string, RunEntry>;
  events: EventEmitter;
}

const REGISTRY_KEY = "__piSubagentsRuntimeV1";

function getRegistry(): RegistryState {
  const globalStore = globalThis as unknown as Record<string, unknown>;
  const existing = globalStore[REGISTRY_KEY] as RegistryState | undefined;
  if (existing?.runs instanceof Map && existing.events instanceof EventEmitter) {
    return existing;
  }
  const registry: RegistryState = { runs: new Map(), events: new EventEmitter() };
  globalStore[REGISTRY_KEY] = registry;
  return registry;
}

const registry = getRegistry();

export function getRunEvents(): EventEmitter {
  return registry.events;
}

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

export function getStatus(runId: string): RunStatus | undefined {
  return registry.runs.get(runId)?.status;
}

export function listActiveStatus(): RunStatus[] {
  const active = new Set<RunState>(["queued", "running"]);
  return [...registry.runs.values()]
    .map((entry) => entry.status)
    .filter((status) => active.has(status.state))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function listRecentStatus(limit = 10): RunStatus[] {
  return [...registry.runs.values()]
    .map((entry) => entry.status)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

function updateStatus(entry: RunEntry, patch: Partial<RunStatus>): RunStatus {
  entry.status = { ...entry.status, ...patch, lastUpdate: new Date().toISOString() };
  writeStatus(entry.dir, entry.status);
  return entry.status;
}

/* ------------------------------------------------------------------ */
/* Launch                                                              */
/* ------------------------------------------------------------------ */

export function createRun(spec: LaunchSpec, config: ExtensionConfig): RunEntry {
  const runId = spec.runId ?? randomUUID();
  const cwd = spec.cwd ?? process.cwd();
  const root = resolveArtifactRoot(config, cwd, spec.sessionDir);
  const dir = createRunDir(root, runId);

  const status: RunStatus = {
    lifecycleArtifactVersion: LIFECYCLE_ARTIFACT_VERSION,
    runId,
    sessionId: spec.sessionId,
    mode: spec.async ? "async" : "foreground",
    state: "queued",
    agent: spec.agent.name,
    task: spec.task.slice(0, 2000),
    cwd,
    startedAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    asyncDir: dir,
    sessionFile: spec.parentSessionFile,
  };
  writeStatus(dir, status);
  appendEvent(dir, {
    type: "subagent.run.started",
    timestamp: status.startedAt,
    runId,
    agent: spec.agent.name,
    mode: status.mode,
    context: spec.context ?? resolveDefaultContext(config, spec.agent.defaultContext),
  });

  const entry: RunEntry = {
    status,
    dir,
    protocol: createChildProtocol(),
    timedOut: false,
    stopped: false,
    settled: false,
    stderr: [],
  };
  registry.runs.set(runId, entry);
  return entry;
}

function emitState(entry: RunEntry, state: RunState): void {
  updateStatus(entry, { state });
  registry.events.emit("state-change", entry.status);
}

export interface LaunchedRun {
  runId: string;
  done: Promise<RunResult>;
}

/** Spawn the child, wire stdout/stderr/close, and return the run + completion promise. */
export function launchChild(spec: LaunchSpec, config: ExtensionConfig): LaunchedRun {
  const entry = createRun(spec, config);
  const context = spec.context ?? resolveDefaultContext(config, spec.agent.defaultContext);
  const timeoutMs = resolveTimeoutMs(config, spec.agent.timeoutMs, spec.timeoutMs);
  const depth = resolveMaxDepth(config);

  const spawned = spawnChild({
    agent: spec.agent,
    task: spec.task,
    context,
    model: spec.model,
    cwd: spec.cwd,
    parentSessionFile: spec.parentSessionFile,
    parentSessionId: spec.parentSessionId,
    sessionDir: spec.sessionDir,
    runId: entry.status.runId,
    depth,
    config,
  });
  entry.spawned = spawned;
  updateStatus(entry, { pid: spawned.pid });

  let stderrTail = "";
  spawned.child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderrTail = (stderrTail + text).slice(-128 * 1024); // keep latest 128 KiB
    entry.stderr.push(text);
    if (entry.stderr.length > 64) entry.stderr.shift();
  });

  const done = new Promise<RunResult>((resolve, reject) => {
    entry.foreground = { resolve, reject };

    const timeoutMs = resolveTimeoutMs(config, spec.agent.timeoutMs, spec.timeoutMs);
    entry.timeoutHandle = setTimeout(() => {
      entry.timedOut = true;
      appendEvent(entry.dir, {
        type: "subagent.run.timed-out",
        timestamp: new Date().toISOString(),
        runId: entry.status.runId,
        agent: entry.status.agent,
        timeoutMs,
      });
      spawned.killGroup("SIGTERM");
    }, timeoutMs);
    // Don't let the timer keep the process alive once the child is done.
    entry.timeoutHandle.unref?.();

    spawned.child.on("error", (error) => {
      const err = error as Error;
      appendEvent(entry.dir, {
        type: "subagent.run.spawn-error",
        timestamp: new Date().toISOString(),
        runId: entry.status.runId,
        agent: entry.status.agent,
        error: err.message,
      });
      const result: RunResult = {
        runId: entry.status.runId,
        agent: entry.status.agent,
        state: "failed",
        output: "",
        error: `Failed to spawn child pi: ${err.message}`,
        durationMs: Date.now() - Date.parse(entry.status.startedAt),
      };
      finalizeRun(entry, result);
      resolve(result);
    });

    spawned.child.on("close", (code) => {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      const snap = entry.protocol.snapshot();
      const result = buildResult(entry, snap, code ?? 0, stderrTail);
      finalizeRun(entry, result);
      resolve(result);
    });
  });

  return { runId: entry.status.runId, done };
}

/**
 * Wire an already-spawned child's stdout into the protocol + artifacts.
 * Called after launchChild when a foreground tool wants to stream progress.
 */
export function attachOutputStreams(
  runId: string,
  onActivity?: (line: string) => void,
): void {
  const entry = registry.runs.get(runId);
  const spawned = entry?.spawned;
  if (!entry || !spawned) return;

  let lastActivity = "";
  spawned.child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    entry.protocol.push(text);
    appendOutputLog(entry.dir, text);
    // Coarse live tail for foreground streaming (JSONL lines include events).
    // Forward the FULL last line: the consumer (streamProgress in index.ts)
    // parses JSONL events into human-readable text, so truncating here would
    // break JSON.parse and leak raw fragments into the TUI. Truncation
    // happens in the consumer, after parsing.
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > 0) lastActivity = lines[lines.length - 1]!;
    if (onActivity && lastActivity) onActivity(lastActivity);
  });
}

/** Finalize: write output.md, events, mark state, emit to listeners, cleanup. */
function finalizeRun(entry: RunEntry, result: RunResult): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);

  const outputFile = writeOutputFile(entry.dir, result.output);
  result.outputFile = outputFile;
  updateStatus(entry, {
    state: result.state,
    outputFile,
    endedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    model: result.model,
    provider: result.provider,
    totalTokens: result.totalTokens,
    totalCost: result.totalCost,
    turnCount: result.turnCount,
    toolCount: result.toolCount,
    error: result.error,
  });
  appendEvent(entry.dir, {
    type: `subagent.run.${result.state}`,
    timestamp: entry.status.endedAt ?? new Date().toISOString(),
    runId: entry.status.runId,
    agent: entry.status.agent,
    state: result.state,
    model: result.model,
    totalTokens: result.totalTokens,
    totalCost: result.totalCost,
    durationMs: result.durationMs,
  });

  registry.events.emit("state-change", entry.status);
  registry.events.emit("run-settled", result);
  removeTempDir(entry.spawned?.tempDir);
}

function buildResult(entry: RunEntry, snap: ProtocolSnapshot, exitCode: number, stderrTail: string): RunResult {
  const durationMs = Date.now() - Date.parse(entry.status.startedAt);
  const base: RunResult = {
    runId: entry.status.runId,
    agent: entry.status.agent,
    state: "completed",
    output: snap.output,
    model: snap.model,
    provider: snap.provider,
    totalTokens: snap.totalTokens,
    totalCost: snap.totalCost,
    turnCount: snap.turnCount,
    toolCount: snap.toolCount,
    durationMs,
  };

  if (entry.stopped) {
    return { ...base, state: "stopped", error: "Stopped by user." };
  }
  if (entry.timedOut) {
    return { ...base, state: "timed-out", error: "Subagent timed out." };
  }
  if (exitCode !== 0 || !snap.settled) {
    const stderr = stderrTail.trim();
    return {
      ...base,
      state: "failed",
      error: stderr ? `Child pi exited with code ${exitCode}:\n${stderr.slice(-4000)}` : `Child pi exited with code ${exitCode} without settling.`,
    };
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Foreground / async entry points                                     */
/* ------------------------------------------------------------------ */

/**
 * Run one subagent in the foreground: resolves with the final result.
 * `onActivity` receives the latest child stdout line for streaming progress.
 */
export async function runForeground(
  spec: LaunchSpec,
  config: ExtensionConfig,
  onActivity?: (line: string) => void,
): Promise<RunResult> {
  const { runId, done } = launchChild(spec, config);
  attachOutputStreams(runId, onActivity);
  const entry = registry.runs.get(runId)!;
  emitState(entry, "running");
  return done;
}

/** Launch one subagent in the background and return immediately. */
export function launchAsync(spec: LaunchSpec, config: ExtensionConfig): AsyncReceipt {
  const { runId } = launchChild(spec, config);
  attachOutputStreams(runId);
  const entry = registry.runs.get(runId)!;
  emitState(entry, "running");
  return {
    runId,
    asyncDir: entry.dir,
    agent: spec.agent.name,
  };
}

/* ------------------------------------------------------------------ */
/* Control                                                             */
/* ------------------------------------------------------------------ */

/** Stop a run: SIGTERM the process group, escalate to SIGKILL after 5s. */
export function stopRun(runId: string): boolean {
  const entry = registry.runs.get(runId);
  if (!entry) return false;
  if (entry.settled || entry.stopped) return false;

  entry.stopped = true;
  appendEvent(entry.dir, {
    type: "subagent.stop.requested",
    timestamp: new Date().toISOString(),
    runId,
    agent: entry.status.agent,
  });
  // Wake any foreground tool call waiting on this run (no-op if none).
  registry.events.emit(SUBAGENT_STOP_REQUEST_EVENT, runId);

  const spawned = entry.spawned;
  if (!spawned) {
    // Not yet spawned (queued): finalize immediately.
    const result: RunResult = {
      runId,
      agent: entry.status.agent,
      state: "stopped",
      output: "",
      error: "Stopped by user before spawn.",
      durationMs: 0,
    };
    finalizeRun(entry, result);
    return true;
  }

  spawned.killGroup("SIGTERM");
  const killTimer = setTimeout(() => {
    spawned.killGroup("SIGKILL");
  }, 5000);
  killTimer.unref?.();

  const child = spawned.child;
  if (child.exitCode === null) {
    // Force the close path to finalize even if the child ignores signals.
    const force = setTimeout(() => {
      if (!entry.settled) {
        const snap = entry.protocol.snapshot();
        const result = buildResult(entry, snap, 1, "");
        finalizeRun(entry, result);
      }
    }, 8000);
    force.unref?.();
  }
  return true;
}

/** Kill every tracked child (session shutdown). Returns count killed. */
export function stopAllChildren(): number {
  let count = 0;
  for (const [runId, entry] of registry.runs.entries()) {
    if (entry.settled) continue;
    if (entry.spawned?.child.exitCode === null) {
      entry.stopped = true;
      entry.spawned.killGroup("SIGTERM");
      count++;
    }
  }
  return count;
}

/** Mark a foreground run as abandoned if the tool call was interrupted. */
export function abandonRun(runId: string): void {
  const entry = registry.runs.get(runId);
  if (!entry || entry.settled) return;
  entry.stopped = true;
  entry.spawned?.killGroup("SIGTERM");
  const result: RunResult = {
    runId,
    agent: entry.status.agent,
    state: "stopped",
    output: entry.protocol.snapshot().output,
    error: "Abandoned (tool call interrupted).",
    durationMs: Date.now() - Date.parse(entry.status.startedAt),
  };
  finalizeRun(entry, result);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export interface LiveUsage {
  totalTokens?: number;
  totalCost?: number;
  turnCount: number;
  toolCount: number;
}

/**
 * Live projection for an active run: usage fields parsed so far from the
 * child's stdout protocol. Undefined for unknown/settled runs (settled runs
 * carry final figures on their status).
 */
export function getLiveUsage(runId: string): LiveUsage | undefined {
  const entry = registry.runs.get(runId);
  if (!entry) return undefined;
  const snap = entry.protocol.snapshot();
  return {
    totalTokens: snap.totalTokens,
    totalCost: snap.totalCost,
    turnCount: snap.turnCount,
    toolCount: snap.toolCount,
  };
}

export function formatStatusLine(status: RunStatus, live?: LiveUsage): string {
  const state = status.state;
  const agent = status.agent;
  const startedMs = Date.parse(status.startedAt);
  const endedMs = status.endedAt ? Date.parse(status.endedAt) : undefined;
  // Settled runs use their recorded window; active runs get a live elapsed
  // time at render time so the widget can tick every few seconds.
  const duration = formatDuration(endedMs !== undefined ? endedMs - startedMs : Date.now() - startedMs);
  const totalTokens = live?.totalTokens ?? status.totalTokens;
  const tokens = totalTokens !== undefined ? ` · ↓ ${totalTokens.toLocaleString()} tokens` : "";
  const model = status.model ? ` · ${status.model}` : "";
  return `${state === "running" ? "●" : state === "completed" ? "✓" : "✗"} ${agent} · ${state} · ${duration}${tokens}${model}`;
}

export function formatStatusText(statuses: RunStatus[]): string {
  if (statuses.length === 0) return "No subagent runs.";
  const lines = statuses.map((status, index) => {
    const id = status.runId.slice(0, 8);
    const output = status.outputFile ? ` · output: ${path.basename(status.outputFile)}` : "";
    return `${index + 1}. ${formatStatusLine(status)} (${id})${output}`;
  });
  const active = statuses.filter((s) => s.state === "running" || s.state === "queued").length;
  const header = active > 0 ? `${active} active · ${statuses.length} recent` : `${statuses.length} recent`;
  return `${header}\n${lines.join("\n")}`;
}
