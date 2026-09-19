---
name: stylometry
description: >-
  Produce a stylometric analysis report for a text — a document, chapter,
  article, manuscript, or any prose file — using the pystylometry library. Runs
  a script that computes vocabulary diversity (MTLD, MATTR, rare-word ratio),
  readability grade levels (Flesch-Kincaid and Dale-Chall, the two that do not
  duplicate each other), syntactic structure, character statistics, n-gram
  entropy, style markers, genre/register, dialect, style drift, rhythm, and
  cohesion, then writes a markdown report: one table of every metric followed
  by a short published-banding narrative for each category. Use when the user
  says "stylometry", "stylometric analysis", "analyze the style of this text",
  "what reading level is this", "vocabulary richness", "authorship fingerprint",
  "is this AI-written", "compare these two texts stylistically", or wants a
  readability/diversity metric profile of a file.
---

# Stylometry

Generate a metrics report for a text with
[pystylometry](https://github.com/craigtrim/pystylometry) (50+ metrics across 11
modules). The report has one table, followed by a brief narrative of findings for
each metric family. It is modelled on the library's own showcase document,
`docs/metrics-showcase-hound-of-baskervilles.md`, minus the showcase's dozens of
small tables: the narrative applies the same published bandings to the computed
values, and the single table carries the numbers.

By default the report is **focused**: readability is represented by
Flesch-Kincaid and Dale-Chall, and lexical diversity by MTLD, MATTR, and
rare-word ratio, because the other measures in those families duplicate them
(see `evidence/metric-redundancy.md` and the section below). `--all-metrics`
reports everything.

## Running it

One command; the first run builds its own environment.

```bash
~/.pi/agent/skills/stylometry/scripts/stylometry-report PATH_TO_TEXT.md
```

That writes `PATH_TO_TEXT.stylometry.md` next to the input. Typical run:

```bash
S=~/.pi/agent/skills/stylometry/scripts/stylometry-report

# Full report with publication metadata
$S book/chapter-03.md -o book/chapter-03.stylometry.md \
    --title "Chapter 3: The Letter" --author "A. Writer" --year 2026 \
    --genre "literary fiction"

# Just the one consolidated table plus provenance
$S draft.md --table-only -o draft-metrics.md

# Table, findings, and the full per-metric tables for each category
$S draft.md --with-detail

# Findings for a couple of categories only
$S draft.md --sections summary,summary-table,markers

# Machine-readable metrics alongside the report
$S draft.md --json draft-metrics.json

# Check the section names and what each one covers
$S --list-sections
```

Then report back what it found: the output path, the skipped metrics if any,
and the handful of figures that matter for the user's question. Read the
generated file before summarising it — do not guess at values.

## Options

| Flag | Effect |
|---|---|
| `-o, --output PATH` | Report path (default `<input stem>.stylometry.md`) |
| `--title/--author/--year/--genre` | Metadata for the Text Summary table |
| `--chunk-size N` | Words per chunk for chunk-aggregated metrics (default 1000) |
| `--top-n N` | Rows in ranked tables such as top function words (default 10) |
| `--sections LIST` | Comma-separated subset, or `all` (default) |
| `--table-only` | Emit only the text summary, the consolidated table, and the appendix |
| `--with-detail` | Also emit the per-metric tables for each category |
| `--all-metrics` | Report every metric instead of the focused set |
| `--skip LIST` | Drop sections after `--sections` is applied |
| `--json PATH` | Also dump raw metric values as JSON |
| `--strip-markdown` / `--no-strip-markdown` | Markdown is stripped before analysis by default |
| `--quiet` | Suppress progress messages (warnings still print) |
| `--verbose` | Leave the analysis libraries' own logging and progress output alone |

Sections: `summary`, `summary-table`, `lexical`, `readability`, `syntactic`,
`character`, `ngrams`, `markers`, `genre`, `dialect`, `drift`, `prosody`,
`cohesion`, `extras`, `appendix`. `extras` covers the BNC frequency profile and
repetition/slop detection.

`summary-table` is the consolidated view: every computed metric in one flat
`Category | Metric | Value` table (220-260 rows for a full run), placed directly
after the text summary. It is always computed from the full metric set, even if
only that table will be rendered, so `--sections summary-table` and
`--table-only` both give you the complete table. Categories in the table are the
report section names, so the table filters or sorts by the same vocabulary.

## What the report contains

One markdown table, then prose. Specifically:

- **Text summary** — a couple of context lines (author, source, token/type
  counts, chunk size) and a caveat if the text is short.
- **Consolidated metrics table** — every computed metric as a single
  `Category | Metric | Value` table, including the publication metadata.
  Categories are the report section names, so the table filters or sorts by the
  same vocabulary. About 180 rows focused, 260 with `--all-metrics`.
- **Findings per category** — a short narrative for lexical, readability,
  syntactic, character, n-grams, markers, genre, dialect, drift, prosody,
  cohesion, and extras. No tables: the findings name the values that matter and
  say what they mean, using published bandings. Where the library's own outputs
  disagree with each other, or a counter is known to miss something, the
  narrative says so rather than smoothing it over.
- **Appendix** — provenance (versions, parameters, runtime), the list of any
  metrics that were skipped and why, and references.

Sections: `summary`, `summary-table`, `lexical`, `readability`, `syntactic`,
`character`, `ngrams`, `markers`, `genre`, `dialect`, `drift`, `prosody`,
`cohesion`, `extras`, `appendix`. `extras` covers the BNC frequency profile and
repetition/slop detection. `summary-table` is always computed from the full
metric set, even when it is the only section rendered.

The consolidated table is the digest; the per-metric tables that the source
showcase document contains are still available behind `--with-detail`, which
adds a table per metric family under each findings narrative.

## Setup

The wrapper creates the environment on first use at
`~/.local/share/pystylometry/venv`:

- Python 3.12 via `uv` — pystylometry requires `>=3.9,<3.13`, so a system
  Python of 3.13 or newer cannot run it directly.
- `pystylometry[all]` installed from a pinned upstream commit
  (`ce3c62b`), not from PyPI. The PyPI release still depends on the
  unmaintained `pronouncing` package, which fails on modern setuptools;
  master reads `cmudict` directly.
- spaCy's `en_core_web_sm` model, needed by the syntactic, cohesion, and
  genre metrics.

Re-run `scripts/setup_env.sh` to refresh, or set `PYSTYLOMETRY_VENV` to put the
environment elsewhere. A missing spaCy model or a missing optional package
degrades gracefully: those metrics are listed under "Skipped metrics" in the
appendix and the rest of the report is still produced.

## Reading the numbers

Three things are worth saying whenever the report is presented, because they
are the usual sources of misreading:

1. **Chunk sums are not document totals.** Hapax counts and similar
   count-valued metrics are computed per chunk and summed, so they measure
   rarity *within* a chunk of the given size. `--chunk-size` changes them.
   Two reports are only comparable at the same chunk size.
2. **The findings are published bandings applied to the computed values, not
   verdicts.** The script labels values using standard cut-offs (Flesch bands,
   MTLD bands, grade levels). It does not know the genre, the intended
   audience, or the author's intent. Where the library's own outputs disagree —
   a "frozen" register with a low formality score, modal ratios summing above 1,
   a negative vocd-D curve fit — the findings say so in place rather than
   papering over it.
3. **Some counters miss typographic quotes.** Quotation and dialogue figures
   can read zero on text using curly quotes; the narrative flags this when it
   happens.

Runtime scales with text length: about 130 s for a 60,000-word novel, a couple
of seconds for a short article. Cohesion, Gunning Fog, and the four spaCy-based
syntactic metrics dominate that. Use `--sections` to skip them while iterating.

## Example reports

Two complete reports on the same text — Arthur Conan Doyle, *The Hound of the
Baskervilles*, 59,112 words — are checked in under `examples/`:

- `report-hound-of-the-baskervilles-focused.md` (the default output, 21 KB)
- `report-hound-of-the-baskervilles-all-metrics.md` (with `--all-metrics`, 25 KB)

Diff them to see exactly what the focused profile adds or drops.

## Which metrics to keep

`evidence/metric-redundancy.md` answers "these ten readability formulas and ten
lexical-diversity measures — are they duplicative?" with numbers: 16 books,
1.07M words, correlations in both directions (within-document and across
documents).

What the report now does by default, following that evidence: keep
**Flesch-Kincaid and Dale-Chall** for readability, and **MTLD, MATTR and
rare-word ratio** for lexical diversity. Everything else in those two families
is still computed and shown under `--all-metrics`.

- **Readability**: the formulas are functions of the same two variables
  (sentence length, word-difficulty proxy) and correlate 0.92-0.99 with each
  other. Flesch-Kincaid carries the syllable-based cluster; Dale-Chall is the one
  real outlier at +0.51, because word *familiarity* is a different construct
  from word *length*. The report now compares exactly those two and reads the
  gap between them: Dale-Chall far above Flesch-Kincaid points at vocabulary,
  the reverse at long sentences.
- **Lexical diversity**: not one factor. Raw TTR and hapax ratio are +0.89,
  MATTR and MSTTR +0.92, rare-word and advanced-word ratio +1.00, MTLD and
  Yule's K -0.60. The report keeps MTLD (length-invariant), MATTR
  (window-invariant), and rare-word ratio (sophistication, a different axis
  again); vocd-D and HD-D are dropped as carrying sample-size effects.
- The evidence folder also holds the scripts and the raw measurements, so any
  of this can be recomputed on a different corpus.

## Comparing two texts

There is no built-in diff mode. Run the script twice and compare the tables
that are chunk-independent — STTR, MTLD, Yule's K, MATTR, MSTTR, the
readability grade levels, POS ratios, marker densities, and prosody. For
library-native pairwise comparison (Burrows' Delta, Zeta, Kilgarriff
chi-squared, vocabulary overlap, NCD), write a short Python snippet against the
venv interpreter:

```bash
~/.local/share/pystylometry/venv/bin/python - <<'PY'
from pathlib import Path
from pystylometry.authorship import compute_burrows_delta
from pystylometry.stylistic import compute_vocabulary_overlap
a = Path("draft-a.txt").read_text()
b = Path("draft-b.txt").read_text()
print(compute_burrows_delta(a, b))
print(compute_vocabulary_overlap(a, b))
PY
```

## Files

```
scripts/stylometry-report        bash entry point; bootstraps then execs the script
scripts/stylometry_report.py     analysis runner and markdown report writer
scripts/setup_env.sh             creates the uv virtualenv and installs the library
```

The report writer is one file with a simple structure: `run_analysis()`
collects results, the `findings_*()` functions turn each result group into
narrative prose (reusing the `interp_*()` banding helpers), the `render_*()`
functions produce the optional detail tables, and `render_summary_table()`
flattens everything into the single table. Adding a metric means adding one
call in `run_analysis()`, a row in `render_summary_table()`, and a mention in
the matching `findings_*()`. Sections are declared in `SECTION_ORDER`, with a
title in `SECTION_TITLES` and a description in `SECTION_DESCRIPTIONS`; a new
category also needs an entry in `FINDINGS_RENDERERS` and (if it should have
detail tables) an entry in the renderer list inside `build_report()`.
