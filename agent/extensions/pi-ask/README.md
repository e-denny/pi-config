# pi-ask

Let the model ask you instead of guessing.

`pi-ask` gives pi one tool, **`ask_user_question`**. When the model needs something from you — an ambiguous requirement, a choice between two approaches, a constraint it cannot read from the repository — it asks through this tool instead of writing questions into the transcript. The questions arrive as a dialog at the bottom of your terminal: up to four of them, tabbed, each with authored options and a one-line consequence per option. You answer with the arrow keys; the model gets your choices back as structured data.

```
────────────────────────────────────────────────────────────────────────────
 □ Storage   □ Checks   Submit
 Storage  1/2
 Which storage backend should be used?
 ❯ 1. Redis
       Recommended: shared, fast, handles concurrent access — needs a
       Redis instance to run.
   2. Files
       No extra infrastructure, easy to inspect by hand — slower and
       awkward with multiple processes.
   Type something.
 ↑↓ move · Enter select · n note · Tab next question · Esc cancel
────────────────────────────────────────────────────────────────────────────
```

## Install

```bash
ln -sfn /path/to/pi-ask ~/.pi/agent/extensions/pi-ask
```

Then `/reload` (or restart pi). Nothing else to set up: the tool is live and the model sees it in its tool list.

Try the dialog without involving the model:

```
/ask
```

## What the model sends

```jsonc
{
  "questions": [
    {
      "question": "Which storage backend should the cache use?",   // full sentence, ends in ?
      "header": "Storage",                                        // ≤ 16 chars, the tab chip
      "options": [
        {
          "label": "In-process LRU",                             // 1-5 words, ≤ 60 chars
          "description": "No new service; dies with the process.", // what it means / costs
          "preview": "cache = LruCache(max=1000)"                // optional, rendered beside the list
        },
        { "label": "Redis", "description": "Shared across workers; adds a service." }
      ]
    },
    {
      "question": "Which checks should run before a commit?",
      "header": "Checks",
      "multiSelect": true,
      "options": [ /* 2-4 options */ ]
    }
  ]
}
```

1-4 questions per call, 2-4 options per question. Labels `Other`, `Type something.` and `Next` are reserved: the dialog appends its own rows.

## What you can do in the dialog

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move between rows (wraps) |
| `Enter` | Confirm the focused option, commit typed text, close a note, or activate a Submit-picker row |
| `Space` | Toggle a checkbox on a multi-select question; opens the text row when focused there |
| `Tab` / `Shift+Tab`, `→` / `←` | Next / previous tab (multi-question dialogs) |
| `n` | Attach a note to this answer — or, on the Submit tab, one note for the whole questionnaire |
| `Shift+Enter` | Newline inside typed text or a note |
| `Esc` | Decline the whole questionnaire |

Every question gets a **`Type something.`** row, so you are never forced into the model's options. On a multi-select question, checked options and typed text are submitted together; `Next` commits the answer.

A question that is left blank is reported to the model as blank — it is never invented. `Tab` to the **Submit** tab to review everything (and see which questions are still empty) before it goes back; submitting with blanks is allowed.

Preview: when an option carries a `preview`, it renders in a bordered box beside the option list on terminals at least 100 columns wide, and stacks underneath on narrower ones. Useful for ASCII mockups, snippets, config files, diagrams.

Collapse: `Ctrl+]` shrinks the dialog to one row when you want to read the transcript behind it; the same key brings it back with your answers intact.

## Configuration

Optional, read on every questionnaire, never written. `~/.config/pi-ask/config.json` (or `$XDG_CONFIG_HOME/pi-ask/config.json`):

```json
{ "collapseKey": "alt+o" }
```

`collapseKey` takes a pi key id (`alt+o`, `ctrl+]`, …) or `"off"`. On keyboard layouts where `]` sits on the shifted layer — Latin American layouts, for one — set a key you can actually type. A missing or malformed file falls back to the default; it never fails a question.

To change how eagerly or how strictly the model asks, edit the description, snippet and guidelines in `src/guidance.ts`; the schema in `src/schema.ts` sets the hard limits.

## What the model gets back

A sentence it can act on, plus structured `details`:

```
User has answered your questions: "Which storage backend should the cache use?"="Redis". "Which checks should run before a commit?"="Typecheck, Tests". You can now continue with the user's answers in mind.
```

- a chosen option's `preview` is echoed as `selected preview: …`
- a note becomes `user notes: …`, the Submit-tab note `global note: …`
- questions left blank are named in an `unanswered: …` segment and listed in `details.unanswered`
- declining returns the single string `User declined to answer questions`

Failures are written for the model as well: `no_questions`, `too_many_questions`, `empty_question`, `duplicate_question`, `empty_options`, `too_many_options`, `empty_option_label`, `reserved_label`, `duplicate_option_label`, `no_ui`, `no_custom_ui`, `internal_error`. Each says what to fix, and the tool call does not crash the turn.

## Hosts

- **Terminal (TUI):** the full dialog described above, plus one terminal BEL when it starts waiting.
- **RPC / ACP hosts** (VS Code pendant, Zed): pi cannot render a custom terminal component there, so the same questions walk through the host's native select and input dialogs, one question at a time. Notes are terminal-only and do not carry over.
- **JSON / print, or `--no-ui` runs:** the tool reports `no_ui` and the model is told to continue without asking.

## Layout

```
pi-ask/
├── index.ts               entry shim (pi labels the extension "pi-ask")
├── package.json
├── README.md
├── src/
│   ├── index.ts           factory: the tool, its renderers, the /ask demo
│   ├── guidance.ts        what the model reads: description, snippet, guidelines
│   ├── schema.ts          the parameter schema (plain JSON Schema)
│   ├── spec.ts            limits, normalization, validation, answer composition
│   ├── envelope.ts        the text handed back to the model
│   ├── render.ts          transcript rendering for the call and the result
│   ├── run.ts             validate → pick a host interaction → one tool result
│   ├── config.ts          ~/.config/pi-ask/config.json
│   ├── fallback.ts        the same questionnaire through host dialogs
│   └── ui/
│       ├── questionnaire.ts   the dialog: state, keys, layout
│       └── layout.ts          width-safe wrapping, windows, boxes, columns
└── test/
    ├── run.sh             symlinks pi's packages, runs the smoke test
    └── smoke-test.ts      28 checks: validation, envelope, answer shapes, keys, width
```

## Tests

```bash
./test/run.sh
```

The checks drive the real dialog component headlessly: selecting options, typing custom answers, toggling checkboxes, attaching notes, switching tabs, submitting with blanks, declining, collapsing, aborting via the signal, and asserting that every rendered line fits widths from 16 to 140 columns.

## Notes

- One questionnaire at a time: the tool runs sequentially, because the dialog owns the keyboard.
- The extension makes no model calls of its own and has no dependencies beyond pi.
- Written against pi's extension and TUI public APIs; the design follows the shape of `@juicesharp/rpiv-ask-user-question`, implemented independently.
