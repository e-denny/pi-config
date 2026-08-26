/** Shared types for the subagents extension. */

export const LIFECYCLE_ARTIFACT_VERSION = 1 as const;

export type RunState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed-out"
  | "interrupted";

/** A single subagent definition: YAML frontmatter + system prompt body. */
export interface AgentDef {
  /** Canonical runtime name (frontmatter `name`). */
  name: string;
  /** Extra names that resolve to this agent (frontmatter `aliases`). */
  aliases: string[];
  description?: string;
  /** Strict child tool allowlist. `undefined` = child gets pi's normal tools. */
  tools?: string[];
  /** Extension paths loaded in the child (`--extension`). `--no-extensions` is always passed first. */
  extensions?: string[];
  model?: string;
  thinking?: string;
  /** `replace` (default) = agent prompt becomes the child system prompt; `append` = added to pi's base prompt. */
  systemPromptMode: "replace" | "append";
  /** Keep AGENTS.md / CLAUDE.md discovery in the child. */
  inheritProjectContext: boolean;
  /** Keep skill discovery in the child. */
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  timeoutMs?: number;
  async?: boolean;
  /** The markdown system-prompt body after the frontmatter. */
  body: string;
  filePath: string;
  scope: "user" | "project";
}

/** Machine-readable run status, mirrored to `<runDir>/status.json`. */
export interface RunStatus {
  lifecycleArtifactVersion: typeof LIFECYCLE_ARTIFACT_VERSION;
  runId: string;
  sessionId: string;
  mode: "foreground" | "async";
  state: RunState;
  agent: string;
  task: string;
  cwd: string;
  pid?: number;
  startedAt: string;
  lastUpdate: string;
  endedAt?: string;
  durationMs?: number;
  asyncDir: string;
  sessionFile?: string;
  outputFile?: string;
  outputLog?: string;
  model?: string;
  provider?: string;
  totalTokens?: number;
  totalCost?: number;
  turnCount?: number;
  toolCount?: number;
  error?: string;
}

/** One line of `<runDir>/events.jsonl`. */
export interface RunEvent {
  type: string;
  timestamp: string;
  runId: string;
  agent?: string;
  [key: string]: unknown;
}

/** Final result surfaced to the parent. */
export interface RunResult {
  runId: string;
  agent: string;
  state: RunState;
  output: string;
  outputFile?: string;
  model?: string;
  provider?: string;
  totalTokens?: number;
  totalCost?: number;
  turnCount?: number;
  toolCount?: number;
  durationMs?: number;
  error?: string;
}

export interface LifecycleArtifactPayload {
  status: RunStatus;
  events: RunEvent[];
}
