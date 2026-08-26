/**
 * Child process spawning: resolve the pi binary, build child CLI args,
 * and spawn a detached (own process-group) child.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionConfig } from "./config.ts";
import { TASK_ARG_LIMIT } from "./config.ts";
import type { AgentDef } from "./types.ts";

export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export const PI_SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const PI_SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const PI_SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const PI_SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

export interface ChildLaunchOptions {
  agent: AgentDef;
  task: string;
  context: "fresh" | "fork";
  /** Final `--model` argument; thinking suffix already applied by the caller. */
  model?: string;
  cwd?: string;
  parentSessionFile?: string;
  parentSessionId?: string;
  sessionDir?: string;
  runId: string;
  depth: number;
  config: ExtensionConfig;
}

interface PiCommand {
  command: string;
  args: string[];
}

function findPackageRoot(entryFile: string): string | undefined {
  let dir = path.dirname(entryFile);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown };
        if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
      } catch {
        // keep walking
      }
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * Resolve the pi binary/script to spawn children with.
 * Priority: PI_SUBAGENT_PI_BINARY env, standalone `pi` executable running us,
 * the installed @earendil-works/pi-coding-agent CLI script, then `pi` on PATH.
 */
export function resolvePiCommand(): PiCommand {
  const envBinary = process.env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
  if (envBinary) return { command: envBinary, args: [] };

  const execPath = process.execPath;
  if (/^pi(?:\.exe)?$/i.test(path.basename(execPath))) {
    return { command: execPath, args: [] };
  }

  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const root = findPackageRoot(entry);
    if (root) {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
        bin?: string | Record<string, string>;
      };
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (bin) {
        const candidate = path.resolve(root, bin);
        if (fs.existsSync(candidate)) return { command: execPath, args: [candidate] };
      }
    }
  } catch {
    // fall through to PATH
  }

  return { command: "pi", args: [] };
}

/** Build the full child argv + env for one subagent launch. */
export function buildChildArgs(opts: ChildLaunchOptions): {
  args: string[];
  env: Record<string, string>;
  tempDir?: string;
} {
  const { agent, task, config } = opts;
  const args: string[] = ["--mode", "json", "-p"];

  // --- context ---
  if (opts.context === "fork" && opts.parentSessionFile) {
    args.push("--fork", opts.parentSessionFile);
  } else {
    args.push("--no-session");
    if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
  }

  // --- model (the caller resolves the id and applies the thinking suffix
  // --- only for reasoning-capable models; suffixing a non-reasoning model
  // --- breaks model resolution inside the child) ---
  if (opts.model) args.push("--model", opts.model);

  // --- tools (strict allowlist when the agent declares one) ---
  if (agent.tools) {
    args.push(agent.tools.length > 0 ? "--tools" : "--no-tools");
    if (agent.tools.length > 0) args.push(agent.tools.join(","));
  }

  // --- extensions: children are leaves; only explicitly listed extensions load ---
  args.push("--no-extensions");
  for (const ext of agent.extensions ?? []) args.push("--extension", ext);

  // --- context files / skills ---
  if (!agent.inheritProjectContext) args.push("--no-context-files");
  if (!agent.inheritSkills) args.push("--no-skills");

  // --- system prompt ---
  let tempDir: string | undefined;
  const prompt = agent.body.trim();
  if (prompt) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const promptPath = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
    args.push(
      agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt",
      promptPath,
    );
  }

  // --- task delivery (argv inline, or @file for long tasks / file mode) ---
  const taskDelivery = process.env.PI_SUBAGENT_TASK_DELIVERY?.trim().toLowerCase() === "file"
    ? "file"
    : config.taskDelivery ?? "auto";
  const useFile = taskDelivery === "file" || task.length > TASK_ARG_LIMIT;
  if (useFile) {
    tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const taskPath = path.join(tempDir, "task.md");
    fs.writeFileSync(taskPath, `Task: ${task}`, { mode: 0o600 });
    args.push(`@${taskPath}`);
  } else {
    args.push(`Task: ${task}`);
  }

  // --- env ---
  const env: Record<string, string> = {
    [PI_SUBAGENT_CHILD_ENV]: "1",
    [PI_SUBAGENT_DEPTH_ENV]: String(opts.depth + 1),
    [PI_SUBAGENT_RUN_ID_ENV]: opts.runId,
  };
  if (opts.parentSessionId) env[PI_SUBAGENT_PARENT_SESSION_ENV] = opts.parentSessionId;

  return { args, env, tempDir };
}

export interface SpawnedChild {
  child: ChildProcess;
  pid: number;
  /** Signal the whole process group (children of the child too). */
  killGroup: (signal?: NodeJS.Signals) => boolean;
  /** One-shot temp dir holding prompt/task files; caller removes it. */
  tempDir?: string;
}

export function spawnChild(opts: ChildLaunchOptions): SpawnedChild {
  const { args, env, tempDir } = buildChildArgs(opts);
  const piCmd = resolvePiCommand();
  const child = spawn(piCmd.command, [...piCmd.args, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // new process group -> group kill + survives nothing else
    windowsHide: true,
  });

  return {
    child,
    pid: child.pid ?? 0,
    killGroup: (signal: NodeJS.Signals = "SIGTERM") => {
      if (!child.pid) return false;
      if (process.platform === "win32") {
        try {
          child.kill(signal);
          return true;
        } catch {
          return false;
        }
      }
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        try {
          child.kill(signal);
          return true;
        } catch {
          return false;
        }
      }
    },
    tempDir,
  };
}

export function removeTempDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
