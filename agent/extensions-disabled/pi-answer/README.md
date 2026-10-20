# pi-answer

Split an LLM's batch of questions into single questions, answer them **one at a time**, and consolidate the answers into **one reply sent back to the LLM**.

An LLM reply often asks several questions at once ("1. What OS are you on? 2. Which editor? 3. How big is the repo?"). pi-answer splits that reply into individual questions, walks you through them one by one in a focused TUI flow, then sends the answers back to the LLM as a single consolidated user message.

## Install

```bash
# If you cloned this repo elsewhere, symlink it into the extension dir:
ln -sfn /path/to/pi-answer ~/.pi/agent/extensions/pi-answer
```

Then `/reload` in pi (or restart). The extension registers:

- `/answer` — interactive answering (you answer each question)
- `/answer-agent` — each question is answered by a fresh pi subprocess
- `--answer-auto` CLI flag — automatically start the flow when a reply contains 2+ questions

## Usage

After the LLM asks several questions, run:

```
/answer
```

The last assistant reply is split into questions. A flow UI walks you through them one at a time:

```
──────────────────────────────────────────────
 pi-answer — 4 questions, one at a time (1/4 answered)
 Q1 ✓ Q2 (D7) ○ Q3 (D14) ○ Q4 (D15) ○

 Q2 (D7)  (2/4)
 Length: 18 chapters at ~6k = ~105–110k words. Options: accept ~108k · trim to ~95k ...

 Proposal: Accept ~108k, with defence chapters (13–15) deliberately leaner (~4.5k) ...
 Prefilled — edit it or press Enter to adopt.

 Your answer:
 ╭─────────────────────────────────────────────╮
 │ Accept ~108k                                │
 ╰─────────────────────────────────────────────╯

 Enter = done (next) • Tab = next • Shift+Tab = back • Esc = cancel
──────────────────────────────────────────────
```

- **Enter** submits the current answer and advances (Shift+Enter for a newline — same as pi's own editor)
- **Tab / Shift+Tab** move between questions
- When the LLM included a **➡️ proposal**, the editor is prefilled with it — just press Enter to adopt
- The last tab summarizes everything; **Enter** sends the consolidated reply back to the LLM
- **Esc twice** cancels without sending

The consolidated reply is sent as a normal user message, so the LLM continues with your answers in context.

## Options

| Flag | Effect |
|------|--------|
| `--text "..."` | Split the given text instead of the last assistant reply |
| `--file path` | Split questions read from a file |
| `--agent` | Answer via subagents instead of interactively |
| `--verbose` | Include the full question text in the consolidated reply |
| `--review` | Put the consolidated reply in the editor for review instead of sending |

Example with your DeepSeek decision-format message:

```
/answer --text "❓ Q2 (D7) - Length: 18 chapters ...
➡️ Accept ~108k ..."
```

### Subagent mode

`/answer-agent` (or `--agent`) spawns a fresh `pi --mode json -p --no-session` process per question — full tool access, isolated context — answering **one at a time**, then consolidates and sends. The child inherits your model and thinking level. Set `PI_ANSWER_PI_BINARY` to override the pi binary used for children.

### Automatic mode

```
pi --answer-auto
```

Whenever an assistant reply contains 2+ questions, the flow starts automatically (TUI only). Handy if you always want batch questions walked through one at a time.

## What it splits

Detected in order, with a `➡️` (or `→`) line inside a block treated as the LLM's proposed answer (prefilled):

1. **Q-labels** — `Q1:`, `❓ Q2 (D7) - ...`, `Question 3 - ...` (bold/blockquoted OK). The first block may be *implicit* (unmarked text with a ➡️ proposal — the DeepSeek decision format).
2. **Numbered lists** — `1.` / `1)` items ending in `?`.
3. **Bullets** — `-` / `*` / `•` items ending in `?`.
4. **Prose** — sentences ending in `?`, only when 2+ are found (so ordinary conversation isn't hijacked).

Rhetorical noise ("Any questions?", "Does that make sense?") is filtered. A trailing note after the last question (e.g. "Terse answers fine — ...") is surfaced in the flow header. Dash/equals separator lines split blocks.

## How it's built

```
pi-answer/
├── index.ts            # Entry shim (pi labels the extension "pi-answer")
├── package.json
├── smoke-test.ts       # Pure-logic tests: bun smoke-test.ts
├── rpc-e2e.ts          # End-to-end test via RPC mode: bun rpc-e2e.ts
└── src/
    ├── index.ts        # Extension factory: /answer, /answer-agent, --answer-auto
    ├── split.ts        # Question detection/splitting
    ├── answer-flow.ts  # One-at-a-time TUI flow (Editor per question)
    ├── consolidate.ts  # Builds the single reply sent back to the LLM
    ├── agent-answer.ts # Subagent answering (child pi processes)
    └── util.ts         # Text extraction + arg parsing
```

## Notes & limitations

- Interactive flow requires TUI mode; use `/answer-agent` headlessly (works in TUI and RPC mode).
- Single-shot print mode (`pi -p`) can't show the follow-up turn after the reply is sent — pi's `sendUserMessage` is fire-and-forget and print mode tears the session down immediately (the official send-user-message example behaves the same). Use RPC or TUI mode for the full loop.
- Splitting is line-based; two questions on one line are treated as one item.
- Subagent mode runs questions sequentially (one at a time by design).
- Children time out after 10 minutes each; set `PI_ANSWER_DEBUG=1` to log child invocations.
