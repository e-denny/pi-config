# Observability

Everything a subagent run leaves behind, and every way to look at it.
The design rule (borrowed from the reference extension): **machine-readable
artifacts are the source of truth; UI and text output are projections of
them.** Consumers should read the JSON files, never scrape terminal output.

## Where things live

Runs write to an artifact root chosen by `artifactDir` (default `"session"`):

```text
<session dir>/subagent-artifacts/<runId>/
  status.json    machine-readable state (single source of truth)
  events.jsonl   append-only lifecycle + annotated child events
  output.log     raw child stdout (live tail)
  output.md      final assistant output (written at completion)
```

With `artifactDir: "project"` the root is `<cwd>/.pi/subagents/artifacts/`;
with `"temp"` it is the OS temp dir. Ephemeral sessions (no session file yet,
e.g. print mode) fall back to temp.

## `status.json`

Field set, mirroring the reference's status/result projection:

| Field | Meaning |
|-------|---------|
| `lifecycleArtifactVersion` | `1`. Bump-tolerant consumers ignore unknown fields. |
| `runId` / `sessionId` | Parent session identity + run identity. |
| `mode` | `"foreground"` or `"async"`. |
| `state` | `queued`, `running`, `completed`, `failed`, `stopped`, `timed-out`, `interrupted`. |
| `agent` / `task` | What was launched (task truncated to 2000 chars in status). |
| `cwd` / `pid` | Where the child ran and its process id. |
| `startedAt` / `lastUpdate` / `endedAt` / `durationMs` | Timing. |
| `asyncDir` / `sessionFile` / `outputFile` / `outputLog` | Artifact pointers. |
| `model` / `provider` | What the child actually used (read from child events). |
| `totalTokens` / `totalCost` / `turnCount` / `toolCount` | Aggregated usage. |
| `error` | Set for failed/stopped/timed-out/interrupted runs. |

## `events.jsonl`

Append-only, one JSON object per line:

- `subagent.run.started` — mode, context
- `subagent.run.completed` / `subagent.run.failed` / `subagent.run.stopped` / `subagent.run.timed-out` / `subagent.run.interrupted`
- `subagent.run.spawn-error` — child failed to spawn
- `subagent.stop.requested` — a stop was requested

Raw child pi events are not forwarded to the file (they are already in the
child's own session); `output.log` holds the raw stream for debugging.

## The widget

In TUI/RPC modes a persistent under-editor widget (`subagents`) shows active
runs:

```text
subagents · 2 active
  ● reviewer · running · 38s · ↓ 1.4k tokens
  ● scout · running · 1m 12s · ↓ 2.8k tokens
```

It updates on every state change and re-renders every 5 seconds while runs are
active (live elapsed time and token counts parsed from the child's output
stream), then clears when nothing is active. Disable it by removing the
handler or by not running a TUI; status actions still work.

## Watching a run live: Ctrl+Up / Ctrl+Down → herdr tab

With a herdr server running, `Ctrl+Up` / `Ctrl+Down` in the prompt walks a
background highlight through the active-run widget above the prompt — no
popup. The first press selects a row (Ctrl+Down starts at the top, Ctrl+Up at
the bottom) and every further press moves it one row; plain Up/Down work too
while selecting. Enter creates a new **unfocused** herdr tab (`--no-focus`)
running `scripts/subagent-view.mjs` against the selected run's artifact
dir — the same `output.log` the widget derives from, rendered as readable
text instead of JSONL: live assistant output, dimmed thinking blocks,
annotated tool calls, and a status footer ticking state · elapsed · tokens ·
model. Esc (or Ctrl+C) clears the highlight and returns to the prompt. See
docs/configuration.md (Keyboard shortcuts) for the key map and `herdrCommand`
config.

## Events on `pi.events`

Companion extensions can subscribe without parsing files:

- `subagent:async-started` — `{ runId, agent, task, asyncDir }` when a background run launches
- `subagent:async-complete` — `{ runId, agent, state, outputFile, totalTokens, totalCost, durationMs }`
- `subagent:state-change` — `{ runId, agent, state }` on every transition

In-process only (like all `pi.events`); cross-process consumers read the
artifact files instead.

## Asking the parent

The `subagent` tool doubles as the inspection surface:

```ts
subagent({ action: "status" })                              // recent runs
subagent({ action: "status", id: "<run-id>" })              // one run, full detail
subagent({ action: "stop", id: "<run-id>" })                // stop a run
subagent({ action: "list" })                                // defined agents
subagent({ action: "get", agent: "scout" })                 // agent definition
subagent({ action: "doctor" })                              // setup check
```

Slash-command equivalents: `/subagents [id]`, `/subagents-stop <id>`,
`/subagents-list`, `/subagents-doctor`.

## Lifecycle edge cases

- **Reload / restart.** If the parent restarts while children are running,
  those processes are gone (they are children of the parent). On `session_start`
  the extension marks any on-disk `running`/`queued` status as `interrupted`
  with `error: "Parent session restarted while this run was active."`
- **Shutdown.** `session_shutdown` SIGTERMs all tracked children
  (`stopAsyncOnShutdown` default `true`).
- **Stop.** `stop` SIGTERMs the child's process group (so `bash`-spawned
  grandchildren die too), escalates to SIGKILL after 5 s, and finalizes the
  run as `stopped` even if the child ignores signals.
- **Timeout.** The run deadline SIGTERMs the group and marks the run
  `timed-out`. Timeouts are not mutation-safe boundaries — prefer narrow tasks
  plus a generous `timeoutMs` for writers.
- **Pruning.** Terminal run dirs older than `retainTerminalMs` (default 6 h)
  are removed at startup.

## Example: tailing a run

```bash
ls <asyncDir>/status.json          # current state
tail -f <asyncDir>/output.log      # live child output
cat <asyncDir>/output.md           # final answer
```
