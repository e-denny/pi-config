# ctrl-r-pi

fzf-style reverse prompt search for [pi](https://pi.dev). Press `Ctrl-R`
(capital R, i.e. `Ctrl-Shift-R`) to open a popup listing recent prompts, type to
fuzzy-filter, and press Enter to put the selected prompt back in the editor.

## Behavior

- Remembers the last **400 unique** lines submitted to pi (prompts and slash
  commands alike).
- De-duplicates: resubmitting a prompt moves it to the top of the list.
- Persists across sessions in `~/.pi/agent/ctrl-r-pi-history.json`.
- Each list entry is collapsed to a single line and truncated to the popup width.
- The popup sits immediately on top of the prompt box: same width, the prompt box's
  own border colour, and the same rounded-corner/vertical-edge frame. It grows upward
  from the box as results narrow.
- At most **10 candidates** are listed at once; on a short terminal the popup shows only
  as many as fit above the prompt box. A `(n/m)` row appears while the list is scrolled.
- Typing fuzzy-matches against the full prompt text (best matches first) and
  removes non-matching entries from the list.
- `↑` / `↓` move the selection; `Enter` inserts the highlighted prompt in full
  (including all its original lines); `Esc` or `Ctrl-C` closes the popup.

Because the binding is `Ctrl-Shift-R`, your terminal must report the Shift
modifier distinctly (the Kitty keyboard protocol, or `modifyOtherKeys`). On a
terminal that cannot, the key arrives as a plain `Ctrl-R` byte, which does not
match this shortcut (pi's `Ctrl-R` belongs to the session picker). Switch on
Kitty/modifyOtherKeys support, or change the binding back to `Key.ctrl("r")` in
`index.ts`.

Extension-originated messages (for example `pi.sendUserMessage` from another
extension) are not recorded.

Slash commands **are** recorded, as long as pi knows them: skills
(`/skill:name`), prompt templates (`/tpl`), and registered extension commands
(`/annotate notes.md`, `/handoff`). Recalling one and pressing Enter runs it
again.

Built-in TUI commands (`/quit`, `/settings`, `/model`, `/resume`, ...) are **not**
recorded: they are pi's own interface, not prompts sent anywhere. pi's
`getCommands()` lists extension commands, prompt templates, and skills but no
built-ins, which is what separates the two. Free text that merely starts with
`/` and names nothing is a prompt for the model, and is still recorded (through
the `input` event).

Capturing commands takes two hooks, because no single pi event sees all of them:

| Hook | Sees |
|---|---|
| `input` event | plain prompts, skills, prompt templates, free text starting with `/` (interactive and RPC) |
| editor `onSubmit` | *every* submission from the prompt box, built-in commands included |

The editor hook decides what to keep: prompts, and commands pi knows. Built-ins
are dropped there, which is the only place they can be seen at all.

The editor hook wraps whatever editor is in use — including a custom one from
another extension (a vim editor, a reworked prompt box) — instead of replacing
it, so that editor keeps working and merely gets recorded through.

Only one editor component can be installed at a time, and a later extension
wins, so the wrapper is re-checked whenever it might have been displaced: just
after the other `session_start` handlers have run, on every key you type, and on
every input event. A keystroke matters because it arrives before the Enter that
submits it, so a command typed right after another extension claimed the editor
is still recorded.

A prompt submitted interactively is seen by both hooks; de-duplication makes the
second sighting a no-op, so the list and the file get one entry.

## Usage

1. `Ctrl-R` (capital R) anywhere in the editor.
2. Type part of a previous prompt.
3. `↑` / `↓` to choose, `Enter` to restore it to the input box.

## Notes

- Requires interactive (`tui`) mode. In other modes the shortcut reports that it
  needs interactive mode.
- `Ctrl-Shift-R` is not used by any built-in binding, so it does not override
  pi's picker-specific `Ctrl-R` ("Rename session") or produce a conflict
  diagnostic.

## Files

| File | Purpose |
|---|---|
| `index.ts` | The extension (prompt capture, persistence, popup UI) |
| `smoke-test.ts` | Headless checks for capture, de-duplication, and selection |
| `package.json` | Package metadata for `pi install` |
