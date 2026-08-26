# Design

How pi-subagents works, and which ideas it takes from
[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)
(henceforth "the reference").

The goal was to keep the reference's architecture for the parts that matter —
delegation, configuration, observability — while dropping the parts that were
not needed (watchdog, missions, builtin agents, workflowScript, intercom,
worktrees, orca integration).

## The core loop

```
parent pi session
  │  user asks / LLM decides
  ▼
subagent tool (extension)             agents = markdown files with frontmatter
  │  resolve agent, build args
  ▼
child pi process:  pi --mode json -p  --system-prompt <agent-prompt>
  │                                     [--model m] [--tools a,b,c] [--fork <parent>]
  │                                     Task: <task>
  ▼
parent reads stdout JSONL events  ──►  final assistant output, usage,
                                        model, turn/tool counts, settled watermark
  ▼
result text + details  ──►  lifecycle artifacts (status.json, events.jsonl, …)
```

Key properties, all borrowed from the reference:

1. **The child is a real pi session, not a summarizer.** It runs with
   `--mode json -p`, its own system prompt, its own model, and its own tool
   allowlist. The parent only parses the JSONL event stream; it never
   reconstructs or rewrites what the child did.

2. **Agents are declarative.** An agent is a markdown file: YAML frontmatter
   (name, description, tools, model, thinking, context mode, timeouts) on top,
   system prompt below. No code per agent. Customizing a role means editing a
   file, and the same file is what the child receives as its prompt.

3. **Context is explicit.** `fresh` (default) starts the child with
   `--no-session`. `fork` branches the parent's current session file with
   `pi --fork <file>` — a real conversation fork that carries history, not an
   injected summary. The reference's `defaultSubagentContext` / agent
   `defaultContext` / explicit `context` precedence is preserved.

4. **Children are leaves.** By default children do not register the `subagent`
   tool at all (`PI_SUBAGENT_CHILD=1` skips tool registration in the extension
   factory, and `--no-extensions` means the extension is never loaded in a
   child unless an agent explicitly lists `extensions`). The reference's
   "child-safety boundary" becomes a structural property instead of a runtime
   check; `maxSubagentDepth` remains as a backstop for explicitly nested
   setups.

5. **Foreground and background share one executor.** `launchChild()` spawns,
   wires stdout/stderr, applies the deadline, and returns a completion
   promise. Foreground mode awaits it and streams activity through
   `onUpdate`; async mode returns immediately with a run id and the same
   completion path drives status updates, notifications, and the widget.

## Configuration layering

Borrowed from the reference's `config.json` + settings + env layering, reduced
to three levels:

```
built-in defaults  <  <extensionDir>/config.json  <  <cwd>/.pi/subagents.json  <  PI_SUBAGENT_* env
```

- Global defaults live in `config.json` next to the extension.
- Projects override with `.pi/subagents.json` (the analog of the reference's
  project settings keys), so each repo can pin models, timeouts, or artifact
  placement without touching user scope.
- Env vars (`PI_SUBAGENT_PI_BINARY`, `PI_SUBAGENT_MAX_DEPTH`,
  `PI_SUBAGENT_TASK_DELIVERY`) are honored per-process.

Configuration is validated with explicit errors (mirroring the reference's
`validateConfig`) instead of silently coercing bad values.

## Observability

The reference's most valuable idea: **machine-readable lifecycle artifacts as
the single source of truth**, plus events for companion extensions.

```
<artifactRoot>/<runId>/
  status.json    machine-readable state (the source of truth for UI)
  events.jsonl   append-only lifecycle + annotated child events
  output.log     raw child stdout tail (live)
  output.md      final assistant output
```

- `status.json` mirrors the reference's field set (runId, sessionId, mode,
  state, timings, model, tokens, cost, counts, artifact paths) so consumers
  read JSON instead of scraping terminal output.
- The extension publishes on `pi.events`: `subagent:async-started`,
  `subagent:async-complete`, `subagent:state-change` — the reference's event
  names, minus the control/result-intercom channels we do not need.
- The under-editor widget (`ctx.ui.setWidget`) shows active runs; the
  `subagent` status/stop actions and `/subagents*` commands are the textual
  fallback, exactly the reference's "ask naturally or use slash commands"
  split.
- Stale runs are marked `interrupted` on session start (a reload cannot see
  the previous process's children), and terminal artifacts are pruned by age —
  the reference's cleanup behavior, simplified.

## What was deliberately dropped

| Reference feature | Why dropped |
|---|---|
| Watchdog (adversarial change review, scope monitoring) | User requirement |
| Missions + schedules (durable records, timed runs) | User requirement |
| Builtin agents (scout/researcher/worker/reviewer/oracle/delegate) | User requirement — agents are user/project markdown files |
| workflowScript / runs.run / runs.all orchestration DSL | A single `parallel` action covers the common case; the DSL adds a JS sandbox for little benefit at this size |
| Intercom / contact_supervisor / steering (mid-run steer) | Requires a cross-process inbox + child extension; stop/status covers control for v1 |
| Worktrees, orca tabs | Environment-specific extras |
| External CLI / external-job runners | Only native pi children for now |

## Watching runs live: inline selection → herdr tab

Added back from the dropped list is a **Herdr integration** for live observation:

- **Shortcuts.** `Ctrl+Up` / `Ctrl+Down` are registered via `pi.registerShortcut` (the editor input path checks extension shortcuts first, and neither key is bound by pi or herdr by default). There is **no picker popup**: the first press paints a full-width `selectedBg` highlight on one row of the active-run widget above the prompt, and every further press moves the highlight one row at a time (Ctrl+Down starts at the top, Ctrl+Up at the bottom; plain Up/Down also move while selection is active). The widget re-renders through the themed `setWidget` factory form so the highlight survives the 5s live refresh without shifting off the run it points at. While selection is active, an invisible overlay (`ctx.ui.custom` + `overlay: true` whose component renders zero lines) owns the keyboard — extension shortcuts only fire from the editor input path, so Ctrl+Up/Ctrl+Down never double-fire. Enter resolves with the highlighted run id; Esc resolves `null`, the highlight clears, and focus returns to the prompt automatically (overlay disposal restores the editor).
- **Tab creation.** The handler shells out to the running herdr server with `pi.exec` (`spawn` with `shell: false` — no quoting hazards): `herdr tab create --label … --cwd <run cwd> --no-focus` followed by `herdr pane run <pane> node <viewer> <runDir>`. `--no-focus` is what "brings me back to the prompt": the tab appears in herdr's tab bar, but input stays in pi.
- **Viewer.** `scripts/subagent-view.mjs` is a dependency-free Node ESM script that tails the run's `output.log` and projects the child's `--mode json` JSONL into readable text — live assistant text, dimmed thinking blocks, annotated tool calls, and a `\r`-updated status footer (state · elapsed · tokens · model). It mirrors the parent's `readableChildLine` projection, plus thinking/tool rendering that the parent stream intentionally skips. It stays alive after settle so the pane doesn't drop the view; the user closes the tab (or ctrl+c) when done.

Key/conflict analysis (verified against pi's default `KEYBINDINGS` and herdr's `--default-config`): `ctrl+up`/`ctrl+down` are unbound in both. The closest neighbors are distinct keys/modifiers: `ctrl+pageUp`/`ctrl+pageDown` (editor page scroll), `ctrl+shift+up`/`ctrl+shift+down` (alt-screen prompt jump), `alt+up` (message dequeue), and herdr's prefix-based bindings plus the user's own `ctrl+h/j/k/l` custom commands. `matchesKey` compares exact modifier bits, so none of these can intercept `ctrl+up`/`ctrl+down`.

## File map

```
index.ts                root entry shim (re-exports src/index.ts so the extension
                        is labeled "pi-subagents" by pi, not "src")
src/index.ts            extension entry: tool, commands, session lifecycle, widget, bus events
src/config.ts           config layering + validation + resolvers
src/agents.ts           frontmatter parsing, agent discovery (user + project)
src/spawn.ts            pi binary resolution, child argv/env, process-group spawn/kill
src/child-protocol.ts   JSONL event projection (output, usage, counts, settle watermark)
src/runs.ts             run registry, launch/watch/finalize, foreground+async, stop, status
src/herdr.ts            herdr tab integration: create tab + launch the live viewer
src/subagent-picker.ts  invisible key-capture overlay for the inline run selection (the
                        widget above the prompt renders the highlight)
scripts/subagent-view.mjs
                        dependency-free Node viewer tailing output.log (JSONL → readable)
src/artifacts.ts        status.json / events.jsonl / output.log / output.md writers, stale scan, pruning
src/types.ts            shared types (AgentDef, RunStatus, RunEvent, RunResult)
```
