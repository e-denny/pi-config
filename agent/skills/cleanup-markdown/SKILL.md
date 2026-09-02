---
name: cleanup-markdown
description: >
  Clean up markdown files produced by Mathpix (or similar PDF-to-markdown tools).
  Fixes LaTeX footnote superscripts to standard markdown footnotes, moves embedded
  footnote definitions to the end of the article, adds blank lines between paragraphs,
  converts References/Bibliography sections to bulleted lists (with same-author dash
  normalisation), fixes block quotes missing the ">" prefix, and fixes typos.
  Use when the user says "clean up this markdown", "fix the footnotes",
  "this was converted from PDF", "add blank lines between paragraphs", or opens a
  Mathpix-generated .md file for cleanup.
allowed-tools: Bash Read Write Edit
model: haiku
---

# Cleanup Markdown

Fix common artifacts in PDF-to-markdown output (Mathpix, Adobe, etc.). The main
problems are: paragraphs not separated by blank lines, LaTeX footnote superscripts
left in body text, footnote definitions embedded in the body instead of at the end,
footnote definitions not in markdown format, block quotes missing the `>` prefix, and
bibliography/references entries not formatted as a bulleted list.

## Working Method

**Do one step at a time.** Complete each numbered step fully before moving on to the
next. Each Edit saves immediately — there is no separate write step.

**Do not pause between steps.** After finishing a step, proceed immediately to the next one without asking the user for permission to continue.

**Read in small chunks.** Never read more than 60 lines at a time. Use `limit=60` and
advance the `offset` after each chunk. Fix any issue you find in a chunk before reading
the next one. Do not read ahead to collect a list of issues.

## Step 1: Get the File Path

If the user hasn't given a path, ask. The file must be a `.md` file. If the filename
contains non-ASCII characters (curly quotes, en-dashes, etc.), use Python via Bash to
read and write it — the Read/Write tools may reject such filenames.

## Step 2: Move Embedded Footnotes to End

Read the file from the top and scan for footnote definitions embedded in the body. A
body-embedded footnote looks like `[^N]: footnote text` appearing before the
Notes/Bibliography/References section.

Work top-to-bottom. When you find one:
- Use Edit to remove that `[^N]:` line from its current position and append it to the
  end of the document.
- If the line immediately before the footnote is a sentence fragment and the next
  non-blank line starts with a lowercase letter, it is the continuation of a split
  body sentence — join the two fragments into one line as part of the same edit.
- Then continue scanning from the same position for the next embedded footnote.

Do this manually, one footnote at a time. Do not scan the whole document first.
Do not write a script.

## Step 3: Join Split Sentences

Read the file from the top. Scan for sentences that have been broken across two lines
with a blank line between them — a PDF page-break artifact. The clearest signal is a
line that ends without closing punctuation (no `.`, `?`, `!`, `:`, or `"`) followed by
a blank line, followed by a continuation that starts with a lowercase letter.

When you find one, use Edit to remove the blank line and join the two fragments into a
single line. Fix it immediately, then continue scanning from the same position.

Do this manually, one at a time. Fix immediately when found — do not read ahead or
collect a list first. Do not write a script.

## Step 4: Fix Unformatted Block Quotes

Read the file from the top. Scan for quoted passages that are missing the `>` prefix.
Signals that a paragraph is a block quote:
- The preceding non-blank line ends with `:` or an attribution verb (`writes,`, `states,`,
  `notes,`, `argues,`, `observes,`)
- The paragraph starts with a lowercase letter (mid-sentence extraction: `[t]he idea...`)
- The paragraph starts with `[` (editorial insertion: `[Marx's] doubts were...`)
- The paragraph ends with a citation in brackets: `[Smith 1990, p. 42]`

When you find one, use Edit to prefix each line of the passage with `> `. Then continue
scanning from the same position for the next one.

Do this manually, one block quote at a time. Fix it immediately when you find it — do
not read ahead, collect a list, or scan the whole document first. Do not write a script.

## Step 5: Add Blank Lines Between Paragraphs

Read the body of the file from the top. Scan for consecutive non-blank lines that
should be separate paragraphs but have no blank line between them. Signals that two
adjacent lines are separate paragraphs rather than a continuation:
- The second line starts with a capital letter
- Neither line is a heading or list item
- Both lines are prose length (not a short label or caption)

When you find a pair, use Edit to insert a blank line between them, then continue
scanning.

Only do this within the main body text — not in front matter (title pages, Contents,
Acknowledgements) or back matter (Notes, Bibliography, Index), where dense line spacing
is intentional. Do not insert blank lines inside table rows.

Do this manually, one gap at a time. Do not write a script.

## Step 6: Remove Page-Number Markers

Run the removal script to strip `[^N]` / `[^N]:` tokens that the PDF converter
inserted as page-number markers. These appear either alone on a line or at the
very start of a line followed by text (with or without a space). The script
deletes the marker and, when text follows on the same line, preserves that text.

```bash
python3 scripts/remove-page-number-markers.py <file>
```

Note the count it reports — you'll include it in the Step 15 summary.

## Step 7: Fix LaTeX Footnote Superscripts

Now that page-number markers are gone it is safe to convert LaTeX footnote
superscripts. Run the conversion script:

```bash
python3 scripts/convert-latex-footnotes.py <file>
```

If the document has per-chapter footnote numbering (the Notes section has
sub-headings matching body chapters, so footnote numbers restart at 1 per
chapter), pass `--prefix chN` to make IDs unique document-wide:

```bash
python3 scripts/convert-latex-footnotes.py <file> --prefix ch1
```

The script handles:
- `${ }^{3}$` → `[^3]`
- `$(\mathrm{G}, 684 .)^{3}$` → `(G, 684.)[^3]`
- `[^0]: ${ }^{1}$ text` → `[^auth]: text` (and updates the body reference)
- Stray `[^0]` on its own line → deleted
- `[^N] text` (definition missing colon) → `[^N]: text`

After the script runs, scan the file and do a sanity check that each footnote
reference plausibly corresponds to its definition — mismatched numbering from
the PDF conversion is a real risk. Fix any mismatches manually with Edit.

Note the counts the script reports — include them in the Step 15 summary.

## Step 8: Fix Bare Footnote Definitions

Read the Notes section from the top. Scan for bare numbered footnote definitions —
lines like `3 See Smith (1990)...` that are missing the markdown marker. Convert each
one to `[^3]: See Smith (1990)...` using Edit as you find it. In the same pass, if you
find consecutive `[^...]:` lines with no blank line between them, insert a blank line
between them.

If footnotes are per-chapter (sub-headings in the Notes section match body chapters),
use chapter-prefixed IDs to match the references fixed in Step 7 — e.g. `[^ch1-3]`.

Do this manually, one definition at a time. Do not write a script.

## Step 9: Fix Escaped Ampersands

Read the file from the top. Scan for escaped ampersands (`\&`) and replace each one
with a plain `&` using Edit as you find it. Then continue scanning.

Do this manually, one at a time. Do not write a script.

## Step 10: Convert Contents Section to Bulleted List

If the document has a `## Contents` section, read through it and convert each entry to
a bulleted list using Edit. Top-level chapters get `- Chapter title`; sub-sections get
`  - N.M Sub-title` (two spaces of indent). Strip `..... N` page-number fillers — they
are PDF artifacts with no value in markdown. Remove any stray page-label artifacts
(e.g. `x Contents` that appeared as a running header in the PDF).

Do this manually, one entry at a time. Do not write a script.

## Step 11: Convert Bibliography / References to Bulleted List

If the document has a `## Bibliography`, `## References`, or `## REFERENCES` section,
read through it and convert each entry to a bullet using Edit. Watch for **same-author
dash variants** — PDF converters produce `-..`, `-.`, `—.`, `_.`, or a bare `- YYYY`
(bullet followed directly by a year, no author) for repeated-author entries. Normalise
all of these to `- ———. YYYY…` (three em-dashes, the standard bibliographic notation
for "same author as above"). Also watch for non-reference lines caught inside the
section (journal-issue footers, running headers) and leave those without a bullet.

Do this manually, one entry at a time. Do not write a script.

## Step 12: Fix Lettered List Items

Read the file from the top. Scan for parenthesised-letter list items like `(a) First
item`, `(b) Second item` and convert each to a markdown bullet while preserving the
letter label: `- (a) First item`. Use Edit as you find them, then continue scanning.

Do this manually, one at a time. Do not write a script.

## Step 13: Separate Footnote Definitions

Read the footnotes section (everything after the body ends). Each `[^N]:` definition
must be on its own line with a blank line before and after it, and must not be indented.
PDF converters often group footnotes by page, indenting the second and later footnotes
of each page under the first.

When you find a run of indented or unspaced definitions, use Edit to rewrite the block
so each definition is flush-left with a blank line between it and the next.

Do this manually, one block at a time. Do not write a script.

## Step 14: Fix Typos

Read the entire file from top to bottom. Build a complete list of every OCR typo you
find — do **not** fix them one by one as you scan. Common patterns to watch for:

- **Missing space between words** — `capitalrelation`, `thoughtrepresented`, `theoryabove`
- **Merged date range** — `20078` → `2007-8`, `19978` → `1997-8`
- **Missing hyphen** — `MayJune` → `May-June`, `NovemberDecember` → `November-December`
- **Missing word** — `it worth saying` → `it is worth saying`
- **LaTeX italics artifact** — `$A$ Companion` → `A Companion`

Once you have the complete list, write it to a temporary JSON file as an array of
`{"from": "...", "to": "..."}` objects, then call the typo-fix script:

```bash
python3 scripts/fix-ocr-typos.py <file> /tmp/typos.json
```

The script applies all replacements in one pass and prints exactly what changed.
Note the output — include it in the Step 15 summary.

## Step 15: Report

Summarise what was done:
- How many page-number markers were removed (Step 6)
- How many LaTeX superscripts were converted (Step 7)
- How many paragraph breaks were inserted
- How many footnote definitions were moved to the end (and which keys)
- How many footnote definitions were fixed
- How many escaped ampersands were converted
- Which block quotes were added (first ~60 chars of each)
- Whether Contents / Bibliography were restructured
- How many typos were fixed (and what each was)

## Common Mathpix Artifacts (Reference)

| Artifact | Example | Fix |
|----------|---------|-----|
| Footnote superscript | `${ }^{3}$` | `[^3]` or `[^ch1-3]` |
| Superscript in citation | `$(\mathrm{G}, 684 .)^{3}$` | `(G, 684.)[^3]` |
| Definition without colon | `[^3] Text here` | `[^3]: Text here` |
| Bare numbered definition | `3 See Smith (1990)` | `[^ch1-3]: See Smith (1990)` |
| Embedded footnote in body | `[^2]: text` mid-document | move to end manually |
| Split body sentence | line A … `[^N]:` … line B (lowercase) | merge A+B, move footnote |
| Bundled authors' note | `[^0]:    ${ }^{1}$ Affiliations...` | `[^auth]: Affiliations...` |
| Page-number marker (alone) | `[^42]` on its own line | delete (Step 6 script) |
| Page-number marker (inline) | `[^42]Text continues` at line start | strip marker, keep text (Step 6 script) |
| Stray affiliation marker | `[^0]` on its own line | delete (Step 7 script) |
| Bibliography dash | `-.. 2011.` / `_. 2011.` / `—. 2011.` | `- ———. 2011.` |
| Bare-year bullet | `- 1997. Title...` | `- ———. 1997. Title...` |
| Escaped ampersand | `Capital \& Class` | `Capital & Class` |
| Inline math left-over | `$\mathrm{c}+\mathrm{v}$` | leave as-is (valid LaTeX) |
| `<br>` tags in titles | `Title <br> Subtitle` | leave or convert to newline |
| Contents page fillers | `Chapter ..... 12` | strip `..... 12` |
| Running header artifact | `x Contents` mid-page | delete |
| Lettered list item | `(a) First point` | `- (a) First point` |
