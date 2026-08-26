/**
 * Lifecycle artifacts — the observability substrate.
 *
 * Per run (mirrors the reference's `async-subagent-runs/<id>/` layout):
 *   <runDir>/
 *     status.json    machine-readable state (single source of truth for UI)
 *     events.jsonl   lifecycle + annotated child events, append-only
 *     output.log     raw child stdout tail (live)
 *     output.md      final assistant output (written on completion)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunEvent, RunStatus } from "./types.ts";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function createRunDir(root: string, runId: string): string {
  const dir = path.join(root, runId);
  ensureDir(dir);
  return dir;
}

export function writeStatus(dir: string, status: RunStatus): void {
  try {
    fs.writeFileSync(path.join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  } catch {
    // Status writes are best-effort observability; never fail a run for them.
  }
}

export function appendEvent(dir: string, event: RunEvent): void {
  try {
    fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
  } catch {
    // best effort
  }
}

export function appendOutputLog(dir: string, text: string): void {
  if (!text) return;
  try {
    fs.appendFileSync(path.join(dir, "output.log"), text, "utf-8");
  } catch {
    // best effort
  }
}

export function writeOutputFile(dir: string, text: string): string {
  const file = path.join(dir, "output.md");
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

/** Read a run's status.json if present. */
export function readStatusFile(dir: string): RunStatus | undefined {
  const file = path.join(dir, "status.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RunStatus;
  } catch {
    return undefined;
  }
}

/** Enumerate run dirs under an artifact root. */
export function listRunDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "timed-out", "interrupted"]);

/**
 * Mark runs that were mid-flight when the parent restarted as interrupted.
 * Our in-memory registry is empty after a reload, so any `running`/`queued`
 * status on disk belongs to a previous process.
 */
export function markStaleRunsInterrupted(root: string): number {
  let marked = 0;
  for (const dir of listRunDirs(root)) {
    const status = readStatusFile(dir);
    if (!status) continue;
    if (status.state === "running" || status.state === "queued") {
      status.state = "interrupted";
      status.error = "Parent session restarted while this run was active.";
      status.endedAt = new Date().toISOString();
      status.lastUpdate = status.endedAt;
      writeStatus(dir, status);
      appendEvent(dir, {
        type: "subagent.run.interrupted",
        timestamp: status.endedAt,
        runId: status.runId,
        agent: status.agent,
      });
      marked++;
    }
  }
  return marked;
}

/** Prune terminal run dirs older than `retainMs` (and any dirs without a status). */
export function pruneOldArtifacts(root: string, retainMs: number): number {
  let pruned = 0;
  const now = Date.now();
  for (const dir of listRunDirs(root)) {
    const status = readStatusFile(dir);
    if (!status) {
      // Not a run dir (e.g. stray file) or corrupt: remove if old.
      try {
        const stat = fs.statSync(dir);
        if (now - stat.mtimeMs > retainMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          pruned++;
        }
      } catch {
        // ignore
      }
      continue;
    }
    if (!TERMINAL_STATES.has(status.state)) continue;
    const endedAt = status.endedAt ? Date.parse(status.endedAt) : NaN;
    const ageMs = Number.isFinite(endedAt) ? now - endedAt : now - Date.parse(status.lastUpdate);
    if (ageMs > retainMs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned++;
      } catch {
        // ignore
      }
    }
  }
  return pruned;
}
