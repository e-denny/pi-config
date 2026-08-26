# pi-subagents

Delegate work to focused child Pi processes. Each subagent is an isolated `pi` session with its own system prompt, model, tool allowlist, and fresh or forked context. Run children in the foreground (streaming) or the background (async), fan out in parallel, and inspect everything through machine-readable lifecycle artifacts.

This is a from-scratch implementation **inspired by** [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents). It borrows three things from that project — the **delegation pattern**, the **configuration model**, and the **observability design** — and deliberately omits the pieces you said you did not need: the watchdog, missions/schedules, and the builtin agent roster. There are no builtin agents here; every agent is a markdown file you or your project define.

## Install

The extension is a directory extension. Either symlink it into pi's auto-discovery location:

```bash
ln -s ~/Projects/pi-subagents ~/.pi/agent/extensions/pi-subagents
```

or add it to `settings.json`:

```json
{
  "extensions": ["/home/edgar/Projects/pi-subagents"]
}
```

Then `pi install-scripts` if npm warned about scripts, restart pi, and run `/reload`. Verify with:

```text
/subagents-doctor
```

## Try it

Define an agent. Create `~/.pi/agent/agents/scout.md` (user scope) or `.pi/agents/scout.md` (project scope):

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
---

You are a scout. Inspect the codebase for the task and report the
relevant files, entry points, data flow, and risks. Be concrete;
name files and line ranges. Do not edit anything.
```

Then ask the parent agent in plain language:

```text
Use scout to map the auth flow before we plan.
```

or call the tool explicitly:

```text
subagent({ action: "run", agent: "scout", task: "Map the auth flow", async: false })
```

## Quick reference

| Want | Ask |
|------|-----|
| One child, blocking | `subagent({ action: "run", agent, task, async: false })` |
| Background child | `subagent({ action: "run", agent, task, async: true })` (default) |
| Parallel fanout | `subagent({ action: "parallel", parallel: [{ key, agent, task }] })` |
| Branch parent history | `context: "fork"` (default is `fresh`) |
| See agents | `subagent({ action: "list" })` or `/subagents-list` |
| See runs | `subagent({ action: "status" })` or `/subagents` |
| Watch a run live | `Ctrl+Up` / `Ctrl+Down` from the prompt → the highlight walks the active runs above the prompt → Enter opens a new **herdr** tab with a live readable view (Esc cancels) |
| Stop a run | `subagent({ action: "stop", id })` or `/subagents-stop <id>` |
| Check setup | `subagent({ action: "doctor" })` or `/subagents-doctor` |

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — the delegation pattern and how it maps to pi's extension API
- [docs/configuration.md](docs/configuration.md) — `config.json`, project overrides, agent frontmatter, environment variables
- [docs/observability.md](docs/observability.md) — lifecycle artifacts, events, widget, commands

## Design boundaries

- **Children are leaves.** A child pi process never gets the `subagent` tool (the extension skips registration when `PI_SUBAGENT_CHILD=1`), so you get bounded delegation by construction rather than by guardrails. The `maxSubagentDepth` config remains as a backstop if you later load the extension in children explicitly.
- **Children are real sessions.** `context: "fork"` branches the parent session file with `pi --fork <file>`, so the child carries the actual conversation, not a summary.
- **Nothing is in-memory-only.** Every run writes `status.json`, `events.jsonl`, `output.log`, and `output.md` under a run directory, so companion extensions and humans can observe without scraping terminal output.
- **Live watching (herdr).** `Ctrl+Up` / `Ctrl+Down` walks a highlight through the active-run widget above the prompt (no popup — the selected row gets a background highlight); Enter opens the selected run's live view in a new herdr tab (`scripts/subagent-view.mjs` tails `output.log` and renders the child's JSONL as readable text). Requires a running herdr server; disable with `herdrCommand: ""` in config.

## License

MIT. Attribution: design ideas from [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT).
