# Configuration

Three layers, lowest to highest priority:

1. Built-in defaults (listed below)
2. `<extensionDir>/config.json` — global, user-scoped
3. `<cwd>/.pi/subagents.json` — project-scoped, **wins on conflicts**
4. `PI_SUBAGENT_*` environment variables

Invalid values throw a visible error at load time (no silent coercion).

## `config.json`

```json
{
  "defaultModel": "deepseek-v4-flash",
  "defaultThinking": "low",
  "defaultContext": "fresh",
  "asyncByDefault": true,
  "timeoutMs": 1800000,
  "maxActiveAsyncRunsPerSession": 4,
  "maxSubagentDepth": 1,
  "artifactDir": "session",
  "taskDelivery": "auto",
  "stopAsyncOnShutdown": true,
  "retainTerminalMs": 21600000,
  "parallel": { "maxTasks": 8, "concurrency": 4 },
  "herdrCommand": "herdr"
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `defaultModel` | string | parent's model | Model for every agent that does not set its own (frontmatter `model` or per-call `model` win). |
| `defaultThinking` | string | — | Thinking level for agents without a `thinking` value; appended as `:level` to the model id. |
| `defaultContext` | `"fresh" \| "fork"` | `"fresh"` | Launch context when a call omits `context`. Explicit call values and agent `defaultContext` interact: explicit `context` wins over everything; global beats agent default. |
| `asyncByDefault` | boolean | `true` | Background execution when a call omits `async` and the agent has no `async` frontmatter. |
| `timeoutMs` | int (ms) | `1800000` (30 min) | Run deadline. Precedence: call `timeoutMs` → agent frontmatter `timeoutMs` → this → 30 min. On expiry the child's process group is SIGTERMed and the run is marked `timed-out`. |
| `maxActiveAsyncRunsPerSession` | int | `4` | Concurrent top-level async runs per session. New async launches fail with a clear message when at capacity. |
| `maxSubagentDepth` | int | `1` | Nesting backstop. Children are leaves by default (the extension does not load in children), so this only matters if you load the extension inside children explicitly. |
| `artifactDir` | `"session" \| "project" \| "temp"` | `"session"` | Where lifecycle artifacts live: `session` = `<parent session dir>/subagent-artifacts/` (falls back to temp for ephemeral sessions); `project` = `<cwd>/.pi/subagents/artifacts/`; `temp` = OS temp dir. |
| `taskDelivery` | `"auto" \| "file"` | `"auto"` | How the task reaches the child: inline argv, or `@file` for tasks longer than 8000 chars. `"file"` always uses a temp file (useful where EDR scans argv). |
| `stopAsyncOnShutdown` | boolean | `true` | Kill tracked children when the parent session shuts down. |
| `retainTerminalMs` | int (ms) | `21600000` (6 h) | Terminal run dirs older than this are pruned on startup. |
| `parallel.maxTasks` | int | `8` | Cap on fanout items per `parallel` call (items beyond the cap are dropped). |
| `parallel.concurrency` | int | `4` | Default children running at once; per-call `concurrency` wins. |
| `herdrCommand` | string | `"herdr"` | Binary (or path) used to open run viewer tabs. Only used by the Ctrl+Up / Ctrl+Down run selection; set to `""` to disable herdr integration (the selection then reports the run id instead). |

## Keyboard shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+Up` / `Ctrl+Down` | Select an active run to view in a herdr tab — no popup: the first press paints a background highlight on a row of the active-run widget above the prompt, and every further press moves the highlight one row up/down (plain Up/Down work too). Enter opens the selected run's live working view in a new **herdr** tab (unfocused — you stay in the prompt); Esc (or Ctrl+C) clears the highlight and returns to the prompt without opening anything. |

Only active runs are listed (the same rows the widget shows, refreshed live). The herdr tab runs `scripts/subagent-view.mjs`, which tails the run's `output.log` and renders the child's JSONL protocol as readable text — assistant output streams live, thinking blocks appear dimmed, tool calls are annotated, and a status footer ticks state · elapsed · tokens · model. Requires a running herdr server (`herdr status`) and `node` on PATH.

## Agent frontmatter reference

Agents are markdown files: YAML frontmatter on top, system prompt below.

```markdown
---
name: reviewer
description: Code review against the task
aliases: critic
tools: read, grep, bash
extensions: ./child-only-tools.ts
model: anthropic/claude-sonnet-4
thinking: medium
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
timeoutMs: 900000
async: false
---

Your system prompt goes here.
```

| Field | Meaning |
|-------|---------|
| `name` | Canonical runtime name. Required. |
| `aliases` | Comma-separated or block list of extra names that resolve to this agent. |
| `description` | Shown in `list` output; helps the parent pick the right agent. |
| `tools` | Strict child tool allowlist. Omitted = child gets pi's normal tools; empty (`tools:` with nothing) = `--no-tools`; listed = `--tools a,b,c`. Accepts comma-separated or block list. |
| `extensions` | Extension paths loaded in the child (`--extension`). `--no-extensions` is always passed first, so only these load. |
| `model` | Model for this agent. Bare ids are canonicalized to `provider/id` against the live registry before launch. |
| `thinking` | Thinking level; appended as `:level` (e.g. `deepseek/deepseek-v4-flash:low`) **only when the model is known to support reasoning**. Bare-id suffixing breaks pi's pattern match and can silently fall back to a foreign provider (which then fails auth), so bare ids are qualified first and non-reasoning models are never suffixed. |
| `systemPromptMode` | `replace` (default): the agent body becomes the child's system prompt (pi still injects tool snippets/guidelines). `append`: the body is appended to pi's base prompt. |
| `inheritProjectContext` | Default `true`: keep AGENTS.md / CLAUDE.md discovery in the child (`false` → `--no-context-files`). |
| `inheritSkills` | Default `false`: keep skill discovery in the child (`true` → skills enabled). |
| `defaultContext` | `fresh` or `fork` preference when a call omits `context`. Global `defaultContext` wins over this; explicit call `context` wins over both. |
| `timeoutMs` | Per-agent run deadline; beats the global default, loses to the call value. |
| `async` | Default background execution for this agent when a call omits `async`. |

## Discovery locations

| Scope | Path | Priority |
|-------|------|----------|
| User | `~/.pi/agent/agents/**/*.md` | low |
| Project | `<cwd>/.pi/agents/**/*.md` | high (wins name collisions) |

Nested subdirectories are searched recursively. `.chain.md` files are ignored.
There are no builtin agents — if `list` shows nothing, you have not defined any
yet, and that is the intended starting state.

## Context nuances

- **`fresh`** (default): child runs with `--no-session` — no history, nothing written to the parent session.
- **`fork`**: child runs with `--fork <parent-session-file>` — a real branched session carrying the parent's persisted history. Note the branch is taken from the session file **as persisted at launch time**: text the user said earlier in the *same* turn as the subagent call may not be included yet in print mode (entries are persisted continuously in interactive mode, so interactive forks carry more).

## Environment variables

| Variable | Effect |
|----------|--------|
| `PI_SUBAGENT_PI_BINARY` | Command used to launch child pi processes (wrappers: point at your `pi`/agent binary). |
| `PI_SUBAGENT_MAX_DEPTH` | Overrides `maxSubagentDepth` for the process. |
| `PI_SUBAGENT_TASK_DELIVERY` | `file` forces file-based task delivery (overrides `taskDelivery`). |
| `PI_SUBAGENT_CHILD` | Internal. Set to `1` in children; the extension skips tool registration when set, so children never get the `subagent` tool. Do not set manually. |
| `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_PARENT_SESSION` | Internal run/session plumbing for observability. |
