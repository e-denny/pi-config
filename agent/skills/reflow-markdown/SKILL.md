---
name: reflow-markdown
description: >
  Insert line breaks into prose, block quotes, footnotes, and list items in a
  markdown file so that no line exceeds a given character limit. Breaks at
  whole-word boundaries, targeting close to the limit rather than breaking
  early. Never splits wikilinks ([[slug|display text]]), inline LaTeX ($...$),
  markdown links, or inline code — those move whole to the next line. Leaves
  tables, display math ($$...$$), YAML frontmatter, code fences, headings, and
  comments unchanged. Use when the user says "insert line breaks", "reflow
  lines", "wrap lines", "maximum N characters per line", or "lines are too
  long" — including cleaning up the wiki's legacy over-100-char lines.
allowed-tools: Bash
---

# Reflow Markdown Lines

Reflow a markdown file so that prose, block quotes, footnote definitions, and
list items are wrapped to a maximum line length (default 100). The script is
surgical: **only blocks containing an over-width line (or a wikilink split
across lines) are rewritten** — compliant paragraphs stay byte-identical.

## What is atomic (never split, moved whole to the next line)

- Obsidian wikilinks: `[[slug]]`, `[[slug|display text]]` (the whole `[[…]]`
  token, including a multi-word display text)
- Inline LaTeX: `$...$` (opening `$` must be followed by non-whitespace,
  closing `$` must be preceded by non-whitespace — so currency amounts like
  `$500bn` and escaped dollar signs stay plain text)
- Markdown links: `[label](url)`
- Inline code: `` `...` ``
- Embedded images: `![alt](url)` — each image line starts its own block and is
  never reflowed; prose paragraphs break before/after an image line so the
  image is never pulled inline. (A line mixing prose and an image token is not
  split; the token stays atomic inside the paragraph.)

Wikilinks/links that were already split across lines are rejoined and
normalised when their paragraph is reflowed.

## What is left unchanged (even if over the limit)

- YAML frontmatter (`--- … ---` at the top of the file)
- Tables (rows starting with `|`)
- Display math blocks (`$$…$$`, single- or multi-line)
- Fenced code blocks (```` ``` ```` / `~~~`), HTML comments, headings, blank
  lines, horizontal rules, embedded images (`![alt](url)`)

These are exempt from the wiki's line-length rule, so lines that remain over
the limit inside them are expected.

## Step 1: Get File and Width

If the user hasn't specified a file path, ask for it. The file must be a `.md`
file.

If the user specified a maximum character width (e.g. "80 characters", "max
100 chars"), use that as `--width N`. If no width was given, use the default
(100 — the wiki convention).

## Step 2: Run the Script

```bash
python3 ./scripts/reflow-markdown.py <file> [--width N]
```

The script edits the file in place and saves a `<file>.bak` backup alongside
it.

## Step 3: Verify (wiki use case)

Confirm no reflowable line remains over the limit:

```bash
grep -n '.\{101,\}' <file>
```

Remaining hits should only be exempt structures (tables, `$$` math, YAML
frontmatter paths, headings) or single unbreakable tokens longer than the
width. The script's own summary separates the two counts.

## Step 4: Report

Tell the user:

- The file that was reflowed
- The width used
- The line count before and after
- The counts the script printed (over-width lines, split into exempt vs.
  unbreakable-token)
- That a backup was saved as `<file>.bak`
