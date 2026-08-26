/**
 * pi-answer — subagent answering mode.
 *
 * Each question is answered by a fresh `pi --mode json -p --no-session`
 * child process (full tool access, isolated context), one at a time. The
 * child inherits the parent's model and thinking level unless overridden.
 *
 * The `pi` binary is resolved with the same strategy used by the subagent
 * example / pi-subagents: explicit env override, a standalone `pi`
 * executable, the installed @earendil-works/pi-coding-agent CLI script, then
 * `pi` on PATH.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Question } from "./split.ts";
import { extractText } from "./util.ts";

const CHILD_TIMEOUT_MS = 600_000; // 10 minutes per question

function findPackageRoot(entryFile: string): string | undefined {
  let dir = dirname(entryFile);
  while (dir !== dirname(dir)) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
      } catch {
        // keep walking
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

interface PiCommand {
  command: string;
  args: string[];
}

/**
 * Resolve the pi binary/script to spawn children with.
 * Priority: PI_ANSWER_PI_BINARY env, standalone `pi` executable running us,
 * the installed @earendil-works/pi-coding-agent CLI script, then `pi` on PATH.
 */
export function resolvePiCommand(): PiCommand {
  const envBinary = process.env.PI_ANSWER_PI_BINARY?.trim();
  if (envBinary) return { command: envBinary, args: [] };

  const execPath = process.execPath;
  if (/^pi(?:\.exe)?$/i.test(basename(execPath))) {
    return { command: execPath, args: [] };
  }

  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const root = findPackageRoot(entry);
    if (root) {
      const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (bin) {
        const candidate = resolve(root, bin);
        if (existsSync(candidate)) return { command: execPath, args: [candidate] };
      }
    }
  } catch {
    // fall through
  }

  return { command: "pi", args: [] };
}

function buildPrompt(q: Question, preamble: string | undefined, cwd: string): string {
  const parts: string[] = [];
  parts.push(
    `Answer the question below for the project at ${cwd}. Use tools (read, bash, grep, etc.) to inspect the project if the question requires it.`,
  );
  parts.push("");
  if (preamble?.trim()) {
    parts.push(`Context from the parent conversation:\n${preamble.trim()}`);
    parts.push("");
  }
  if (q.proposed) {
    parts.push(
      `A suggested answer was proposed by the asker. Evaluate it and adopt, correct, or improve it as needed.`,
    );
    parts.push("");
    parts.push(`Suggested answer:\n${q.proposed}`);
    parts.push("");
  }
  parts.push(`Question (${q.label || "Q"}): ${q.text.trim()}`);
  parts.push("");
  parts.push(`Reply with only your final answer. Do not restate the question. Keep it concise.`);
  return parts.join("\n");
}

export interface ChildAnswerOptions {
  preamble?: string;
  cwd: string;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run one question through a fresh pi child; resolves with the final answer text. */
export async function answerWithChildPi(
  question: Question,
  opts: ChildAnswerOptions,
): Promise<string> {
  const { command, args: baseArgs } = resolvePiCommand();
  const args = [...baseArgs, "--mode", "json", "-p", "--no-session"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking && opts.thinking !== "off") args.push("--thinking", opts.thinking);
  args.push(buildPrompt(question, opts.preamble, opts.cwd));

  const timeoutMs = opts.timeoutMs ?? CHILD_TIMEOUT_MS;

  const debug = process.env.PI_ANSWER_DEBUG === "1";
  if (debug) {
    console.error(`[pi-answer debug] child for label=${question.label} question=${JSON.stringify(question.text)}`);
    console.error(`[pi-answer debug] command=${command} args=${JSON.stringify(args)}`);
  }

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const proc = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let buffer = "";
    let stderr = "";
    let lastAnswer: string | undefined;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      rejectPromise(new Error(`pi-answer child timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      proc.kill();
      rejectPromise(new Error("pi-answer interrupted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: unknown;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const event = ev as { type?: string; message?: { role?: string; content?: unknown } };
        if (event?.type === "message_end" && event.message?.role === "assistant") {
          const t = extractText(event.message.content).trim();
          if (t) lastAnswer = t;
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    proc.on("close", (code) => {
      finish();
      if (debug) console.error(`[pi-answer debug] child close code=${code} lastAnswer=${JSON.stringify(lastAnswer)} stderr=${JSON.stringify(stderr.slice(0, 300))}`);
      if (lastAnswer) {
        resolvePromise(lastAnswer);
      } else if (code === 0) {
        resolvePromise("(no response)");
      } else {
        rejectPromise(new Error(`pi-answer child exited with code ${code}: ${stderr.trim() || "no output"}`));
      }
    });

    proc.on("error", (err) => {
      finish();
      rejectPromise(err);
    });
  });
}

/** Answer each question sequentially, one at a time. */
export async function answerSequentially(
  questions: Question[],
  opts: ChildAnswerOptions & { onProgress?: (index: number, total: number) => void },
): Promise<string[]> {
  const answers: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    opts.onProgress?.(i + 1, questions.length);
    answers.push(await answerWithChildPi(questions[i], opts));
  }
  return answers;
}
