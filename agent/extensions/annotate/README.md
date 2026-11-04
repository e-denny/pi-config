# /annotate — review a Markdown or Org file in Emacs, apply the notes in Pi

`/annotate notes.md` (or `notes.org`) opens the file in **your running Emacs
instance** on the left and its review sidecar `notes.comments.md`
(`notes.comments.org` for Org files) on the right. You mark up the text; when
you finish, the review closes, your previous window layout comes back, and the
sidecar is handed to the agent as a message, so it can apply the feedback.

```
┌ notes.md ─────────────────────┬ notes.comments.md ───────────────┐
│ # Design notes                │                                  │
│                               │                                  │
│ The quick brown fox …         │ ╭─ 3:1 → 3:19  comment ────────╮ │
│ have something to …           │ │ tighten this opening         │ │
│                               │ ╰──────────────────────────────╯ │
│ ## Second section             │                                  │
│ ~~want to remove …~~          │ ╭─ 9:1 → 9:59  delete ─────────╮ │
│                               │ │ > want to remove entirely…   │ │
│                               │ ╰──────────────────────────────╯ │
└───────────────────────────────┴──────────────────────────────────┘
```

## Use

| Step | Keys |
| --- | --- |
| Comment a region | select text in the reviewed file, `C-c C c` |
| Write the note | the cursor jumps into the new box — type, then `C-c C j` jumps back |
| Mark a region for deletion | select text, `C-c C d` (press it again on the same range to undo) |
| Jump to the box for the annotation under the cursor | `C-c C c` on already-annotated text, or `C-c C j` |
| Remove the annotation under the cursor | `C-c C k` |
| Redraw (re-read the anchors) | `C-c C g` |
| Finish the review | `C-c C q` |
| Abort the review | `C-c C x` — the agent is told `annotation aborted` |

The keys are buffer-local to the two review buffers, so nothing else in your
Emacs is touched. `pi-annotate-prefix-key` changes the `C-c C` prefix; the
letter keys stay the same.

`C-c C q`, killing either review buffer, or closing the review window all end
the review the same way: the sidecar is written and handed to Pi. `C-c C x`
ends it as *aborted* instead — the sidecar stays on disk for a later run and
the agent gets an `annotation aborted` message telling it to apply nothing.
Edits you made to the reviewed file are saved in either case.

## What you see

* **Commented spans** get a yellow background in the reviewed file.
* **Deleted spans** get strikethrough.
* **Each annotation is its own rounded box** in the sidecar, labelled with the
  start and end location of the span it refers to (`3:1 → 3:19  comment`).
* **Boxes line up with their text.** The sidecar is laid out on the same line
  numbers as the reviewed file (blank lines do the padding), and the two
  windows scroll together.
* **The box under the cursor** gets a brighter border and a stronger highlight,
  in either window.
* Notes wrap to the box as you type (`fill-column` is set per buffer), and
  overlong lines that arrive from elsewhere are re-wrapped on the next redraw.
  The sidecar is shown with truncated lines so the right border stays on the
  box edge; a single unbreakable token longer than the box can still cross it.
* The sidecar stays a plain Markdown/Org file on disk: the boxes, borders and
  highlights are Emacs overlays, not text.

## The sidecar format

`notes.comments.md` is plain Markdown, one block per annotation, padded so each
marker sits on the line it points at:

```markdown
<!-- annotate:source notes.md -->



<!-- annotate:#1 3:1-3:19 comment -->
tighten this opening
<!-- /annotate -->

<!-- annotate:#3 9:1-9:59 delete -->
> want to remove entirely, and one we may want to comment on.
<!-- /annotate -->
```

For an Org file the sidecar is `notes.comments.org` and the markers are Org
comments instead:

```org
# annotate:source notes.org

# annotate:#1 3:1-3:19 comment
tighten this opening
# /annotate
```

* the marker holds an id, the 1-based `start_line:col-end_line:col` span
  (`col` end is inclusive) and the kind (`comment` or `delete`);
* `comment` blocks hold your note;
* `delete` blocks quote the removed text with `> ` prefixes;
* anchors follow your edits in the reviewed file — Emacs markers move them, and
  the marker lines are rewritten as you go, so the boxes stay true;
* parsing accepts either comment style, so a sidecar written by an earlier run
  (or by the old Neovim plugin) still opens.

`/annotate` strips the padding and the source header before handing the file to
the model.

## Setup

The Emacs half is `pi-annotate.el`, which lives **in your Emacs configuration**
(`~/.emacs.d/lisp`), not in this extension. In `init.el`:

```elisp
(add-to-list 'load-path (expand-file-name "~/.emacs.d/lisp"))
(require 'pi-annotate)
```

Pi reaches that instance through `emacsclient`, so the Emacs server has to be
running — the same requirement as pi-subagents:

```elisp
(require 'server)
(unless (server-running-p)
  (server-start))
```

If the server is not up, `/annotate` says so (including that Pi is inside Emacs
when `INSIDE_EMACS` is set) instead of failing silently. It never starts a
separate Emacs or daemon, so the review always appears in the instance you are
running Pi in, ghostel/vterm terminals included.

Emacs-side settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `pi-annotate-prefix-key` | `"C-c C"` | Prefix for the annotate commands. |
| `pi-annotate-split-ratio` | `0.42` | Sidecar width as a share of the frame. |
| `pi-annotate-min-width` | `34` | Minimum sidecar width, in columns. |
| `pi-annotate-max-width` | `90` | Maximum sidecar width, in columns. |
| `pi-annotate-scroll-sync` | `t` | Scroll the reviewed file and the sidecar together. |
| `pi-annotate-autosave` | `t` | Write the sidecar as you annotate. |
| `pi-annotate-autoformat` | `t` | Wrap notes to the box width. |

The review takes the frame while it is open (reviewed file left, sidecar
right); your window layout is restored when it ends.

Pi-side configuration: none. `PI_ANNOTATE_EMACSCLIENT` overrides the
`emacsclient` binary, and `EMACS_SOCKET_NAME` picks a named server, as usual.

## How it is wired

* `index.ts` — the Pi extension: registers `/annotate`, resolves the target and
  its sidecar, calls `emacsclient --eval` with a form that runs
  `(pi-annotate-open FILE RESULT-FILE)`, waits for that result file to appear
  (polling the filesystem, so no process is spawned per tick), then reads the
  sidecar and sends it to the agent — or sends the abort message when the
  review was aborted, or nothing at all when there were no annotations.
* `pi-annotate.el` — the Emacs half: sidecar parsing, the two-window layout,
  box rendering with overlays, anchor tracking via Emacs markers, the key map,
  and the result file (`finished` / `aborted`) that tells Pi how it ended.

`/annotate` accepts `.md` and `.org` targets; anything else is refused. An
existing sidecar is reopened with its annotations, so an interrupted review
resumes instead of starting over.

## Troubleshooting

* **"no Emacs server reachable"** — the Emacs you are running Pi in has no
  server. `M-x server-start` (and the `init.el` snippet above so it starts with
  Emacs), then run `/annotate` again.
* **"the Emacs package `pi-annotate.el` is not loaded"** — `pi-annotate.el` is
  not on `load-path` or `init.el` does not `require` it. Put it in
  `~/.emacs.d/lisp` and add the require.
* **A sidecar from an earlier review is still there** — `/annotate` reopens it
  with its annotations, so unfinished notes are not lost.
* **"no annotations in notes.md"** — the review ended without any blocks; the
  scaffold sidecar is removed again.
* **The agent said the review was aborted** — you left with `C-c C x`, so
  nothing was applied. The sidecar is kept; `/annotate` the file again to resume
  from it.
* **"gave up waiting on Emacs"** — the wait ran out; the review is deliberately
  left open. Finish it there, then run `/annotate` again: the sidecar reopens
  with its annotations and they are applied.
* **Killing a review buffer mid-review** — that counts as finishing: the
  sidecar is still read, so the annotations already made are applied; if there
  were none, the scaffold is removed and nothing is sent.
* **A later box sits lower than its text** — a box that would overlap the one
  above it is pushed down instead (marker, note, end marker, blank line take
  four lines per annotation), the same trade the Neovim plugin made.
* **Nothing happens on `C-c C c`** — the command needs an active region; select
  some text first. The keys are buffer-local to the reviewed file and its
  sidecar.
