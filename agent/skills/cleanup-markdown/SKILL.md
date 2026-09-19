---
name: cleanup-markdown
description: >
  Clean up markdown files produced by Mathpix (or similar PDF-to-markdown tools).
  The interactive agent acts as supervisor: it splits the file into roughly
  4000-word sections at paragraph/heading boundaries, launches parallel
  "cleanup-markdown-editor" subagents (one per section, each fixing footnotes,
  block quotes, split sentences, blank lines, page markers, LaTeX superscripts,
  ampersands, lists, bibliography, typos in isolation), merges the cleaned
  sections, then consolidates every footnote definition at the bottom of the
  merged document and renumbers per-chapter footnotes to [^chNNN-MMM].
  Use when the user says "clean up this markdown", "fix the footnotes",
  "this was converted from PDF", "add blank lines between paragraphs", or opens a
  Mathpix-generated .md file for cleanup.
  Never performs web, PDF, or any other lookups — all fixes are best-guess
  from the file being cleaned.
allowed-tools: Bash Read Write Edit Subagent
---

# Cleanup Markdown (Parallel Subagent Workflow)

Fix common artifacts in PDF-to-markdown output (Mathpix, Adobe, etc.):
paragraphs not separated by blank lines, LaTeX footnote superscripts left in
body text, footnote definitions embedded in the body instead of at the end,
footnote definitions not in markdown format, block quotes missing the `>`
prefix, and bibliography/references entries not formatted as a bulleted list.

The work is split across roles:

- **You are the supervisor.** You split the file into sections, dispatch
  editor subagents in parallel, merge their output, consolidate footnotes
  document-wide, and report. The cleanup *steps* themselves are done by the
  editors, not by you — you do not fix body-text artifacts directly.
  Until the merge you inspect the document **only** to find clean split
  points (Steps 1-2). You never survey its content: no scanning for
  footnote formats or numbering regimes, no counting superscripts or page
  markers, no cataloguing of OCR typos, quote-like passages, or broken
  sentences. Every content judgement belongs to the editors (inside their
  own sections) or to you after the merge (seams, then footnotes).
- **`cleanup-markdown-editor`** is a subagent (defined in
  `~/.pi/agent/agents/cleanup-markdown-editor.md`). Each instance cleans one
  section file in isolation: it runs the cleanup scripts, fixes prose, moves
  every footnote definition in its section to the bottom of that section, and
  keeps the original footnote numbers. It never renumbers document-wide.
- **Helper scripts** live in the `scripts/` directory next to this SKILL.md
  (the skill directory; typically `~/.pi/agent/skills/cleanup-markdown`):
  - `split-into-sections.py` — split into ~4000-word sections / merge back
  - `renumber-footnotes.py` — consolidate + renumber footnote definitions
  - `remove-page-number-markers.py`, `convert-latex-footnotes.py`,
    `fix-ocr-typos.py` — run by the editors on their own section files
  - `footnote-audit.py` — report a file's defs/refs/dup/dangling/orphan keys
  - `verify-section.py` — deterministic residue audit (editors' final pass;
    the supervisor also runs it post-merge)

> Resolve paths absolutely: let `SKILL` be the directory containing this
> SKILL.md. Whenever you run a script, pass its absolute path.

## No External Research (Hard Constraint)

**Never look anything up.** Do not search for, download, or consult any other
copy of the document — no hunting for the original PDF on disk, no web
search, no fetching a digital edition, no image/OCR comparison. This applies
to you and to every editor subagent you launch:

- Do not use web_search, source_check, fetch_content, browser tools, or any
  other lookup/network tool.
- Do not make network requests of any kind (no curl, wget, python http
  calls) — even through Bash.
- Do not read any file other than the input markdown, the section files you
  created in `$WORK`, and the skill's own scripts.
- When a fix is uncertain (an ambiguous OCR typo, a possible block quote, a
  footnote whose text does not quite match its reference), choose the most
  plausible reading the surrounding text supports and note the uncertainty
  in your final report. Never "verify" against an external source.

## Supervisor Working Method

Do one step at a time and proceed immediately to the next without asking the
user for permission. Each step is fully described below.

## Step 1: Confirm the input and prepare

1. If the user has not given a path, ask. The file must be a `.md` file. If
   the filename contains non-ASCII characters (curly quotes, en-dashes,
   etc.), do all reading/writing of that file via `python3` through Bash —
   the Read/Write tools may reject such filenames.
2. Create a work directory: `WORK=$(mktemp -d /tmp/cleanup-md.XXXXXX)`.
3. Back up the original (never clobber an existing backup):
   `cp -n <file> <file>.bak`.
4. Verify the editor agent exists: `subagent({ action: "list" })` must show
   `cleanup-markdown-editor`. If it does not, stop and tell the user that
   the file `~/.pi/agent/agents/cleanup-markdown-editor.md` is missing or
   the subagents extension is not enabled.
5. **Do not analyse the document now.** No reading through the body, no
   greps for footnote markers, superscripts, headings, or page markers
   beyond what the splitter itself prints in Step 2. Go straight there.

## Step 2: Split into sections (~4000 words)

Run the splitter on the original file:

```bash
python3 $SKILL/scripts/split-into-sections.py split <file> --target 4000 --dir $WORK
```

Read the printed summary and the manifest (`$WORK/manifest.json`): every
section lists its file, word count, original line range, and first line.
This review is about **boundary quality only**, never about content. If a
spot-check happens to expose an OCR typo, a missing `>` prefix, an odd
superscript, or a broken sentence, leave it alone — the editor whose
section contains it will fix it.

Review before dispatching:
- Sections cut at sensible boundaries: chapters and headings start sections,
  long chapters split at sub-headings or paragraphs. A section should never
  straddle a chapter heading, split a paragraph, a block quote, a list, a
  table, or a fenced code block.
- If the always-cut heading depth was wrong for this document (e.g. chapter
  headings sit mid-section because the document mixes heading levels oddly),
  delete `$WORK` and re-run with an explicit depth:
  `python3 $SKILL/scripts/split-into-sections.py split <file> --dir $WORK --heading-depth <N>`.
- Spot-check two or three boundaries by reading the original file around the
  recorded `start_line`/`end_line` of adjacent sections — and read no
  further into the file than those lines.

If the whole file is small enough to produce a single section, that is fine —
a single editor cleans it.

## Step 3: Launch the editor subagents in parallel

For every section in the manifest, build a task with this shape:

```text
Clean up section {index} of {total} of the document "{basename}".
Section file (edit ONLY this file, in place): {absolute section file path}
Helper scripts: {absolute path to $SKILL/scripts}
Context:
- Section starts with: "{first line of the section}"
- Covers original lines {start_line}-{end_line} ({words} words)
- {Contains front matter / a Contents section / a Bibliography or References
  section: yes/no, from the manifest}
Follow all passes in your instructions in order, finish with the
verify-section.py pass (report its verdict), write your full report to
{section file}.report.md (## Counts, ## Dangling, ## Orphans, ## Unresolved /
low-confidence, ## Seam notes), then reply with your ≤5-line digest
(mechanical counts, dangling/orphan keys, unresolved conflicts, seam notes,
report path).
NO LOOKUPS: never search the web, never look for or download the original
PDF/document, never read any file other than your section file and the
helper scripts. Best-guess fixes only.
```

Sections that are only a heading (title stubs) need no editor — skip them
and note "stub — skipped" in the final report; the merge includes them
unchanged.

Launch all sections in parallel with a single blocking call:

```text
subagent(action="parallel", async=false, concurrency=4, parallel=[
  {key: "section-01", agent: "cleanup-markdown-editor", task: "..."},
  {key: "section-02", agent: "cleanup-markdown-editor", task: "..."},
  ...
])
```

- The tool caps one call at 8 items: if there are more sections, launch
  waves of up to 8 and wait for each wave to finish before launching the
  next (`async: false` every time — do not background them).
- After a wave, check that every key completed. For any section that failed
  or timed out mid-edit, launch a fresh editor on that section file as it
  currently stands (the scripts are idempotent and the editor re-checks the
  current state of the file), telling it the section may be partially
  cleaned and to finish it.
- Keep each editor's returned digest for your running log. Full reports
  live at `$WORK/section-NN.report.md` — read them at Step 5 and Step 7
  when you need per-section detail (dangling/orphan keys, unresolved
  conflicts, seam notes, low-confidence fixes).

## Step 4: Merge the cleaned sections

Merge back over the original file (the editors already worked on the split
files in `$WORK`):

```bash
python3 $SKILL/scripts/split-into-sections.py merge $WORK/manifest.json --out <file>
```

Read the merged file around a few seams: sections must be joined by a single
blank line, headings intact, no garbled boundary text.

## Step 5: Review the seams (residue pass)

Each seam is where one section ends and the next begins. Check each one:

- No sentence is split across the seam (should not happen — splits land at
  block boundaries).
- No duplicated or lost lines at the seam; no run of two or more blank lines
  (collapse any that remain to a single blank line).
- Footnote-definition blocks sitting between sections (editors moved them to
  the bottom of their sections) are expected here — **do not move them now**,
  Step 6 collects them all.
- Bibliography entries that use the same-author dash variant right after a
  seam, or any other residue the editors flagged in their reports, are fixed
  here with Edit (e.g. complete `- ———. 1997. Title…` using the author from
  the entry that precedes the seam).
- If an editor reported an **unresolved same-number conflict**, note it —
  it will need content matching in Step 6.

Do not perform any other content cleanup here; that is the editors' job.

## Step 6: Consolidate and renumber the footnotes (document-wide)

This is the supervisor's main cleanup task — and the first point at which
you read the document's content deliberately (Step 5 only touches the few
lines around seams). Work through it in order.

### 6a. Survey the footnote state

Read the merged file. Find every footnote definition (`[^N]: text`) and every
reference (`[^N]`). If there are none at all, skip the rest of Step 6 — the
document has no footnotes. Otherwise, definitions should already sit at the
seams between chapters (section bottoms). Check for leftovers the editors
missed and fix them with Edit:

- Bare numbered definitions in any Notes area still without a marker
  (`3 See Smith (1990)` → `[^3]: See Smith (1990)`), matching references in
  the same chapter by number.
- Definitions still embedded in the body mid-chapter → move them to their
  nearest section-bottom block.
- Formatting of the definition lines themselves (flush-left, one definition
  per line) — Step 6f normalises the final block, but fix obvious cases now.

### 6b. Identify the chapters

All line numbers below refer to the merged file you are processing. List
the headings (`grep -n '^#' <file>`). Decide which headings delimit
units whose footnotes restart at 1 — these are your chapters. Record for
each: the 1-based line of its heading and its number (`# 2. The State` → 2,
`# Chapter IV` → 4; convert word/roman numerals to digits; unnumbered
headings get their 1-based position among the chosen headings).

When the document puts all its notes at the end in one Notes block with
per-chapter groups (sub-headings or bold labels like "Notes to Chapter 3"),
include each group marker's line in your chapter list with the group's real
chapter number — the renumber script treats body references and end-block
definitions with the same number as one chapter.

### 6c. Decide the numbering scheme

- **Per-chapter / per-page numbering** (the same numeric key appears in two
  different chapters — e.g. `[^3]` used in chapter 1 and again in chapter 2 —
  or each chapter has its own Notes section): use `--mode ch`. The output
  keys become `[^chNNN-MMM]` (NNN = chapter number, MMM = the note's ordinal
  inside that chapter).
- **Continuous numbering** (every footnote number is unique across the whole
  document): use `--mode seq`. Keys stay as they are (gaps left by cleanup
  are compacted).

For a single-chapter document (e.g. a journal article) whose footnotes
restart per page, use `--mode seq`: the script reports the repeated keys as
collisions, and you resolve them by content matching (6e), numbering the
notes in order of first reference.

### 6d. Dry-run the renumber script, then run it

```bash
python3 $SKILL/scripts/renumber-footnotes.py <file> \
    --mode ch \
    --chapter-lines <comma-separated 1-based chapter heading lines> \
    --chapter-numbers <comma-separated chapter numbers> \
    --dry-run
```

Review the printed mapping and the supervisor checklist:
- every key maps to a plausible new key,
- every definition will pair with its references,
- no surprises in the "not auto-fixed" list.

If the mapping is right, re-run without `--dry-run`. If the mapping is off
(e.g. wrong chapter attribution), adjust the chapter lines/numbers and try
again, or fix by hand afterwards.

### 6e. Fix the residue the script reports

Read the script's "Remaining supervisor checklist" and the file itself, then
fix with Edit:

- **Same-number collisions** (two different definitions under one key, from
  per-page numbering): match each reference to its definition by content and
  proximity — the reference's surrounding prose should relate to the note's
  text — and give the later one a fresh number, updating its references and
  moving its definition into the final block under the new key.
- **Misattributed definitions** (definition text under one chapter's key
  that clearly belongs to another chapter, e.g. doc-end grouped notes whose
  group markers were not given as chapter lines): re-key the definition and
  its references to the right chapter by content.
- **Dangling references** (a reference with no definition anywhere): confirm
  they are genuinely lost in the source (rare); leave them and say so in the
  report.
- **Cross-references inside definition text** (a footnote that cites another
  note): re-key them to the new key of the note they point at.
- Re-run the script after manual fixes only if convenient; otherwise finish
  the remaining formatting by hand.

### 6f. Tidy the end of the document

- Delete now-empty Notes/Footnotes headings left mid-document by the move
  (a `## Notes` heading whose definitions were consolidated away). Keep at
  most one `## Notes`-style heading directly above the final block if the
  original document ended with one; otherwise leave the block plain.
- The consolidated block itself must be at the very end of the file: each
  `[^N]: text` on its own line, flush-left, one blank line between
  definitions, ordered by chapter and then number. The script does this —
  verify it and fix any stragglers.
- Collapse any leftover runs of two or more blank lines.

### 6g. Final footnote sanity check

Verify document-wide: every reference `[^N]` / `[^chNNN-MMM]` has exactly one
definition in the final block, and every definition is referenced at least
once (unreferenced definitions may remain if they were orphaned in the
source — that is acceptable; report them).

## Step 7: Final read-through

Read the whole merged file top-to-bottom (in chunks). Confirm: body prose
flows correctly, block quotes have their prefixes, chapter headings are in
place, the Contents/Bibliography sections read as bulleted lists, the
footnote block is at the end, and no cleanup artifacts remain.

Then verify mechanically (do not hand-re-grep what these report):

```bash
python3 $SKILL/scripts/footnote-audit.py <file>   # no dangling; orphans only if orphaned in the source
python3 $SKILL/scripts/verify-section.py <file>   # verdict CLEAN
```

Read the few lines the verify script flags, fix genuine artifacts with
Edit, and re-run until it prints `verdict: CLEAN` (or say what you
deliberately left and why).

## Step 8: Report

Summarise what was done, aggregating the editors' per-section report files
(`$WORK/section-NN.report.md`) plus your own work:

- How many sections were cleaned by how many editor subagents
- Per-section (or summed) counts: page-number markers removed, LaTeX
  superscripts converted, footnote definitions moved to the bottom,
  paragraph breaks inserted, block quotes added (first ~60 chars of each),
  Contents/Bibliography restructured, typos fixed (and what each was)
- Footnote numbering regime found and the final scheme applied
  (`[^chNNN-MMM]` per chapter, or continuous), how many definitions were
  consolidated at the end, deduplicated, or left for manual resolution
- Anything unresolved (conflicts, dangling references, orphans) and where
  the backup / work directory live (`<file>.bak`, `$WORK`)

## Common Mathpix Artifacts (Reference)

| Artifact | Example | Fix |
|----------|---------|-----|
| Footnote superscript | `${ }^{3}$` | `[^3]` (editor); supervisor renumbers later |
| Superscript in citation | `$(\mathrm{G}, 684 .)^{3}$` | `(G, 684.)[^3]` |
| Definition without colon | `[^3] Text here` | `[^3]: Text here` |
| Bare numbered definition | `3 See Smith (1990)` | `[^3]: See Smith (1990)` |
| Embedded footnote in body | `[^2]: text` mid-document | editor moves to section bottom |
| Split body sentence | line A … `[^N]:` … line B (lowercase) | merge A+B, move footnote |
| Bundled authors' note | `[^0]:    ${ }^{1}$ Affiliations...` | `[^auth]: Affiliations...` |
| Page-number marker (alone) | `[^42]` on its own line | delete (editor script) |
| Page-number marker (inline) | `[^42]Text continues` at line start | strip marker, keep text |
| Per-chapter footnote keys | `[^3]` in every chapter | `[^chNNN-MMM]` (supervisor) |
| Bibliography dash | `-.. 2011.` / `_. 2011.` / `—. 2011.` | `- ———. 2011.` |
| Bare-year bullet | `- 1997. Title...` | `- ———. 1997. Title...` |
| Escaped ampersand | `Capital \& Class` | `Capital & Class` |
| Escaped percent/dollar | `(\% of GDP)` / `\$2` | `%` / `$` (editor P7) |
| Index entries | dense flush-left lines, one entry per line | `- ` bullet each entry (editor P9b) |
| Inline math left-over | `$\mathrm{c}+\mathrm{v}$` | leave as-is (valid LaTeX) |
| Contents page fillers | `Chapter ..... 12` | strip `..... 12` |
| Running header artifact | `x Contents` mid-page | delete |
| Lettered list item | `(a) First point` | `- (a) First point` |
