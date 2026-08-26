/**
 * pi-subagents — delegate work to focused child Pi processes.
 *
 * Design ideas borrowed from nicobailon/pi-subagents:
 *   - delegation pattern: agents as markdown files (frontmatter + prompt),
 *     children spawned as real `pi --mode json -p` sessions,
 *     fresh/fork context, leaf-only children
 *   - configuration: config.json beside the extension + project override
 *   - observability: per-run lifecycle artifacts (status.json, events.jsonl,
 *     output.log), pi.events bus, under-editor widget, status/stop actions
 *
 * Intentionally NOT included: watchdog, missions, builtin agents.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  discoverAgents,
  findAgent,
  formatAgentLine,
} from "./agents.ts";
import {
  type ExtensionConfig,
  getConfigPath,
  getProjectConfigPath,
  loadConfig,
  resolveArtifactRoot,
  resolveAsyncByDefault,
  resolveMaxActiveAsync,
  resolveMaxDepth,
  resolveParallelDefaults,
} from "./config.ts";
import { resolvePiCommand, PI_SUBAGENT_CHILD_ENV } from "./spawn.ts";
import {
  abandonRun,
  formatStatusLine,
  formatStatusText,
  getLiveUsage,
  getRunEvents,
  getStatus,
  launchAsync,
  listActiveStatus,
  listRecentStatus,
  runForeground,
  stopRun,
  stopAllChildren,
  SUBAGENT_STOP_REQUEST_EVENT,
  type LaunchSpec,
} from "./runs.ts";
import type { RunResult } from "./types.ts";
import { markStaleRunsInterrupted, pruneOldArtifacts } from "./artifacts.ts";
import { openRunInHerdrTab, resolveHerdrCommand } from "./herdr.ts";
import { InlineSelectionCatcher } from "./subagent-picker.ts";

export const WIDGET_KEY = "subagents";
export const ASYNC_STARTED_EVENT = "subagent:async-started";
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const STATE_CHANGE_EVENT = "subagent:state-change";
const MAX_OUTPUT_BYTES = 200 * 1024;
const MAX_OUTPUT_LINES = 5000;
/** How often the widget re-renders while runs are active (elapsed + tokens). */
const WIDGET_REFRESH_MS = 5000;
/** How many active runs the under-prompt widget lists (and inline selection can reach). */
const MAX_VISIBLE_RUNS = 6;
/** Mark the shared run-event emitter as bound so /reload does not double-subscribe. */
const BOUND_FLAG = Symbol.for("pi-subagents.runtime-listener-bound");

const Params = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Action to perform: "run" (default, when task+agent given), "parallel", "list", "get", "status", "stop", or "doctor".',
    }),
  ),
  agent: Type.Optional(Type.String({ description: "Agent name or alias to run." })),
  task: Type.Optional(Type.String({ description: "Task text for the subagent." })),
  parallel: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String({ description: "Stable result key for this child." }),
        agent: Type.String({ description: "Agent name or alias." }),
        task: Type.String({ description: "Task text." }),
        context: Type.Optional(Type.String({ description: '"fresh" or "fork".' })),
        model: Type.Optional(Type.String({ description: "Model override." })),
      }),
      { description: "Parallel fanout items for action=parallel." },
    ),
  ),
  concurrency: Type.Optional(
    Type.Number({ description: "Max children running at once (action=parallel)." }),
  ),
  context: Type.Optional(
    Type.String({ description: '"fresh" (default) or "fork" (branch the parent session).' }),
  ),
  model: Type.Optional(Type.String({ description: "Model override, e.g. anthropic/claude-sonnet-4." })),
  thinking: Type.Optional(
    Type.String({ description: "Thinking level: off|minimal|low|medium|high|xhigh|max." }),
  ),
  async: Type.Optional(
    Type.Boolean({ description: "Background execution (default: config.asyncByDefault)." }),
  ),
  timeoutMs: Type.Optional(Type.Number({ description: "Run deadline in milliseconds." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
  id: Type.Optional(Type.String({ description: "Run id for action=status/stop." })),
});

type SubagentParams = Static<typeof Params>;

/* ------------------------------------------------------------------ */
/* Session bind                                                        */
/* ------------------------------------------------------------------ */

interface SessionBind {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
}

function bindFromCtx(ctx: ExtensionContext): SessionBind {
  const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  return {
    sessionId,
    sessionFile,
    cwd: ctx.cwd,
  };
}

function sessionDirFromBind(bind: SessionBind): string | undefined {
  return bind.sessionFile ? dirname(bind.sessionFile) : undefined;
}

function dirname(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
}

function truncateOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    lines.length = MAX_OUTPUT_LINES;
    lines.push("… (truncated)");
  }
  let out = lines.join("\n");
  if (out.length > MAX_OUTPUT_BYTES) {
    out = out.slice(0, MAX_OUTPUT_BYTES) + "\n… (truncated)";
  }
  return out;
}

/**
 * Resolve a model id against the live registry.
 * Returns the canonical `provider/id` string plus whether the model supports
 * reasoning, or `undefined` for unknown models.
 */
function lookupModel(
  model: string,
  ctx: ExtensionContext,
): { qualified: string; reasoning: boolean } | undefined {
  try {
    const registry = ctx.modelRegistry;
    const slash = model.indexOf("/");
    if (slash > 0) {
      const provider = model.slice(0, slash);
      const id = model.slice(slash + 1);
      const found = registry.find(provider, id);
      return found
        ? { qualified: model, reasoning: Boolean((found as { reasoning?: boolean }).reasoning) }
        : undefined;
    }
    const matches = registry
      .getAvailable()
      .filter((m) => {
        const mid = (m as { id?: string }).id ?? "";
        return mid === model || mid.endsWith(`/${model}`);
      });
    if (matches.length === 0) return undefined;
    const currentProvider = ctx.model?.provider;
    const preferred =
      matches.find((m) => (m as { provider?: string }).provider === currentProvider) ??
      matches[0];
    const provider = (preferred as { provider?: string }).provider;
    const id = (preferred as { id?: string }).id ?? model;
    if (!provider) return undefined;
    return { qualified: `${provider}/${id}`, reasoning: Boolean((preferred as { reasoning?: boolean }).reasoning) };
  } catch {
    return undefined;
  }
}

/**
 * Produce the child `--model` argument. The thinking level is appended as a
 * `:level` suffix only when the resolved model is known to support reasoning.
 * Two rules keep suffixing safe:
 *   - bare ids get canonicalized to `provider/id` first; a bare id with a
 *     suffix fails pi's pattern match and silently falls back to a foreign
 *     provider (e.g. openrouter), which then fails auth;
 *   - unknown models pass through unsuffixed rather than gambling.
 */
function resolveModelArg(
  model: string | undefined,
  thinking: string | undefined,
  ctx: ExtensionContext,
): string | undefined {
  if (!model) return undefined;
  if (!thinking) return model;
  const resolved = lookupModel(model, ctx);
  if (!resolved) return model;
  if (resolved.reasoning && !resolved.qualified.includes(":")) {
    return `${resolved.qualified}:${thinking}`;
  }
  return resolved.qualified;
}

/* ------------------------------------------------------------------ */
/* Extension factory                                                   */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  const registryEvents = getRunEvents();

  // The run-event registry and its listeners deliberately survive session
  // replacement / reload (in-flight async runs keep tracking across sessions
  // in the same process), but pi re-imports extension modules fresh on every
  // replacement, so module-scope `latestCtx` in the ORIGINAL module goes stale
  // while its closures stay bound to the global registry emitter (BOUND_FLAG
  // prevents the new module from re-binding). Holding the latest ctx + pi API
  // on globalThis (Symbol.for = process-wide) lets those old closures always
  // read the CURRENT session's ctx instead of the invalidated one.
  const GLOBAL_LATEST_CTX = Symbol.for("pi-subagents.latest-ctx");
  const GLOBAL_LATEST_PI = Symbol.for("pi-subagents.latest-pi");
  const globalStore = globalThis as unknown as Record<symbol, unknown>;
  const latestCtx = (): ExtensionContext | undefined =>
    globalStore[GLOBAL_LATEST_CTX] as ExtensionContext | undefined;
  const setLatestCtx = (ctx: ExtensionContext): void => {
    globalStore[GLOBAL_LATEST_CTX] = ctx;
  };
  const latestPi = (): ExtensionAPI | undefined =>
    globalStore[GLOBAL_LATEST_PI] as ExtensionAPI | undefined;
  const setLatestPi = (api: ExtensionAPI): void => {
    globalStore[GLOBAL_LATEST_PI] = api;
  };

  /* --- child guard: children are leaves, they never get the subagent tool --- */
  if (process.env[PI_SUBAGENT_CHILD_ENV] === "1") {
    // Belt-and-braces: even if someone loads this extension in a child
    // explicitly, do not register delegation tooling there.
    return;
  }

  let widgetTimer: NodeJS.Timeout | undefined;

  // Inline selection state: while the user walks the active-run highlight in
  // the under-prompt widget (Ctrl+Up/Ctrl+Down), this holds the highlighted
  // run. `undefined` = no active selection (widget renders plain). Keyed by
  // runId rather than index so live widget refreshes keep the highlight on
  // the same run even if the list order/contents change.
  let selectionState: { runId: string } | undefined;

  const refreshWidget = (): void => {
    const ctx = latestCtx();
    if (!ctx) return;
    // This fires from the global registry emitter both inside tool execution
    // AND from child close handlers (finalizeRun) outside any tool promise.
    // A stale/disposed ctx (post session replacement / reload) or a missing
    // TUI must degrade to a log line, never an uncaughtException.
    try {
      const active = listActiveStatus();
      if (active.length === 0) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      const visible = active.slice(0, MAX_VISIBLE_RUNS);
      const selectedId = selectionState?.runId;
      // Render through the themed factory form so the selected run can get a
      // full-width `selectedBg` highlight directly in the widget above the
      // prompt — no picker popup.
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        const termWidth = tui.terminal?.columns ?? 80;
        // Keep the same visual layout as the old plain-string widget: every
        // line carries the Text(padX=1) leading space.
        const lines: string[] = [" subagents · " + active.length + " active"];
        for (const status of visible) {
          const text = "   " + formatStatusLine(status, getLiveUsage(status.runId));
          if (status.runId === selectedId) {
            // Full-width background highlight on the selected run.
            const pad = Math.max(0, termWidth - visibleWidth(text));
            lines.push(theme.bg("selectedBg", text + " ".repeat(pad)));
          } else {
            lines.push(text);
          }
        }
        return { render: () => lines, invalidate: () => {} };
      });
    } catch (error) {
      console.error("[subagents] widget refresh failed:", error);
    }
  };

  /**
   * Move the inline selection one step and re-render the widget. First press
   * anchors at the top (delta +1, Ctrl+Down) or bottom (delta -1, Ctrl+Up)
   * of the visible list; subsequent presses walk one row at a time. If the
   * previously selected run left the list, re-anchor at the nearest edge.
   */
  const selectRun = (delta: 1 | -1): void => {
    const active = listActiveStatus();
    const visible = active.slice(0, MAX_VISIBLE_RUNS);
    if (visible.length === 0) return;
    const current = selectionState;
    let idx = current
      ? visible.findIndex((s) => s.runId === current.runId)
      : -1;
    if (idx === -1) {
      idx = delta > 0 ? 0 : visible.length - 1;
    } else {
      idx = Math.min(Math.max(idx + delta, 0), visible.length - 1);
    }
    selectionState = { runId: visible[idx]!.runId };
    refreshWidget();
  };

  const notifyAsyncComplete = (result: RunResult): void => {
    const ctx = latestCtx();
    if (!ctx) return;
    // See refreshWidget: this fires from the global registry emitter outside
    // any tool promise, so a stale/disposed UI must not take pi down.
    try {
      const level = result.state === "completed" ? "info" : "error";
      const msg =
        result.state === "completed"
          ? `subagent ${result.agent} completed · ${result.totalTokens?.toLocaleString() ?? 0} tokens`
          : `subagent ${result.agent} ${result.state}${result.error ? `: ${result.error.slice(0, 200)}` : ""}`;
      ctx.ui.notify(msg, level);
      refreshWidget();
    } catch (error) {
      console.error("[subagents] completion notify failed:", error);
    }
  };

  /* --- lifecycle --- */
  pi.on("session_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setLatestPi(pi);
    const currentBind = bindFromCtx(ctx);
    const config = loadConfig(currentBind.cwd);
    const root = resolveArtifactRoot(config, currentBind.cwd, sessionDirFromBind(currentBind));
    const stale = markStaleRunsInterrupted(root);
    const pruned = pruneOldArtifacts(root, config.retainTerminalMs ?? 6 * 60 * 60 * 1000);
    if (stale > 0 || pruned > 0) {
      console.error(`[subagents] startup: ${stale} stale run(s) marked interrupted, ${pruned} artifact(s) pruned`);
    }

    // The registry emitter survives reloads (globalThis); bind its listeners
    // once so /reload does not stack duplicate handlers.
    if (!(registryEvents as unknown as Record<symbol, boolean>)[BOUND_FLAG]) {
      (registryEvents as unknown as Record<symbol, boolean>)[BOUND_FLAG] = true;
      registryEvents.on("state-change", refreshWidget);
      registryEvents.on("run-settled", (result: RunResult) => {
        // Bus events for companion extensions. Use the CURRENT session's pi
        // API: this listener may belong to a pre-replacement module instance
        // whose own event bus has been disposed.
        const api = latestPi() ?? pi;
        api.events.emit(STATE_CHANGE_EVENT, {
          runId: result.runId,
          agent: result.agent,
          state: result.state,
        });
        api.events.emit(ASYNC_COMPLETE_EVENT, {
          runId: result.runId,
          agent: result.agent,
          state: result.state,
          outputFile: result.outputFile,
          totalTokens: result.totalTokens,
          totalCost: result.totalCost,
          durationMs: result.durationMs,
        });
        refreshWidget();
        // Notify only async-mode completions; foreground results stream inline.
        const status = getStatus(result.runId);
        if (status?.mode === "async") notifyAsyncComplete(result);
      });
    }

    // Live widget: re-render every 5s while runs are active so elapsed time
    // and token counts tick even when no state change fires. The interval is
    // module-scoped and recreated per session_start, so /reload never stacks
    // duplicate timers (session_shutdown clears it before the next start).
    if (!widgetTimer) {
      widgetTimer = setInterval(() => {
        if (listActiveStatus().length > 0) refreshWidget();
      }, WIDGET_REFRESH_MS);
      widgetTimer.unref?.();
    }
  });

  pi.on("session_shutdown", async () => {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    const killed = stopAllChildren();
    if (killed > 0) console.error(`[subagents] killed ${killed} child run(s) on shutdown`);
  });

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  const agentListText = (cwd: string): string => {
    const agents = discoverAgents(cwd);
    if (agents.length === 0) {
      return (
        "No agents defined.\n" +
        "Create agent markdown files (YAML frontmatter + prompt) in:\n" +
        "  ~/.pi/agent/agents/          (user scope)\n" +
        "  <cwd>/.pi/agents/            (project scope, wins)\n" +
        "See docs/configuration.md for the frontmatter reference."
      );
    }
    return `Available agents (${agents.length}):\n${agents.map((agent) => `- ${formatAgentLine(agent)}`).join("\n")}`;
  };

  const launchSpec = (
    agentName: string,
    task: string,
    params: SubagentParams,
    ctx: ExtensionContext,
    cwdOverride: string | undefined,
  ): { spec?: LaunchSpec; error?: string } => {
    const cwd = cwdOverride ?? params.cwd ?? ctx.cwd;
    const config = loadConfig(cwd);
    const agent = findAgent(agentName, cwd);
    if (!agent) {
      return {
        error: `Unknown agent "${agentName}".\n${agentListText(cwd)}`,
      };
    }
    const currentBind = bindFromCtx(ctx);
    const effectiveModel = params.model ?? agent.model ?? config.defaultModel;
    const effectiveThinking = params.thinking ?? agent.thinking ?? config.defaultThinking;
    const spec: LaunchSpec = {
      runId: randomUUID(),
      agent,
      task,
      context: params.context === "fork" || params.context === "fresh" ? params.context : undefined,
      model: resolveModelArg(effectiveModel, effectiveThinking, ctx),
      timeoutMs: params.timeoutMs,
      cwd,
      async: false, // filled by caller
      sessionDir: sessionDirFromBind(currentBind),
      parentSessionFile: currentBind.sessionFile,
      parentSessionId: currentBind.sessionId,
      sessionId: currentBind.sessionId,
    };
    return { spec };
  };

  const resultDetails = (result: RunResult): Record<string, unknown> => ({
    runId: result.runId,
    agent: result.agent,
    state: result.state,
    outputFile: result.outputFile,
    model: result.model,
    totalTokens: result.totalTokens,
    totalCost: result.totalCost,
    turnCount: result.turnCount,
    toolCount: result.toolCount,
    durationMs: result.durationMs,
    error: result.error,
  });

  const textResult = (text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> => ({
    content: [{ type: "text", text }],
    details,
  });

  /* --- single run --- */

  /**
   * Convert one raw child stdout line (JSONL event in --mode json, or a stray
   * plain-text warning) into a human-readable progress fragment. Protocol-only
   * events (usage deltas, thinking/toolcall plumbing, turn markers) return
   * undefined and are skipped — never leak raw JSON into the TUI stream.
   */
  const readableChildLine = (line: string): string | undefined => {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    if (!trimmed.startsWith("{")) return trimmed.slice(0, 200);
    let evt: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return undefined; // truncated / malformed JSON line — never forward raw
    }
    if (evt.type === "message_update") {
      const delta = evt.assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta.trim()) {
        return delta.delta;
      }
      return undefined; // text_start/end, thinking_*, toolcall_* — not progress text
    }
    return undefined; // message_start/end, turn_start, tool_execution_start, agent_* …
  };

  const handleRun = async (
    params: SubagentParams,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    if (!params.agent || params.task === undefined) {
      return textResult(
        'subagent action "run" requires both "agent" and "task".\n' + agentListText(ctx.cwd),
      );
    }
    const { spec, error } = launchSpec(params.agent, params.task, params, ctx, undefined);
    if (error || !spec) return textResult(error ?? "no spec");

    const cwd = spec.cwd ?? ctx.cwd;
    const config = loadConfig(cwd);
    const async = params.async ?? spec.agent.async ?? resolveAsyncByDefault(config);

    if (async) {
      const active = listActiveStatus().length;
      const maxActive = resolveMaxActiveAsync(config);
      if (active >= maxActive) {
        return textResult(
          `Too many active async runs (${active} >= maxActiveAsyncRunsPerSession=${maxActive}).\n` +
            `Wait for some to finish or stop one with subagent({ action: "stop", id }).`,
        );
      }
      setLatestCtx(ctx);
      setLatestPi(pi);
      const receipt = launchAsync({ ...spec, async: true }, config);
      refreshWidget();
      pi.events.emit(ASYNC_STARTED_EVENT, {
        runId: receipt.runId,
        agent: receipt.agent,
        task: params.task.slice(0, 120),
        asyncDir: receipt.asyncDir,
      });
      return textResult(
        `Launched subagent ${receipt.agent} in the background (run ${receipt.runId.slice(0, 8)}).\n` +
          `Check it with subagent({ action: "status", id: "${receipt.runId}" }) or /subagents.\n` +
          `Artifacts: ${receipt.asyncDir}`,
        { ...receipt, async: true },
      );
    }

    // Foreground: stream progress, honor stop requests and abort.
    const runId = spec.runId!;
    const onStop = (stoppedId: string): void => {
      if (stoppedId === runId) stopRun(runId);
    };
    registryEvents.on(SUBAGENT_STOP_REQUEST_EVENT, onStop);
    const onAbort = (): void => abandonRun(runId);
    signal?.addEventListener("abort", onAbort, { once: true });

    let lastActivity = "";
    let lastUpdateAt = 0;
    const streamProgress = (line: string): void => {
      if (!onUpdate) return;
      const now = Date.now();
      if (now - lastUpdateAt < 250) return;
      lastUpdateAt = now;
      if (line === lastActivity) return;
      lastActivity = line;
      // Raw child stdout in --mode json is JSONL protocol events; convert to
      // readable assistant text so the TUI never shows raw JSON.
      const readable = readableChildLine(line);
      if (!readable) return;
      onUpdate({
        content: [{ type: "text", text: `subagent ${spec.agent.name} · ${readable}` }],
        details: { runId },
      });
    };

    try {
      const result = await runForeground({ ...spec, async: false }, config, streamProgress);
      const output = truncateOutput(result.output || "(no output)");
      const header = `${result.state === "completed" ? "✓" : "✗"} subagent ${result.agent} · ${result.state}` +
        ` · ${result.durationMs ? Math.round(result.durationMs / 1000) : "?"}s` +
        ` · ${result.totalTokens?.toLocaleString() ?? 0} tokens`;
      const errorNote = result.error ? `\n\nError: ${result.error}` : "";
      return textResult(`${header}\n\n${output}${errorNote}`, resultDetails(result));
    } finally {
      registryEvents.off(SUBAGENT_STOP_REQUEST_EVENT, onStop);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  /* --- parallel --- */

  const handleParallel = async (
    params: SubagentParams,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const items = params.parallel ?? [];
    if (items.length === 0) {
      return textResult('subagent action "parallel" requires "parallel": [{ key, agent, task }].');
    }
    const cwd = params.cwd ?? ctx.cwd;
    const config = loadConfig(cwd);
    const { maxTasks, concurrency: defaultConcurrency } = resolveParallelDefaults(config);
    const bounded = items.slice(0, maxTasks);
    const concurrency = Math.min(bounded.length, params.concurrency ?? defaultConcurrency);

    const results = new Array<RunResult>(bounded.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= bounded.length) return;
        const item = bounded[index]!;
        const agent = findAgent(item.agent, cwd);
        if (!agent) {
          results[index] = {
            runId: "none",
            agent: item.agent,
            state: "failed",
            output: "",
            error: `Unknown agent "${item.agent}"`,
          };
          continue;
        }
        const currentBind = bindFromCtx(ctx);
        const effectiveModel = item.model ?? agent.model ?? config.defaultModel;
        const effectiveThinking = agent.thinking ?? config.defaultThinking;
        const spec: LaunchSpec = {
          runId: randomUUID(),
          agent,
          task: item.task,
          context: item.context === "fork" || item.context === "fresh" ? item.context : undefined,
          model: resolveModelArg(effectiveModel, effectiveThinking, ctx),
          cwd,
          async: false,
          sessionDir: sessionDirFromBind(currentBind),
          parentSessionFile: currentBind.sessionFile,
          parentSessionId: currentBind.sessionId,
          sessionId: currentBind.sessionId,
        };
        results[index] = await runForeground(spec, config);
      }
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    const lines = results.map((result, index) => {
      const item = bounded[index]!;
      const mark = result.state === "completed" ? "✓" : "✗";
      const excerpt = truncateOutput(result.output).split("\n").slice(0, 6).join("\n");
      const errorNote = result.error ? `\n  error: ${result.error}` : "";
      return `${mark} ${item.key} · ${result.agent} · ${result.state} · ${result.durationMs ? Math.round(result.durationMs / 1000) : "?"}s\n${excerpt}${errorNote}`;
    });

    return textResult(
      `Parallel subagents (${results.length}):\n\n${lines.join("\n\n")}`,
      {
        results: results.map((result, index) => ({
          key: bounded[index]!.key,
          ...resultDetails(result),
        })),
      },
    );
  };

  /* --- actions --- */

  const handleList = (_params: SubagentParams, ctx: ExtensionContext): AgentToolResult<Record<string, unknown>> =>
    textResult(agentListText(paramsCwd(_params, ctx)));

  const handleGet = (params: SubagentParams, ctx: ExtensionContext): AgentToolResult<Record<string, unknown>> => {
    const cwd = paramsCwd(params, ctx);
    if (!params.agent) return textResult('action "get" requires "agent".');
    const agent = findAgent(params.agent, cwd);
    if (!agent) return textResult(`Unknown agent "${params.agent}".`);
    const frontmatter: string[] = [
      `name: ${agent.name}`,
      agent.description ? `description: ${agent.description}` : "",
      agent.aliases.length > 0 ? `aliases: ${agent.aliases.join(", ")}` : "",
      agent.model ? `model: ${agent.model}` : "",
      agent.thinking ? `thinking: ${agent.thinking}` : "",
      agent.tools ? `tools: ${agent.tools.join(", ")}` : "",
      agent.extensions ? `extensions: ${agent.extensions.join(", ")}` : "",
      `systemPromptMode: ${agent.systemPromptMode}`,
      `inheritProjectContext: ${agent.inheritProjectContext}`,
      `inheritSkills: ${agent.inheritSkills}`,
      agent.defaultContext ? `defaultContext: ${agent.defaultContext}` : "",
      agent.timeoutMs ? `timeoutMs: ${agent.timeoutMs}` : "",
      agent.async !== undefined ? `async: ${agent.async}` : "",
    ].filter(Boolean);
    return textResult(
      `Agent: ${agent.name} (${agent.scope} scope · ${agent.filePath})\n\n---\n${frontmatter.join("\n")}\n---\n\n${agent.body}`,
    );
  };

  const handleStatus = (params: SubagentParams, _ctx: ExtensionContext): AgentToolResult<Record<string, unknown>> => {
    if (params.id) {
      const status = getStatus(params.id);
      if (!status) return textResult(`No run found with id "${params.id}". Use /subagents to list recent runs.`);
      const text = [
        formatStatusLine(status),
        `  runId: ${status.runId}`,
        `  agent: ${status.agent}`,
        `  task: ${status.task.slice(0, 200)}`,
        `  started: ${status.startedAt}`,
        status.endedAt ? `  ended: ${status.endedAt}` : "",
        status.durationMs ? `  duration: ${Math.round(status.durationMs / 1000)}s` : "",
        status.model ? `  model: ${status.model}` : "",
        status.totalTokens !== undefined ? `  tokens: ${status.totalTokens.toLocaleString()}` : "",
        status.totalCost !== undefined ? `  cost: $${status.totalCost.toFixed(4)}` : "",
        status.turnCount !== undefined ? `  turns: ${status.turnCount}` : "",
        status.toolCount !== undefined ? `  tools: ${status.toolCount}` : "",
        status.outputFile ? `  output: ${status.outputFile}` : "",
        status.asyncDir ? `  artifacts: ${status.asyncDir}` : "",
        status.error ? `  error: ${status.error}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return textResult(text, { status });
    }
    return textResult(formatStatusText(listRecentStatus(20)));
  };

  const handleStop = (params: SubagentParams, _ctx: ExtensionContext): AgentToolResult<Record<string, unknown>> => {
    if (!params.id) {
      return textResult(
        'action "stop" requires "id". Get ids from subagent({ action: "status" }) or /subagents.',
      );
    }
    const ok = stopRun(params.id);
    return ok
      ? textResult(`Stop requested for run ${params.id.slice(0, 8)}.`)
      : textResult(`No active run found for "${params.id}".`);
  };

  const handleDoctor = (ctx: ExtensionContext): AgentToolResult<Record<string, unknown>> => {
    const cwd = paramsCwd({}, ctx);
    const config = loadConfig(cwd);
    const piCmd = resolvePiCommand();
    const bindInfo = bindFromCtx(ctx);
    const root = resolveArtifactRoot(config, cwd, sessionDirFromBind(bindInfo));
    const lines = [
      "subagents doctor",
      `  pi binary: ${piCmd.command}${piCmd.args.length > 0 ? ` ${piCmd.args.join(" ")}` : ""}`,
      `  global config: ${getConfigPath()}${existsSync(getConfigPath()) ? "" : " (missing — defaults)"}`,
      `  project config: ${getProjectConfigPath(cwd)}${existsSync(getProjectConfigPath(cwd)) ? "" : " (missing — defaults)"}`,
      `  config keys: ${Object.keys(config).join(", ") || "(defaults)"}`,
      `  default async: ${resolveAsyncByDefault(config)}`,
      `  max depth: ${resolveMaxDepth(config)}`,
      `  agents: ${discoverAgents(cwd).length} defined`,
      `  artifact root: ${root}`,
      `  active runs: ${listActiveStatus().length}`,
      `  parent session: ${bindInfo.sessionFile ?? "(ephemeral)"}`,
    ];
    return textResult(lines.join("\n"));
  };

  const paramsCwd = (params: SubagentParams, ctx: ExtensionContext): string =>
    params.cwd ?? ctx.cwd;

  /* ------------------------------------------------------------------ */
  /* Tool                                                                */
  /* ------------------------------------------------------------------ */

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a focused child Pi agent. Each child is an isolated pi session " +
      "with its own system prompt, model, tool allowlist, and fresh or forked context. " +
      "Use it for code review, research, scouting, implementation, parallel audits, and " +
      "anything that benefits from a second model. Foreground runs (async:false) block " +
      "and stream; async runs return a run id and keep working in the background. " +
      "Agents are markdown files in ~/.pi/agent/agents/ or .pi/agents/ (see action:list).",
    promptSnippet: "Delegate work to a focused child agent (review, research, implement, scout)",
    promptGuidelines: [
      "Use the subagent tool when the user asks for a second opinion, review, focused research, or independent implementation — especially when it would be slower or riskier to do inline.",
      "Prefer explicit agents (action run) for well-scoped tasks; describe the workflow naturally and let subagent orchestrate only when the user asks for parallelism or a pipeline.",
      "For parallel work use action parallel with stable keys; keep fanout bounded (maxTasks default 8).",
      "Use async:false when the parent must block on the result; otherwise runs default to background and can be checked with action status.",
    ],
    parameters: Params,
    async execute(_toolCallId, params: SubagentParams, signal, onUpdate, ctx) {
      const action = params.action ?? (params.parallel ? "parallel" : params.task !== undefined ? "run" : "list");
      setLatestCtx(ctx);
      setLatestPi(pi);
      switch (action) {
        case "run":
          return handleRun(
            params,
            ctx,
            signal,
            onUpdate as unknown as (update: unknown) => void,
          );
        case "parallel":
          return handleParallel(params, ctx);
        case "list":
          return handleList(params, ctx);
        case "get":
          return handleGet(params, ctx);
        case "status":
          return handleStatus(params, ctx);
        case "stop":
          return handleStop(params, ctx);
        case "doctor":
          return handleDoctor(ctx);
        default:
          return textResult(
            `Unknown subagent action "${action}". Valid actions: run, parallel, list, get, status, stop, doctor.`,
          );
      }
    },
  });

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  pi.registerCommand("subagents", {
    description: "Show subagent run status (active + recent)",
    handler: async (args, ctx) => {
      setLatestCtx(ctx);
      const status = handleStatus({ id: args?.trim() || undefined }, ctx);
      ctx.ui.notify(
        typeof status.content[0] === "object" && "text" in status.content[0]
          ? status.content[0].text
          : String(status.content[0]),
        "info",
      );
    },
  });

  pi.registerCommand("subagents-stop", {
    description: "Stop an active subagent run (/subagents-stop <run-id>)",
    handler: async (args, ctx) => {
      setLatestCtx(ctx);
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify("Usage: /subagents-stop <run-id>. List runs with /subagents.", "error");
        return;
      }
      const result = handleStop({ id }, ctx);
      const text = typeof result.content[0] === "object" && "text" in result.content[0]
        ? result.content[0].text
        : String(result.content[0]);
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("subagents-list", {
    description: "List defined subagents",
    handler: async (_args, ctx) => {
      setLatestCtx(ctx);
      const result = handleList({}, ctx);
      const text = typeof result.content[0] === "object" && "text" in result.content[0]
        ? result.content[0].text
        : String(result.content[0]);
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("subagents-doctor", {
    description: "Check subagents setup: binary, config, agents, artifact root",
    handler: async (_args, ctx) => {
      setLatestCtx(ctx);
      const result = handleDoctor(ctx);
      const text = typeof result.content[0] === "object" && "text" in result.content[0]
        ? result.content[0].text
        : String(result.content[0]);
      ctx.ui.notify(text, "info");
    },
  });

  /* ------------------------------------------------------------------ */
  /* Inline run selection (Ctrl+Up / Ctrl+Down → herdr tab)              */
  /* ------------------------------------------------------------------ */

  /**
   * Enter inline selection: highlight a run in the under-prompt widget
   * (no popup) and capture keys through an invisible overlay. Ctrl+Up /
   * Ctrl+Down (and plain Up/Down) walk the highlight one run at a time,
   * Enter opens the selected run's live view in a new herdr tab, Esc (or
   * Ctrl+C) clears the highlight and returns to the prompt. The first
   * press anchors at the top (delta +1, Ctrl+Down) or bottom (delta -1,
   * Ctrl+Up) of the list.
   */
  const selectRunAndOpenTab = async (ctx: ExtensionContext, delta: 1 | -1): Promise<void> => {
    try {
      if (listActiveStatus().length === 0) {
        ctx.ui.notify("No active subagent runs — launch one first (subagent tool or /subagents).", "info");
        return;
      }
      selectRun(delta); // paint the highlight in the widget
      const result = await ctx.ui.custom<"open" | null>(
        (_tui, _theme, _kb, done) =>
          new InlineSelectionCatcher({
            onMove: (d) => selectRun(d),
            onConfirm: () => done("open"),
            onCancel: () => done(null),
          }),
        {
          overlay: true,
          // The overlay is invisible (renders zero lines); it only captures
          // keys while the highlight lives in the widget above the prompt.
          overlayOptions: { anchor: "bottom-center", width: 1, maxHeight: 1 },
        },
      );
      const chosen = selectionState?.runId;
      selectionState = undefined;
      refreshWidget(); // clear the highlight
      if (result === null) return; // Esc / Ctrl+C — focus is back on the prompt

      if (!chosen) {
        ctx.ui.notify("Selected run is no longer tracked.", "warning");
        return;
      }
      const status = getStatus(chosen);
      if (!status) {
        ctx.ui.notify(`Run ${chosen.slice(0, 8)} is no longer tracked.`, "warning");
        return;
      }
      const config = loadConfig(ctx.cwd);
      if (!resolveHerdrCommand(config)) {
        ctx.ui.notify(
          `subagent ${status.agent} · run ${status.runId.slice(0, 8)} — herdr integration disabled (herdrCommand is empty)`, "info",
        );
        return;
      }
      try {
        const opened = await openRunInHerdrTab(pi, status, config);
        ctx.ui.notify(
          `subagent ${status.agent} · opened herdr tab ${opened.tabId} (${opened.label}) — switch to it to watch`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not open herdr tab: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    } catch (error) {
      selectionState = undefined;
      refreshWidget();
      ctx.ui.notify(`Subagent selection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.registerShortcut("ctrl+up", {
    description: "Select an active subagent run to view in a herdr tab (highlight moves up)",
    handler: (ctx) => {
      void selectRunAndOpenTab(ctx, -1);
    },
  });
  pi.registerShortcut("ctrl+down", {
    description: "Select an active subagent run to view in a herdr tab (highlight moves down)",
    handler: (ctx) => {
      void selectRunAndOpenTab(ctx, 1);
    },
  });

  // Expose internals for companion extensions.
  pi.events.on("subagent:stop", (runId: unknown) => {
    if (typeof runId === "string") stopRun(runId);
  });
}
