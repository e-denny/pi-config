/**
 * Configuration for the subagents extension.
 *
 * Layering, lowest to highest priority:
 *   1. Built-in defaults (below).
 *   2. `<extensionDir>/config.json`           (global, user-scoped)
 *   3. `<cwd>/.pi/subagents.json`             (project-scoped, wins on conflict)
 *   4. Environment variables (`PI_SUBAGENT_*`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes, matches the reference's foreground backstop
export const DEFAULT_MAX_ACTIVE_ASYNC = 4;
export const DEFAULT_MAX_DEPTH = 1;
export const DEFAULT_CONCURRENCY = 4;
export const TASK_ARG_LIMIT = 8000;

export interface ExtensionConfig {
  /** Default model for every subagent that does not set its own (frontmatter or per-call). */
  defaultModel?: string;
  /** Default thinking level for agents without a `thinking` value. */
  defaultThinking?: string;
  /** Default launch context when a call omits `context`. */
  defaultContext?: "fresh" | "fork";
  /** Default to background execution when a call omits `async`. */
  asyncByDefault?: boolean;
  /** Run-level deadline in ms (default 30 min). */
  timeoutMs?: number;
  /** Max concurrently active top-level async runs owned by one session. */
  maxActiveAsyncRunsPerSession?: number;
  /** Max nested delegation depth (children are leaves by default, so this is a backstop). */
  maxSubagentDepth?: number;
  /** Where lifecycle artifacts live: "session" (default), "project", or "temp". */
  artifactDir?: "session" | "project" | "temp";
  /** How the task reaches the child argv: "auto" (inline, file over 8000 chars) or "file" (always). */
  taskDelivery?: "auto" | "file";
  /** Kill tracked children when the parent session shuts down. */
  stopAsyncOnShutdown?: boolean;
  /** Parallel fanout defaults. */
  parallel?: { maxTasks?: number; concurrency?: number };
  /** Terminal run dirs older than this (ms) are pruned on startup. */
  retainTerminalMs?: number;
  /** herdr binary used to open run viewer tabs (default "herdr"). */
  herdrCommand?: string;
}

const ARTIFACT_DIRS = new Set(["session", "project", "temp"]);
const CONTEXTS = new Set(["fresh", "fork"]);
const DELIVERIES = new Set(["auto", "file"]);

export function extensionDir(): string {
  // src/config.ts -> project root
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function getConfigPath(): string {
  return path.join(extensionDir(), "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "subagents.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a raw config object; throws with a clear message on invalid values. */
export function validateConfig(raw: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "defaultModel":
      case "defaultThinking":
        if (value !== undefined && typeof value !== "string") {
          throw new Error(`config.${key} must be a string`);
        }
        break;
      case "defaultContext":
        if (value !== undefined && !CONTEXTS.has(value as string)) {
          throw new Error('config.defaultContext must be "fresh" or "fork"');
        }
        break;
      case "asyncByDefault":
      case "stopAsyncOnShutdown":
        if (value !== undefined && typeof value !== "boolean") {
          throw new Error(`config.${key} must be a boolean`);
        }
        break;
      case "timeoutMs":
      case "maxActiveAsyncRunsPerSession":
      case "maxSubagentDepth":
      case "retainTerminalMs":
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        ) {
          throw new Error(`config.${key} must be a non-negative integer`);
        }
        break;
      case "artifactDir":
        if (value !== undefined && !ARTIFACT_DIRS.has(value as string)) {
          throw new Error('config.artifactDir must be "session", "project", or "temp"');
        }
        break;
      case "herdrCommand":
        if (value !== undefined && typeof value !== "string") {
          throw new Error("config.herdrCommand must be a string (herdr binary or path)");
        }
        break;
      case "taskDelivery":
        if (value !== undefined && !DELIVERIES.has(value as string)) {
          throw new Error('config.taskDelivery must be "auto" or "file"');
        }
        break;
      case "parallel":
        if (value !== undefined) {
          if (!isPlainObject(value)) throw new Error("config.parallel must be an object");
          const { maxTasks, concurrency } = value;
          for (const [k, v] of [["maxTasks", maxTasks], ["concurrency", concurrency]] as const) {
            if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) {
              throw new Error(`config.parallel.${k} must be a positive integer`);
            }
          }
        }
        break;
      default:
        // Unknown keys are ignored for forward compatibility.
        break;
    }
  }
}

function readJsonConfig(file: string): ExtensionConfig {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${file} must be a JSON object`);
  }
  validateConfig(parsed);
  return parsed as ExtensionConfig;
}

/** Load global + project config, project winning on conflicts. */
export function loadConfig(cwd: string): ExtensionConfig {
  const global = readJsonConfig(getConfigPath());
  const project = readJsonConfig(getProjectConfigPath(cwd));
  return { ...global, ...project };
}

export function resolveAsyncByDefault(config: ExtensionConfig): boolean {
  return config.asyncByDefault !== false;
}

export function resolveTimeoutMs(config: ExtensionConfig, agentTimeoutMs?: number, callTimeoutMs?: number): number {
  if (callTimeoutMs !== undefined && callTimeoutMs > 0) return callTimeoutMs;
  if (agentTimeoutMs !== undefined && agentTimeoutMs > 0) return agentTimeoutMs;
  if (config.timeoutMs !== undefined && config.timeoutMs > 0) return config.timeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

export function resolveDefaultContext(config: ExtensionConfig, agentContext?: "fresh" | "fork"): "fresh" | "fork" {
  if (config.defaultContext) return config.defaultContext;
  return agentContext ?? "fresh";
}

export function resolveMaxDepth(config: ExtensionConfig, inherited?: number): number {
  const env = readEnvInt(process.env.PI_SUBAGENT_MAX_DEPTH);
  if (env !== undefined) return env;
  if (inherited !== undefined) return inherited;
  return config.maxSubagentDepth ?? DEFAULT_MAX_DEPTH;
}

export function resolveMaxActiveAsync(config: ExtensionConfig): number {
  return config.maxActiveAsyncRunsPerSession ?? DEFAULT_MAX_ACTIVE_ASYNC;
}

export function resolveParallelDefaults(config: ExtensionConfig): { maxTasks: number; concurrency: number } {
  return {
    maxTasks: config.parallel?.maxTasks ?? 8,
    concurrency: config.parallel?.concurrency ?? DEFAULT_CONCURRENCY,
  };
}

export function resolveTaskDelivery(config: ExtensionConfig): "auto" | "file" {
  const env = process.env.PI_SUBAGENT_TASK_DELIVERY?.trim().toLowerCase();
  if (env === "file") return "file";
  return config.taskDelivery ?? "auto";
}

export function resolveArtifactRoot(config: ExtensionConfig, cwd: string, sessionDir: string | undefined): string {
  switch (config.artifactDir) {
    case "project":
      return path.join(cwd, ".pi", "subagents", "artifacts");
    case "session":
      return sessionDir
        ? path.join(sessionDir, "subagent-artifacts")
        : path.join(os.tmpdir(), "pi-subagents");
    case "temp":
    default:
      return path.join(os.tmpdir(), "pi-subagents");
  }
}

function readEnvInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export { readEnvInt };
