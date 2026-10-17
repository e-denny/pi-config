# /annotate — review a Markdown file in Neovim, apply the notes in Pi

`/annotate notes.md` opens a [Herdr](https://herdr.dev) tab running Neovim with
the file under review on the left and its review sidecar `notes.comments.md` on
the right. You mark up the text; when you leave Neovim the tab closes and the
sidecar is handed to the agent as a message, so it can apply the feedback.

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

`<leader>` is your Neovim leader (space in LazyVim); keys are buffer-local, so
they do not leak into other files. The maps are configurable, see below.

Leaving Neovim with `:qa`, `:wq`, `<Space>Q`, or `:AnnotateDone` all end the
review. Unsaved edits to the reviewed file are written out before quitting.

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
working directory, or absolute; `~` is expanded).

## How it is wired

* `index.ts` — the Pi extension: registers `/annotate`, opens the Herdr tab,
  waits for Neovim to exit, closes the tab, and sends the sidecar as a user
  message.
* `nvim/lua/annotate/init.lua` — the Neovim plugin: layout, keymaps,
  highlighting, box rendering, sidecar bookkeeping.

The plugin is loaded with `nvim -c 'set rtp^=…/annotate/nvim' -c
'lua require("annotate").setup()'`, so nothing has to be installed into your
Neovim configuration, and the plugin is only active in sessions Pi started.

Waiting is done by polling Herdr's pane foreground process, so closing the tab
or quitting Neovim by any means is detected.

## Troubleshooting

* **A sidecar from an earlier review is still there** — `/annotate` reopens it
  with its annotations, so unfinished notes are not lost.
* **"no annotations in notes.md"** — the sidecar had no blocks; the scaffold file
  is removed again.
* **"the Neovim tab closed before I could read notes.md"** — the tab was closed
  while Neovim was still running; whatever the sidecar held at that point is
  kept on disk.
* **Nothing happens on `<Space>C`** — the mapping is buffer-local to the reviewed
  file, and only active in visual mode for comments. Check `:verbose xmap <Space>C`.
* **Boxes look ragged** — notes wrap to the box as you type, and a line that is
  already too long when the sidecar is opened or the pane is resized is
  re-wrapped on the next redraw (`autoformat = false` disables the re-wrapping;
  a single unbreakable token longer than the panel can still cross the border).
* **Neovim asks about a swap file for the sidecar** — it should not: the sidecar
  buffer is opened with `swapfile=off`. A stale swap for the *reviewed* file
  behaves as normal Neovim.
