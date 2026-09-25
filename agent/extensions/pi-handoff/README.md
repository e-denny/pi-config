# pi-handoff

Hand a session's continuation context to a fresh, natively linked Pi session.

`/handoff` does not compact and it does not summarize for the model's benefit. It captures the truth the next session needs — authorization, current state, blockers, decisions, loaded skills, next action — writes that into a dossier, and starts a new session linked to the current one with the dossier as the first user message.

The design follows [pi-blitz-handoff](https://github.com/MircoBlitz/pi-blitz-handoff) by Mirco Blitz (MIT). This implementation is smaller: it drops the automatic context-threshold trigger, project-specific template selection, the config dialog, and the recovery-file store, while keeping the readiness protocol, the isolated writer turn, deferred prompts, and the native linked replacement.

## Requirements

- Pi's interactive surface
- A persisted source session (`--no-session` cannot start a handoff, because there is no transcript path to link)

## Commands

| Command | Effect |
|---|---|
| `/handoff [focus]` | Start a handoff. `focus` is optional emphasis passed to the writer. |
| `/handoff-cancel` | Cancel the active handoff before cutover. `/handoff cancel` works too. |
| `/handoff-status` | Report handoff phase and current context usage. |
| `/handoff-help` | Show the command list. |

`/handoff cancel`, `/handoff status`, and `/handoff help` are accepted as subcommand aliases.

## Model tools

| Tool | Purpose |
|---|---|
| `handoff_go` | The model accepts the handoff at a safe boundary, using the exact correlation key from the Call Template. |
| `handoff_go_with_user_deferral` | The model reports a live user interaction and asks you to choose Ready, Wait, or Cancel. |
| `submit_handoff` | Active only during the isolated writer turn. Submits the dossier exactly once. |
| `session_handoff` | `action=status` reports state; `action=start` requests a handoff only when you explicitly asked for one in that turn. |

## How a handoff runs

1. `/handoff` records the request and injects a Call Template as a custom message. The template tells the model to finish only in-flight work and then signal readiness. Starting a handoff ignores context thresholds; it is always explicit.
2. At the boundary the Call Template defines, the model calls `handoff_go`, or `handoff_go_with_user_deferral` when you appear to be in the middle of an interactive step. Deferral opens a Ready / Wait / Cancel dialog. Choosing Wait suspends the transfer until the model calls `handoff_go` later.
3. If no readiness tool is called within `readinessRetrySeconds`, one visible reminder re-applies the same instruction. There is no polling and no second reminder.
4. After GO, the extension defers user prompts instead of letting them reach the writer. They stay ordered in memory.
5. At the next idle boundary, the writer runs with exactly one active tool: `submit_handoff`. The writer turn cannot do source work. It writes the dossier from the current context and submits it.
6. The extension appends any deferred prompts to the dossier, then calls `ctx.newSession({ parentSession })` and sends the assembled Markdown as the first user message of the replacement. The source session stays on disk.
7. The active tool list is restored on success, cancellation, exhaustion, or failure.

While the transfer is active, `/new`, `/resume`, fork, and compaction are blocked so the source session cannot disappear mid-cutover. The extension's own replacement is allowed through once, by correlation token.

If replacement fails, the deferred prompts are returned to the current session as a user message rather than being lost.

## Configuration

Optional file: `~/.pi/agent/pi-handoff.json` (or `$PI_CODING_AGENT_DIR/pi-handoff.json`).

```json
{
  "readinessRetrySeconds": 180,
  "writerAttempts": 2,
  "writerRetryDelaySeconds": 2,
  "handoffTemplate": "handoff_default",
  "callTemplate": "call_default",
  "templateDirectory": null
}
```

- `readinessRetrySeconds`: delay before the single reminder. `0` disables it.
- `writerAttempts`: how many isolated writer turns to allow before abandoning.
- `writerRetryDelaySeconds`: delay between writer attempts.
- `handoffTemplate` / `callTemplate`: a built-in name, a bare filename, or a path. Built-ins are `handoff_default` and `call_default`.
- `templateDirectory`: extra directory searched first for `<name>.cmpl` overrides.

Invalid values fall back to the default and produce a startup warning rather than failing.

### Templates

The dossier structure lives in `handoff_default`. The Call Template that governs the readiness boundary lives in `call_default`. Both are embedded in `templates.ts`; put `.cmpl` files in `templateDirectory` (or name a path directly) to override them. The dossier template is re-read at each writer attempt, so you can edit it without restarting Pi.

To replace the built-in dossier, create `~/.pi/agent/pi-handoff/templates/handoff_default.cmpl` and set `"templateDirectory": "~/.pi/agent/pi-handoff/templates"` in the config. The specified directory is searched before the built-in, so a file with a built-in name overrides it. `~` is expanded.

## Attribution

Interface and protocol are derived from [pi-blitz-handoff](https://github.com/MircoBlitz/pi-blitz-handoff), MIT licensed. The default templates are adapted from that project's `handoff_default.cmpl` and `call_default.cmpl`.
