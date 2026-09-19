---
name: book-cleanup-markdown
description: >
  Clean up a book split across markdown files (one chapter per file, Mathpix
  or similar PDF-to-markdown output). The supervisor (you) loops over
  chapters; for each it launches three throwaway children: a chapter-
  orientator that splits the chapter into ~4000-word sections in a fixed work
  dir and audits its footnotes, a parallel wave of cleanup-markdown-editor
  subagents (stubs skipped) that clean each section in isolation and write
  report files, and a chapter-aggregator that merges, reviews seams, bullets
  a back-of-book Index when present, consolidates the chapter's footnotes
  into one block at the end of its file, and verifies with scripts. State
  lives in a .cleanup-work/progress.json so runs resume; then reflow-markdown
  runs on each reflowable chapter and a collector aggregates unresolved
  items. Children do all content work, keeping the supervisor's context
  small. No web/PDF lookups; fixes are best-guess from each file.
allowed-tools: Bash Read Write Edit Subagent
---

# Book Cleanup Markdown (Orientator → Editors → Aggregator Loop)

Given a folder whose `.md` files are the chapters/sections of one book, clean
every file and then reflow every file. Per chapter you run a three-child
pipeline that mirrors the cleanup-markdown skill's role split:

- **You are the supervisor/orchestrator only.** For each chapter, in order:
  launch one `chapter-orientator`, launch the section editors in parallel
  (skipping stubs), launch one `chapter-aggregator`, then move to the next
  chapter. You never read chapter bodies and never run cleanup passes
  yourself. Your per-chapter context cost is one short task text per child
  plus the terse digests they return. Throwaway children do all content
  work.
- **`chapter-orientator`** (`~/.pi/agent/agents/chapter-orientator.md`)
  splits one chapter with the cleanup-markdown splitter
  (`split-into-sections.py --target 4000`) into the chapter's fixed work dir,
  backs up the chapter, validates split boundaries, runs `footnote-audit.py`
  on the whole chapter, and writes `orientation.json` (per-section flags +
  footnote-audit summary). Read-only on the chapter.
- **`cleanup-markdown-editor`** (`~/.pi/agent/agents/cleanup-markdown-editor.md`)
  cleans ONE section file in isolation: page markers, LaTeX superscripts,
  footnote definitions moved to its bottom, split sentences, block quotes,
  blank lines, ampersands/percent/dollar escapes, Contents/Bibliography/Index
  lists, typos; then verifies itself with `verify-section.py` and writes its
  full report to `<section>.report.md`. One instance per section, launched in
  parallel. **Stub sections (heading-only) are skipped — no editor.**
- **`chapter-aggregator`** (`~/.pi/agent/agents/chapter-aggregator.md`)
  merges the cleaned sections back into the chapter file, reviews the seams,
  bullets a back-of-book Index when present, consolidates the chapter's
  footnotes into one block at the very end of its file (per-file, renumbered
  with the book chapter number when numbering restarts), verifies with
  `footnote-audit.py` + `verify-section.py`, writes `chapter-report.md`,
  tidies, and does a final read-through.
- **Persistent state** lives in a sibling work dir `<folder>.cleanup-work/`
  (chapter dirs `ch<NNN>/`, `progress.json`, `unresolved.md`). It survives
  interruption, makes resume cheap, and preserves the cleaned section files
  and reports (which is also how a damaged chapter can be rebuilt).
- **Underlying skills**: `cleanup-markdown` at
  `~/.pi/agent/skills/cleanup-markdown/` (split/merge, renumber, OCR, audit,
  and verify scripts) and `reflow-markdown` at
  `~/.pi/agent/skills/reflow-markdown/`.

There is no parent/children nesting: children are leaves with no `subagent`
tool, so the loop lives here, in the supervisor. Resolve all paths
absolutely when building tasks and commands.

## No External Research (Hard Constraint)

Never look anything up — no web search, no fetching/downloading the original
book or PDF, no image/OCR comparison, no reading any file outside the ones
each role is told to read. This applies to you and to every child you launch
(their own prompts repeat it). Choose the most plausible reading the text
supports for ambiguous fixes, and record uncertain fixes so the user can
check them later (Step 4.5).

## Step 1: Confirm the input and prepare

1. The user must give you a **folder** containing the book's markdown files.
   If they gave a file or nothing, ask for the folder. Files may be in the
   folder root or nested in subfolders (process them all in order).
2. The files are the book's chapters/sections. Any non-`.md` files or
   folders (`images/`, PDFs, `.bak`/backup files) are ignored.
3. Verify the agents exist: `subagent({ action: "list" })` must show
   `chapter-orientator`, `chapter-aggregator`, and `cleanup-markdown-editor`.
   If any is missing, stop and tell the user which file is missing under
   `~/.pi/agent/agents/` or that the subagents extension is not enabled.
4. If the cleanup-markdown or reflow-markdown skills are missing from
   `~/.pi/agent/skills/`, stop and tell the user (this skill depends on
   their scripts).
5. Make one pristine backup of the folder (never clobber an existing one):

```bash
cd <parent-of-folder>
[ -e <folder>.pristine.tar.gz ] || tar -czf <folder>.pristine.tar.gz <folder>
```

6. Set up the work dir (a **sibling** of the book folder, never inside it,
   so chapter inventories and user tools never pick up its `.md` files):

```bash
WORK="<parent-of-folder>/<folder>.cleanup-work"
mkdir -p "$WORK"
```

7. **Resume check.** If `$WORK/progress.json` exists, read it (metadata) and
   continue from where the previous run stopped instead of restarting:
   - `reflowed` chapters are done — skip them entirely.
   - `merged` chapters are cleaned but not reflowed — skip Step 3, reflow
     them in Step 4.
   - `oriented` chapters already have a split + orientation in
     `$WORK/ch<NNN>/` — do not launch the orientator again; go straight to
     the editor wave (3.3), telling each editor its section "may be
     partially cleaned" if the previous run died mid-wave.
   - `pending`/absent chapters run the full pipeline from 3.1.
   - `failed` chapters were abandoned after two failures — reflow them (skip
     Step 3) or re-run them from 3.1 at your discretion; say what you chose.

Do not read or analyse any chapter file now — the children do all content
work. Inventorying (Step 2) is metadata only.

## Step 2: Inventory the chapters (metadata only)

List the markdown files in book order (natural/version sort, subfolders
first or inline — consistent order is what matters):

```bash
find <folder> -type f -name '*.md' | sort -V
```

For each file compute its **chapter number**: the first run of digits in the
filename after any leading alphabetic prefix (e.g. `ch05_title.md` → 5,
`chapter-4-the-x.md` → 4, `07_notes.md` → 7); if the name has no digits, use
the file's 1-based position in the sorted list. The number is used only for
per-file footnote prefixes (`[^ch007-…]`) and work-dir names, so uniqueness
across the book is what matters — never leave two files with the same
number. Record each file's absolute path, zero-padded number (`NNN`), and a
short label (filename) — do **not** open the files to read titles.

If the folder contains no markdown files, stop and say so.

## Step 3: Per-chapter pipeline — orientator, then editors, then aggregator

For each chapter **in book order**, run the sub-steps below and wait for
each child before launching the next role — never overlap chapters. Keep
your own context lean: note only each child's one-line digest (see Step 5
for what to retain). After each chapter finishes (and after each reflow in
Step 4), rewrite `$WORK/progress.json` wholesale with a chapter entry:

```json
{"book": "<folder>", "workDir": "<WORK>", "updated": "<ISO time>",
 "chapters": [
   {"number": 1, "file": "01-introduction.md", "state": "reflowed",
    "sections": 5, "stubsSkipped": 1, "workDirName": "ch001",
    "footnoteScheme": "seq", "footnoteKeys": 19,
    "orphans": ["11"], "dangling": [], "unresolved": ["note..."]}
 ]}
```

`state` ∈ `pending | oriented | merged | reflowed | failed`. Keep the
entries short; `orphans`/`dangling`/`unresolved` come from the digests the
children return.

### 3.1 Orientator (blocking; skip when the chapter is already `oriented`)

```text
subagent({ action: "run", agent: "chapter-orientator", async: false, task: "..." })
```

Task shape:

```text
Orient one chapter file of a multi-chapter book for parallel cleanup.

Chapter file (read-only for you): {absolute path}
Chapter number (label only): {NNN}
Work dir (create it fresh; write manifest.json, orientation.json and
footnote-audit.json there): {WORK}/ch{NNN}
Book folder (context only — do not touch other files): {absolute path of folder}
Cleanup-markdown skill dir: /home/edgar/.pi/agent/skills/cleanup-markdown

Read your system prompt and follow it: rm -rf + mkdir the work dir, split
the chapter into ~4000-word sections (split-into-sections.py), back up the
chapter (cp -n <file> <file>.bak), review the split boundaries (re-split
with a different heading depth if needed), run footnote-audit.py --json, and
write orientation.json (per-section flags + footnote_audit summary). Reply
with your ≤12-line report (WORK path, section count, total words, heading
depth, re-split if any, non-plain section indices incl. index, stub
indices, footnote-audit summary, seam notes, backup confirmation).
NO LOOKUPS: never search the web, never look for or download the original
PDF/document, never read any file other than the chapter file, the skill
scripts, and your own $WORK files.
```

### 3.2 Read the plan (metadata only)

Read `$WORK/ch{NNN}/manifest.json` and `orientation.json`. This is
metadata — section files, word counts, original line ranges, first lines,
flags, and the footnote-audit summary. Do not read the section files or the
chapter. Build the editor task list from these two files: one task per
section in manifest order, **excluding sections whose `stub` flag is true**
(heading-only sections need no editor; record them as `stubsSkipped` and let
the merge include them unchanged).

### 3.3 Launch the section editors in parallel

For every non-stub section, build a task with this shape:

```text
Clean up section {i} of {total} of chapter {NNN} "{basename}".
Section file (edit ONLY this file, in place): {absolute section file path}
Report file (write your full report here): {same path}.report.md
Helper scripts: /home/edgar/.pi/agent/skills/cleanup-markdown/scripts
Context:
- Section starts with: "{first line}"
- Covers original lines {start_line}-{end_line} ({words} words)
- special: {flag from orientation.json: title / contents / notes /
  references / bibliography / index / plain}   stub: {true/false}
- Footnote audit: dup {…}, dangling {…}, orphans {…} (whole chapter, from
  orientation.json — informational)
Follow all passes in your instructions in order, finish with the
verify-section.py pass (report its verdict), write the report file
(## Counts, ## Dangling, ## Orphans, ## Unresolved / low-confidence,
## Seam notes), then reply with your ≤5-line digest (mechanical counts,
dangling/orphan keys, unresolved conflicts, seam notes, report path).
NO LOOKUPS: never search the web, never look for or download the original
PDF/document, never read any file other than your section file and the
helper scripts. Best-guess fixes only.
```

Launch all sections in parallel with one blocking call per wave:

```text
subagent(action="parallel", async=false, concurrency=4, parallel=[
  {key: "section-01", agent: "cleanup-markdown-editor", task: "..."},
  {key: "section-02", agent: "cleanup-markdown-editor", task: "..."},
  ...
])
```

- The tool caps one call at 8 items: if there are more sections, launch
  waves of up to 8 and wait for each wave to finish before launching the
  next (`async: false` every time — never background them).
- After a wave, check that every key completed. For any section that failed
  or timed out mid-edit, launch a fresh editor on that section file as it
  currently stands (the scripts are idempotent and the editor re-checks the
  current state), telling it the section may be partially cleaned and to
  finish it. Optionally sanity-check the retried section yourself with
  `verify-section.py` afterwards (read-only, prints only residue).
- Keep a one-line digest per section in your running log; do not carry or
  quote the full reports — they live in `$WORK/ch{NNN}/section-*.report.md`
  and the aggregator reads them.

### 3.4 Aggregator (blocking)

```text
subagent({ action: "run", agent: "chapter-aggregator", async: false, task: "..." })
```

Task shape:

```text
Aggregate one cleaned chapter file of a multi-chapter book.

Chapter file (merge writes into it, edit in place): {absolute path}
Chapter number (for footnote prefixes): {NNN}
Work dir: {WORK}/ch{NNN}
Book folder (context only — do not touch other files): {absolute path of folder}
Cleanup-markdown skill dir: /home/edgar/.pi/agent/skills/cleanup-markdown

Read your system prompt and follow it: read orientation.json and the
section-*.report.md files, merge the cleaned sections back into the chapter
file (split-into-sections.py merge), review every seam and fix residue,
bullet a back-of-book Index if present, consolidate and renumber this file's
footnotes into one block at the very end (mode seq if keys are unique, else
mode ch with chapter number {NNN}), verify with footnote-audit.py (no
dangling; orphans only if orphaned in the source) and verify-section.py
(verdict CLEAN), tidy, do a full read-through, write chapter-report.md
(## Summary, ## Unresolved, ## Backups), and reply with your ≤200-word
digest.
NO LOOKUPS: never search the web, never look for or download the original
PDF/document, never read any file other than the chapter file, the $WORK
files, and the skill scripts.
```

If the aggregator fails or times out, launch a fresh aggregator on the same
file — the merge re-runs safely from the cleaned section files, and the
renumber is deterministic from the current state.

### 3.5 Record and loop

Record a one-line outcome for the chapter (file, chapter number, sections
cleaned, stubs skipped, aggregator footnote scheme/keys, unresolved items or
failure) and update `$WORK/progress.json` (`merged`, or `failed` after two
failures at the same role — record the failure and move on; do not block the
book on one chapter). Start the next chapter at 3.1. Do not paste child
transcripts into your context.

## Step 4: Reflow each processed chapter in turn

When every chapter has been through Step 3 (or is already `merged` from a
previous run), load the reflow skill
(`/home/edgar/.pi/agent/skills/reflow-markdown/SKILL.md`) and run its script
on each chapter file **in the same order**, one after the other, skipping
`reflowed` and `failed` chapters (default width 100 unless the user
specified one):

```bash
python3 /home/edgar/.pi/agent/skills/reflow-markdown/scripts/reflow-markdown.py <file> [--width N]
```

- The reflow script never overwrites an existing `<file>.bak` (it writes
  `<file>.bak.1`, `.bak.2`, … instead), so the orientator's pristine backup
  stays intact — no manual restore step.
- Chapter files whose content is list-structured — bibliographies and
  bulleted indexes (each entry `- …`) — reflow safely as list items. Prose
  paragraphs, block quotes, and footnote blocks reflow as paragraphs. If a
  chapter somehow still has a flush-left dense index (no bullets), bullet
  it first (see the aggregator, Step 3.4) — reflow must never run on
  unbulleted index entries.
- Verify each as the skill instructs (`grep -n '.\{101,\}' <file>` for the
  default width — remaining hits should only be exempt structures or
  unbreakable tokens). Record per file the over-width/exempt/unbreakable
  counts the script prints. If a chapter failed cleanup in Step 3, skip
  reflowing it and say so. Update each file's `state` to `reflowed` in
  `$WORK/progress.json` as you go.

### 4.5 Collect unresolved items

When reflow is done, aggregate every editor/aggregator "unresolved" note and
any failed chapters into one file for the user:

```bash
python3 /home/edgar/.pi/agent/skills/book-cleanup-markdown/scripts/collect-unresolved.py "$WORK"
```

It writes `$WORK/unresolved.md` from the `section-*.report.md` /
`chapter-report.md` files and `progress.json` (orphans, dangling keys,
low-confidence fixes, failed chapters). Mention this file in your final
report.

## Step 5: Report

Keep it short — one to two lines per chapter plus a summary:

- Per chapter: filename, chapter number, orientator's section count, stubs
  skipped, editors cleaned (all sections or failures), aggregator outcome
  (merged, footnote scheme + final key count, dangling/orphan keys left, or
  failed).
- Footnote scheme confirmation: every chapter file ends with its own
  consolidated footnote block; numbering is per file.
- Where everything lives: `<folder>.pristine.tar.gz` (book-level pristine
  copy), per-file `<file>.bak` (made by the orientator before any edits,
  never clobbered), and the work dir `<folder>.cleanup-work/` (per-chapter
  `ch<NNN>/` with cleaned sections + reports, `progress.json`,
  `unresolved.md`).
- Anything left unresolved: point at `$WORK/unresolved.md` (orphaned or
  dangling footnote keys, low-confidence fixes, failed chapters).
