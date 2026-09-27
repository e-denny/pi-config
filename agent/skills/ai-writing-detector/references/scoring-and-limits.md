<!-- markdownlint-disable MD013 -->

# Scoring and limits

## Default report (this package)

`scripts/analyze.js` prints schema **`ai-writing-detector.analyze.v1`** via
`scripts/report.js`. Multi-file uses **`ai-writing-detector.analyze.batch.v1`**.

| Field | Meaning |
| --- | --- |
| `interpretation` | Always `signals_only` in default mode |
| `source` | File path or `stdin` |
| `score` | 0–100 composite from the **full** engine run |
| `combined_score` | `score` + `discourse.score`, capped at 100 (used by `--fail-above`) |
| `label` | Engine band string |
| `combined_label` | Discourse-aware band when the engine score is low but architecture signals exist |
| `discourse` | Package-layer block: `score`, `label`, `signal_count`, `by_pattern`, `examples`, `advisories` |
| `bands.tier1_markers` | Count of `tier1` hits (after optional severity filter) |
| `bands.tier1_clarity` | Count of `tier1-clarity` (wordiness, not authorship) |
| `bands.discourse_signals` | Count of argument-architecture hits (see `references/discourse-patterns.md`) |
| `bands.other_signals` | All other listed issue types |
| `min_severity` | Filter applied to listed issues, if any |
| `issue_count_unfiltered` | Count before severity filter |
| `by_type` / `by_severity` | Histograms of listed issues |
| `samples` | Short quoted spans (+ suggestion when present) |
| `warnings` | Reliability and reporting cautions (shown first in text mode) |
| `reliability.too_short` | Below recommended word floor (~40) |
| `engine_raw` | Only with `--raw` — full upstream payload |

**Omitted by default (unsafe for agents):**

- `document_classification` (`HUMAN_ONLY` / `MIXED` / `AI_ONLY`)
- `class_probabilities`
- `confidence_category`

Escape hatches: `--raw` or `--json-engine` (stderr warns).

## CLI quality-of-life

| Flag | Role |
| --- | --- |
| `--quiet` | One line per file (cron); batch also prints summary line |
| `--summary-only` | Aggregate totals only (batch schema) |
| `--min-severity` | Filter listed issues; score unchanged |
| `--sample-limit` / `--no-samples` | Control sample size |
| multi-file args | Batch report + summary |
| `--fail-above` / `--strict-short` | Exit 3 / 2 |

## Validate exit codes

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Preservation errors |
| 2 | Usage / Node version |
| 4 | Warnings only + `--fail-on-warnings` |

## Exit codes (`analyze.js`)

| Code | Meaning |
| --- | --- |
| 0 | Ran successfully |
| 1 | Usage / Node version / IO error |
| 2 | `--strict-short` and input below recommended length |
| 3 | `--fail-above N` and `score >= N` (any file in a batch) |

## What the score is not

- Not proof a human or a model wrote the text
- Not calibrated like a production classifier product
- Not a target to minimize for "undetectable" output
- Not a substitute for provenance

## Long documents (10,000-word guard)

The vendored engine refuses documents over 10,000 words and returns
`score: 0`, `label: "Text too long"`, `issues: []`. A zero there means *not
scanned*, not clean. The package layer chunks the text at paragraph boundaries
(9,000 words per chunk), runs the engine on each chunk, deduplicates the issues,
and reports the **densest chunk** as `score` (not a sum). `reliability.engine_chunks`
and a warning record the chunking. The discourse layer always runs on the full
text and is not subject to the guard.

## Known calibration limits (upstream research, avoid-ai-writing v3.22+)

1. Composite score can be weak at class separation.
2. Much of the 0–100 range may go unused on ordinary paragraphs.
3. Em-dash rate can invert as an authorship signal.
4. Tier 1B clarity words fire on ordinary professional prose.
5. Register dominates false positives.
6. Judgment-only rules are missing from the engine (categories section C).
7. The engine scores vocabulary and surface phrases only. Argument
   architecture (announced counts, metacommentary, evaluative asides,
   catechetical Q&A, subtraction reveals, dramatized frames, appositive
   negation tags, imperative-and-consequence reveals, parallel scaffolds) is
   scored by the package discourse layer and reported separately under
   `discourse`; a clean lexical score with a high `discourse.score` is a real
   finding, not noise.
8. Quoted material and footnotes are not excluded from the engine's scan, so a
   long draft can pick up hits inside block quotations or citation apparatus.
   The package layer excludes quoted spans from `negated-tag` and
   `imperative-reveal` only. The other discourse patterns, and the engine
always, remain attribution-blind.

## How to report results

1. Warnings first when short or clarity-only.
2. Separate Tier 1A markers from Tier 1B clarity.
3. Name `context_mode`.
4. State: mechanical signals only.
5. Offer humanizer for quality rewrite — without score-chasing.
