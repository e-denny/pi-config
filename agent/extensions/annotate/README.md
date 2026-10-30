# /annotate — review a Markdown file in Neovim, apply the notes in Pi

`/annotate notes.md` opens a [Herdr](https://herdr.dev) tab running Neovim
with the file under review on the left and its review sidecar
`notes.comments.md` on the right. You mark up the text; when you leave Neovim
the tab closes, focus returns to Pi, and the sidecar is handed to the agent as
a message, so it can apply the feedback.

```
┌ notes.md ───────────────┬ notes.comments.md ────────────┐
│ # Design notes          │                               │
│                         │                               │
│ The quick brown fox …   │ ╭─ 3:1 → 4:69  comment ──────╮ │
│ have something to …     │ │ tighten this opening       │ │
│                         │ ╰────────────────────────────╯ │
│ ## Second section       │                               │
│                         │ ╭─ 9:1 → 9:59  delete ───────╮ │
│ ~~want to remove …~~    │ │ > want to remove entirely… │ │
│                         │ ╰────────────────────────────╯ │
└─────────────────────────┴───────────────────────────────┘
```

## Use

| Step | Keys |
| --- | --- |
| Comment a selection | select text in the reviewed file, `<Space>C` |
| Write the note | the cursor jumps into the new box — type, then `<Space>C` jumps back |
| Mark a selection for deletion | select text, `<Space>D` (press it again on the same range to undo) |
| Jump to the box for the annotation under the cursor | `<Space>C` on already-annotated text |
| Remove the annotation under the cursor | `:AnnotateClear` |
| Finish the review | `<Space>Q` (or `:AnnotateDone`, or just quit Neovim) |
| Abort the review | `<Space>X` (or `:AnnotateAbort`) — the agent is told `annotation aborted` |

`<leader>` is your Neovim leader (space in LazyVim); keys are buffer-local, so
they do not leak into other files. The maps are configurable, see below.

Leaving Neovim with `:qa`, `:wq`, `<Space>Q`, or `:AnnotateDone` all end the
review. Unsaved edits to the reviewed file are written out before quitting.
`<Space>X` (or `:AnnotateAbort`) ends it as *aborted* instead: the sidecar stays
on disk for a later run, and the agent gets an `annotation aborted` message
telling it to apply nothing.

`/annotate` needs Pi to run inside Herdr: the review opens as a new tab of the
tabbed terminal Pi is in, and that tab is closed (with focus back on Pi) once
Neovim exits. Running it outside Herdr is refused (`$HERDR_ENV` is required).

## What you see

* **Commented spans** get a yellow background in the reviewed file.
* **Deleted spans** get strikethrough.
* **Each annotation is its own rounded box** in the sidecar, labelled with the
  start and end location of the span it refers to (`12:3 → 14:20  comment`).
* **Boxes line up with their text.** The sidecar is laid out on the same line
  numbers as the reviewed file (blank lines do the padding), and both windows
  share `scrollbind`, so they scroll together.
* The sidecar stays a plain Markdown file on disk: the boxes, borders and
  highlights are decorations drawn by the plugin, not text in the file.

## The sidecar format

`notes.comments.md` is plain Markdown. One block per annotation, padded so each
marker sits on the line it points at:

```markdown
<!-- annotate:source notes.md -->



<!-- annotate:#1 3:1-4:69 comment -->
tighten this opening
<!-- /annotate -->

<!-- annotate:#3 9:1-9:59 delete -->
> want to remove entirely, and one we may want to comment on.
<!-- /annotate -->
```

* the marker holds an id, the 1-based `start_line:col-end_line:col` span
  (`col` end is inclusive) and the kind (`comment` or `delete`);
* `comment` blocks hold your note;
* `delete` blocks quote the removed text;
* anchors follow your edits in the reviewed file, so the markers stay true and
  the boxes move with the text.

`/annotate` strips the blank padding before handing the file to the model.

## Configuration

Neovim side (`vim.g.annotate` before `require("annotate").setup()` runs, e.g. in
your own loader):

```lua
vim.g.annotate = {
  map_comment = "<leader>C",
  map_delete = "<leader>D",
  map_finish = "<leader>Q",
  map_abort = "<leader>X",
  width_ratio = 0.42,   -- sidecar width as a share of the window
  min_width = 34,
  max_width = 90,
  scroll_sync = true,
  autosave = true,      -- write the sidecar as you annotate
  autoformat = true,    -- wrap notes to the box width as you type; re-wrap any
                        -- overlong line the sidecar opens with (or after a resize)
  disable_completion = true, -- suppress completion popups (blink.cmp, nvim-cmp,
                        -- mini.completion) in the reviewed file and the sidecar;
                        -- buffer-local, other buffers are unaffected
}
```

Pi side: nothing to configure; the command takes the file path (relative to the
working directory, or absolute; `~` is expanded) and opens the Herdr tab
itself.

## How it is wired

* `index.ts` — the Pi extension: registers `/annotate`, opens a Herdr tab
  (`herdr tab create --cwd … --label … --focus`), runs Neovim in its root pane
  with `herdr pane run`, waits for that process to finish, closes the tab,
  focuses the tab Pi runs in, and sends the sidecar as a user message.
* The Neovim half is a separate plugin,
  [`e-denny/annotate.nvim`](https://github.com/e-denny/annotate.nvim), installed
  by lazy.nvim (layout, keymaps, highlighting, box rendering, sidecar
  bookkeeping).

The command loads the plugin from its lazy checkout with `nvim -c 'set
rtp^=<data>/nvim/lazy/annotate.nvim' -c 'lua require("annotate").setup()'`. The
checkout is resolved from `$XDG_DATA_HOME/nvim` (default `~/.local/share/nvim`),
so the plugin does not have to be added to your Neovim configuration, and it is
only active in sessions Pi started. If the plugin is missing, `/annotate` reports
that it needs to be added to your lazy.nvim config first.

The tab is labelled `annotate: <file>`. Waiting is done by polling that pane's
foreground process with `herdr pane process-info`, so quitting Neovim by any
means — `<Space>Q`, `:qa`, closing the tab — is detected. An abort is told
apart from a finish by a marker file: the extension passes its path in
`$ANNOTATE_ABORT_FILE`, and annotate.nvim writes it while aborting. When the
marker is there the sidecar is ignored and the agent receives an `annotation
aborted` message instead. Neovim is started with a
`VimLeavePre` autocmd that writes its `:messages` history to a temporary file
(path passed in `$ANNOTATE_LOG`): when the review ends without annotations,
Neovim's own error lines from that history are reported, so a failed start is
diagnosable instead of silent. Neovim's stderr is deliberately *not* redirected:
since 0.11 the TUI is a client that runs the editor as an `--embed` child, and
that child (the process plugins run in) dup2()s its stdin and stdout onto stderr,
so a redirected stderr leaves it with a regular file on fd 1 and breaks every
plugin that opens the terminal — Kitty-graphics images, image previews, math
overlays.

## Troubleshooting

* **A sidecar from an earlier review is still there** — `/annotate` reopens it
  with its annotations, so unfinished notes are not lost.
* **"no annotations in notes.md"** — the sidecar had no blocks; the scaffold file
  is removed again.
* **The agent said the review was aborted** — you left Neovim with
  `<Space>X`/`:AnnotateAbort`, so nothing was applied. The sidecar is kept;
  `/annotate` the file again to resume from it.
* **Closing the review tab mid-review** — the sidecar is still read, so
  annotations already made are applied; if there were none, the scaffold is
  removed and nothing is sent.
* **"no annotations in notes.md — Neovim reported: …"** — Neovim printed an
  error before exiting, usually a failed start (bad `rtp`, a broken plugin, a
  missing binary). The quoted line is Neovim's own message.
* **The review tab is still open after `/annotate` returned** — the wait ran
  out; the tab is deliberately left alone so the review is not lost. Finish
  there, then run `/annotate notes.md` again: the sidecar reopens with its
  annotations and they are applied.
* **Nothing happens on `<Space>C`** — the mapping is buffer-local to the reviewed
  file, and only active in visual mode for comments. Check `:verbose xmap <Space>C`.
* **Boxes look ragged** — notes wrap to the box as you type, and a line that is
  already too long when the sidecar is opened or the pane is resized is
  re-wrapped on the next redraw (`autoformat = false` disables the re-wrapping;
  a single unbreakable token longer than the panel can still cross the border).
* **Neovim asks about a swap file for the sidecar** — it should not: the sidecar
  buffer is opened with `swapfile=off`. A stale swap for the *reviewed* file
  behaves as normal Neovim.
