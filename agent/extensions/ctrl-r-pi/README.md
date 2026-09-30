# ctrl-r-pi

fzf-style reverse prompt search for [pi](https://pi.dev). Press `Ctrl-R`
(capital R, i.e. `Ctrl-Shift-R`) to open a popup listing recent prompts, type to
fuzzy-filter, and press Enter to put the selected prompt back in the editor.

## Behavior

- Remembers the last **400 unique** prompts submitted to pi.
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
extension) and slash commands are not recorded.

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
