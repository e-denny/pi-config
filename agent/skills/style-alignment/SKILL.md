---
name: style-alignment
description: >-
  Two-phase style alignment: profile a baseline text on a focused panel of
  length-stable, LLM-controllable stylometric measures (sentence and paragraph
  geometry, word weight, readability, diversity, POS, syntax, voice, coherence,
  punctuation, rhythm, register), then iteratively rewrite a target text to
  match it. Each iteration runs a humanizer pass to remove obvious AI tells,
  writes a comparison report of baseline vs target vs movement, and asks the
  user whether to continue. Use when the user says "match this style", "align
  my draft to this author", "make this text stylometrically similar to the
  baseline", "style alignment", or wants an iterative style-matching loop.
license: MIT
---

# Style Alignment

Align a **target** text to a **baseline** text. Phase 1 profiles the baseline on
a focused panel of length-stable, LLM-controllable stylometric measures. Phase 2
iteratively edits the target, measures the result, writes a comparison report,
and asks the user whether to run another iteration.

Every iteration also runs the **humanizer** skill on the target to remove
obvious AI tells. The humanizer is not a cosmetic final pass; its guardrails
constrain every style edit, and its findings are part of the comparison report.

Two rules govern the whole workflow:

1. **Ask for both texts before doing anything.** The user must provide a
   baseline path and a target path.
2. **Stop after every comparison and ask whether to run another iteration.**
   Do not start the next edit without an explicit yes.

---

## Before you start

If the user has not supplied both paths, ask for them in one short message:

1. Where is the **baseline** text (the style reference)?
2. Where is the **target** text (the draft to rewrite)?

Then ask only what materially changes the run:

- Is the target **fiction** (include dialogue ratio) or **verse** (include
  alliteration/assonance)? Default: neither.
- Standard tolerance (`matched |z| <= 0.5`, `close <= 1.0`) or looser?
- May the work directory be created next to the target as
  `<target-stem>.style-alignment/`? Default: yes.

If either text is a book chapter or an academic article, it probably carries
footnote apparatus. Do not ask about it: the default is to measure the
prose-only copy, and the report states what was removed. Mention the choice
after `init` runs, in one line, with the word counts.

Do not guess paths. Do not edit the original target; the workflow copies it
into the work directory and edits copies.

### Dependencies

This skill uses two existing skills:

- **stylometry** — the analysis engine. The `style-align` wrapper calls
  `~/.pi/agent/skills/stylometry/scripts/stylometry-report`, which bootstraps
  its own virtualenv. If that path is different, set `STYLOMETRY_REPORT`.
- **humanizer** — the AI-tell pass. Read
  `~/.pi/agent/skills/humanizer/SKILL.md` and the references it names
  (`references/ai-tells.md`, `references/pattern-catalog.md`,
  `references/vocabulary-tiers.md`, `references/long-form-diagnostics.md` as
  needed) before the first iteration.

If either skill is missing, say so and stop. Do not substitute a generic
"make it sound human" pass for the humanizer.

---

## Phase 1: baseline profile

Run:

```bash
S=~/.pi/agent/skills/style-alignment/scripts/style-align
$S init --baseline BASELINE.md --target DRAFT.md
```

Add `--fiction`, `--verse`, `--no-extras`, or `--keep-markdown` if the user
asked for them. Add `--workdir DIR` to choose the work directory. `init`:

- analyzes the baseline;
- writes `baseline-report.md` and `raw/baseline.stylometry.json`;
- copies the target to `target-iter-00.md` (the original is untouched);
- writes `state.json` and a short `README.md` in the work directory.

Read `baseline-report.md` before summarizing it. Its **Panel detail** table
lists every selected metric on its own line with:

- the baseline value;
- the baseline's chunk-to-chunk SD;
- the effective tolerance (chunk SD, or the domain floor when the SD is
  smaller, missing, or the metric is single-pass);
- the panel weight;
- both levers (how to raise it, how to lower it);
- the metrics that lever also moves.

It also contains a rough, genre-dependent profile and any unavailable metrics
and why.

Present the baseline profile to the user in a few lines: the panel size, the
most distinctive values (paragraphing, sentence geometry, readability,
diversity, register), and any metrics that were unavailable. Say what was
measured: the reports carry a line like "apparatus stripped (64 footnote
definitions, 7 headings); measured 9,356 of 13,648 words", and the user should
hear that figure once, because every later number refers to it. Do not dump the
whole table unless the user asks.

### What the panel contains

Only measures that are length-stable and controllable by an LLM:

- **Sentence geometry**: mean sentence length, sentence-length SD,
  simple-sentence ratio, mean T-unit length.
- **Paragraphing**: mean paragraph length in words, paragraph-length SD in
  words, mean paragraph length in sentences, paragraph topic consistency.
- **Word weight**: syllables per word, average word length.
- **Readability**: Flesch-Kincaid grade, Dale-Chall difficult-word ratio.
- **Diversity/repetition**: MATTR, MTLD, Yule's K.
- **Vocabulary**: rare-word ratio.
- **POS**: noun-verb ratio, lexical density, adjective and adverb ratios.
- **Syntax**: passive-voice ratio, clausal density, dependency distance,
  coordination index, subordination index, mean parse-tree depth, preposition
  ratio, determiner ratio.
- **Voice/markers**: contraction ratio, negation density, hedging density, modal
  density, intensifier density.
- **Cohesion**: pronoun density, demonstrative density, connective density.
- **Punctuation**: punctuation density, and separately semicolon, colon, dash,
  and parenthetical density.
- **Rhythm**: sentence-length alternation, word bigram entropy.
- **Register**: formality score and its components, Latinate ratio and
  nominalization density; first-person ratio.
- **Optional**: dialogue ratio (fiction), alliteration/assonance (verse),
  flagged words/n-grams per 10k (extras).

The panel deliberately excludes counts, totals, extrema, raw/root/log TTR,
HD-D, vocd-D, labels, and confidence scores. Formality is a composite, so it
carries a quarter of the weight of a primary member (0.25 against 1.00) and its
components (Latinate, nominalization, passive, first person) are in the panel
where an edit can actually reach them. Punctuation density likewise stays as
the aggregate at 0.25 while the four specific marks carry the actionable
signal. The full 200-metric profile belongs to the stylometry skill; do not run
it unless the user asks.

### Why these members and not others

Most of the panel is the stylometry report's "Target" verdict set. The rest is
there because leaving it out produced a wrong decision:

- **Paragraphing** — without it the workflow can only see sentences, so a draft
  whose paragraphs are all one size and one shape reads as "sentence geometry"
  trouble and gets sentence-level fixes. Paragraph length is the first thing a
  reader feels and the last thing a sentence metric shows.
- **The punctuation split** — an aggregate punctuation number cannot tell a
  comma-rich draft from a semicolon-rich one. In the run that motivated these
  additions, the draft's paragraphs were being repaired by semicolon joins
  while the only punctuation metric read "close".
- **Coordination index and parse depth** — "long sentences" can mean
  subordinated (nested clauses) or coordinated (and/but chains). The aggregate
  sentence-length number is identical for both; these two separate them.
- **Negation, hedging, modal and intensifier density** — register-level voice
  markers that no other member captures, and cheap to check: a matched value is
  evidence for leaving the prose alone.
- **Preposition and determiner ratios** — lexical density says how much of the
  text is content words, not which function words carry it. These two are the
  most steerable parts of clause structure: explicit prepositional phrases
  against verb particles and compounds, articles with every noun against bare
  plurals and proper names.
- **Simple-sentence ratio, T-unit length, subordination index** — mean length
  and clausal density describe an average. These say how the average is built:
  whether the writer ever stops at one clause, and whether a long sentence is a
  long clause or a chain of short ones. With coordination and parse depth they
  give four independent coordinates on sentence construction.
- **Latinate ratio and nominalization density** — the components the register
  section already told the editor to target, with nothing in the panel to
  measure them.

### Deliberately left out, and why

The engine emits around 200 scalars. The panel defines 52 and a run selects
about 45 of them. Everything excluded falls into one of five groups, and the
reason matters more than the list:

- **Components and inverses of members already present** — verb ratio, noun
  ratio, function-word ratio, adjective-noun ratio, auxiliary ratio, common-word
  ratio, MSTTR, Yule's I, MTLD forward/backward, hapax ratio, mean and median
  frequency rank. Each is a near-linear function of a member already in the
  panel, so adding it would count the same difference twice. Auxiliary ratio is
  the clearest case: it moves because of the passive and the modals, both of
  which the panel already measures.
- **Other bins of a distribution already covered** — the compound, complex, and
  compound-complex sentence ratios sum with simple-sentence ratio to 1.0 and are
  predictable from it plus coordination and clausal density.
- **The remaining readability formulas** — SMOG, Fog, Coleman-Liau, ARI, Fry,
  FORCAST, Linsear. They correlate 0.92-0.99 with Flesch-Kincaid and Dale-Chall,
  which the evidence document keeps precisely because they are the two
  non-duplicative ones.
- **Topic-driven measures** — word-repetition ratio, content-word overlap, mean
  sentence similarity, technical-term density, quotation density, digit and
  uppercase ratios. These track what the text is about. Chasing them produces
  synonym substitution and invented detail, which is a worse defect than the
  mismatch.
- **Levers that invite a tell, or are too indirect to steer** — the
  additive/adversative/causal/temporal connective ratios reward sprinkling
  "However," every third sentence, which the humanizer flags; question and
  exclamation density are single-digit counts, so noise; trigram, 4-gram,
  character, and syllable-pattern entropies are sample-size sensitive, and an
  edit that moves them is manipulating syllable counts rather than prose;
  structural and functional diversity, complexity uniformity, and the coherence
  composites are `Monitor`-class labels.

**Dialect is the one measure left out for a different reason.** It is
length-stable, it is controllable, and it is still wrong to put on the panel:
its right answer is consistency within the book, not a match to the baseline. In
the run that produced this list the baseline scored British 0.25 and the draft
0.53, so "matching" would have Americanised a British book. If spelling
consistency is actually in question, run the stylometry report's dialect section
on both texts and judge it as a correctness check, not a style target.

`--only` and `--skip` can only select members that are already in the panel, so
a genuinely new member means adding it to `PANEL` in `scripts/style_align.py`
with a weight and a floor, and bumping `PANEL_VERSION`.

### Measuring prose, not apparatus

Before analysis both texts are reduced to prose. `init` and every `compare`
write a copy into `raw/<name>.analysis.md` with the following removed:

- YAML frontmatter, fenced code, HTML comments;
- footnote definitions and their indented continuation lines;
- footnote reference markers (`[^12]`);
- headings, horizontal rules, table rows;
- figure and image embeds.

Prose, block quotations, lists, and inline math stay. Every number in every
report refers to that copy, not to the source file, so a measurement can always
be audited.

One case is deliberately left alone: a PDF-to-Markdown conversion sometimes
leaves a note's text inline in the body, marked `[^13] text...` with no colon.
That line is stripped of its marker but kept as prose, because the file
presents it as a body paragraph and at that point the measure cannot tell a
displaced note from a sentence that happens to open with a reference. If the
baseline has that artefact and it matters, repair the source first.

The reason is not tidiness. Footnote apparatus has its own conventions, and
they are not the author's prose: citation footnotes are semicolon-heavy, use
long titles and proper names, and each note is a separate one-to-three-sentence
block. Left in, they drive the punctuation, word-weight, diversity, pronoun,
and paragraph numbers. The run that motivated this rule had 250 of its 323
semicolons inside footnote definitions, so the panel reported a tenfold
semicolon gap where the body prose had fourfold, and its paragraph mean sat
within 1% of the baseline while the body was 13% shorter per paragraph. Both
texts are stripped, so the comparison stays fair either way; the numbers just
stop describing the apparatus.

If a run genuinely needs the notes measured, pass `--no-strip-apparatus` at
`init`. The choice is recorded in `state.json` and every later `compare` reuses
it, so a work directory cannot drift between the two; to measure the other way,
initialise a new one. `compare` also refuses a work directory built on an older
panel version, because a baseline measured on one panel cannot be compared with
a target measured on another.

---

## Phase 2: iterate

The loop is: **analyze → edit → humanize → measure → report → ask**.

### 2.1 Initial target analysis

1. Run the humanizer's **Step 1 (detect)** on `target-iter-00.md`. Follow the
   humanizer skill exactly: scan the whole text, report findings by priority
   with locators and counts, and save the report as
   `humanizer-00.md` in the work directory. Do not edit during detection.
2. Present the humanizer findings. Do not edit yet. The approval to fix them
   is requested together with the first-iteration decision, after the initial
   comparison is on the table.
3. Run:

```bash
$S compare --workdir DRAFT.style-alignment \
  --target DRAFT.style-alignment/target-iter-00.md \
  --humanizer-report DRAFT.style-alignment/humanizer-00.md
```

This is **iteration 00**: the initial target analysis. It writes
`comparison-00.md` and `comparison-00.json`. There is no previous target yet,
so the "Moved" column is empty.

4. Read `comparison-00.md`. Present:
   - the baseline profile (already shown in phase 1);
   - the biggest gaps and the edit plan;
   - the attached humanizer findings.

5. Ask whether to start the first alignment iteration. A yes authorizes the
   style edit plan **and** the humanizer findings presented in step 2; tell the
   user they can exclude a finding or ask for only the humanizer fixes. This is
   the humanizer's approval gate. If the user says no, stop and summarize.

### 2.2 The first alignment iteration

If the user says yes:

1. Copy the current target to the next file:
   `target-iter-00.md` → `target-iter-01.md`.
2. Apply the style edit plan **first**, using the `edit` tool for precise
   changes. Preserve facts, names, numbers, citations, paragraph order, and
   quoted material.
3. Apply the approved humanizer fixes to the same file. The humanizer fixes
   come after the style edits so they can remove any AI tells the style pass
   introduced.
4. Run the humanizer's **Step 1 (detect)** again on `target-iter-01.md`. Save
   the new report as `humanizer-01.md`. If the humanizer finds nothing, write a
   short "No findings" report so the record is explicit.
5. Run:

```bash
$S compare --workdir DRAFT.style-alignment \
  --target DRAFT.style-alignment/target-iter-01.md \
  --humanizer-report DRAFT.style-alignment/humanizer-01.md
```

The script auto-increments the iteration. It writes `comparison-01.md` with:

- **Baseline** value;
- **Before** (iteration 00) and **After** (iteration 01);
- **Change** = after − before;
- **Gap to baseline** and its z-score, before and after;
- status (`matched`, `close`, `off`, `unavailable`), before and after;
- the next move for each metric;
- movement summary and remaining edit plan;
- **cumulative progress**: every metric's baseline, original-target value,
  current value, change since the original, and the percentage of the original
  gap closed (see below);
- the attached humanizer report, and the same fields in the `.json` as
  `original`, `original_iteration`, `cumulative_change`, `gap_closed_pct`.

The comparison report has three measurement sections: a **Summary table**
(one scannable row per metric for the last pass), the **Cumulative progress**
tables (one per family, from the original target to now) and a **Detailed
metric ledger** (one block per metric with every before/after line: baseline
and tolerance, before, after, raw and percent change, gap closed, gap and z
before and after, status before and after, the trajectory across all
iterations, the gap closed since iteration 00, the next move, and the coupled
metrics). Every selected metric appears in all three, including unavailable
ones; the ledger ends with the panel metrics that were excluded from this run
and why.

6. Read `comparison-01.md`. Present the movement and the remaining gaps. Then
   ask: **"Another iteration?"**

### 2.3 Repeat

If the user says yes:

- Copy `target-iter-01.md` → `target-iter-02.md`.
- Apply the new edit plan and the approved humanizer fixes.
- Run humanizer detect on the new file (`humanizer-02.md`).
- Run `compare` with `--humanizer-report humanizer-02.md`.
- Present `comparison-02.md` and ask again.

When you ask **"Another iteration?"**, list the open humanizer findings in the
same message and say that a yes authorizes fixing them in the next pass. If
the user wants to leave a finding alone, they will say so. This keeps the
humanizer's approval gate intact without adding a second question to every
iteration.

If the user says no:

- Summarize the final comparison: final D, matched/close/off counts, the
  largest remaining gaps, the movement across iterations, and the artifact
  paths.
- If humanizer findings remain, offer a final humanizer Step 2 fix. If the
  user approves and you apply it, run `compare` once more (a new iteration) to
  confirm the style metrics did not drift.

### Stop conditions

Stop and report when any of these is true:

- All selected metrics are `matched` or `close`, and the humanizer has no open
  high/medium findings.
- The user says stop.
- Six to eight iterations have run without meaningful improvement.
- `D` rises for two consecutive iterations, or the same metrics remain `off`
  while the edits are changing content rather than style.
- A metric can only be matched by changing facts or content. Exclude it, say
  why, and stop chasing it.
- **Gap closed stops rising.** If the cumulative table shows most metrics'
  gap-closed shares flat or falling for two iterations, the levers for that
  metric family are exhausted. Report which families stalled, which are
  bounded by subject matter or technical vocabulary, and stop — reaching
  100% is not the goal, rising is.
- The remaining gaps are structural rather than stylistic — a paragraph mean
  or a topic-consistency gap that can only be closed by reordering, cutting, or
  adding argument. Name the structural edit and stop; do not perform it under
the banner of style alignment.

---

## Reading the comparison report

### The summary

- **Weighted mismatch D** — a weighted RMS of the per-metric z-scores. Lower is
  better. It is not a p-value. A change smaller than about 0.1 is noise.
- **Matched / close / off** — `matched` is `|z| <= 0.5`, `close` is
  `|z| <= 1.0`, `off` is above 1.0.
- **Movement** — how many metrics moved toward the baseline, away from it, or
  stayed within the noise threshold. Movement below `0.25 ×` the effective
  tolerance counts as unchanged.

### The summary table

One row per selected metric, for scanning. Columns: baseline, before, after,
change, gap and z before, gap and z after, status before → after, and next
move. `z` is the gap divided by the baseline's chunk SD, or by the
panel's domain floor when the metric is single-pass. The floor is a minimum
meaningful difference, not a measurement precision. A large `z` on a
single-pass metric means "this difference is larger than the smallest
difference worth caring about," not "this is statistically significant."

The paragraphing metrics are single-pass: the engine returns one value per
text, not one per chunk, so the floor alone sets the tolerance. They are also
the only members whose baseline values this script computes itself (from the
prose-only copy, using the engine's own blank-line segmentation), because the
engine reports paragraph length in sentences and a writer thinks in words.
When a text has fewer than three paragraphs, those two metrics show
`unavailable`; paragraph geometry needs paragraphs to measure.

The baseline report's **Panel detail** table gives the same full row for every
selected metric at phase 1: baseline, chunk SD, effective tolerance, weight,
both levers, and the metrics that lever moves.

### The cumulative progress tables

One table per family, answering a different question from the summary table:
not "what did this pass change" but **"how far have we come from the original
text"**. Columns: metric, baseline, original (the iteration 00 value), the
current iteration's value, the change since the original, and **gap closed** —
the share of the original distance to the baseline that the text has covered.

`Gap closed` is the number to steer by: **100% means the metric now sits on the
baseline**, 0% means nothing has changed since the original, and a negative
value means the metric has drifted away from the baseline since iteration 00.
The aim of the whole exercise is to make this column rise, iteration after
iteration, on as many metrics as possible — not to make every iteration's D
fall, and not to reach 100% on every line.

Why 100% is not always reachable, and should not be forced:

- **Subject matter.** A chapter arguing against marginalism will not match a
  chapter of *Capital* on parenthetical aside density (2.96 vs 0.30 here), or on
  first-person and contraction rates.
- **Technical vocabulary.** Terminology is repeated by necessity, and nominal
  and Latinate words carry the argument: Yule's K, MTLD, syllables per word and
  the Dale-Chall ratio can be structurally short of the baseline while the prose
  is entirely appropriate.
- **The price of another gain.** Merging sentences raises clause density;
  recasting negations lowers modal density. A metric that drifts a few per cent
  while a larger one closes is a trade, not a defect — name it and move on.

Rules for reading it:

- Compare the same metric's gap-closed figure across iterations. Monotone
  increase is the target; a fall is a regression to report in plain words, with
  the metric named and the cause given.
- A `—` in the gap-closed column means the metric was already inside the close
  band at the original text, where a percentage of a near-zero gap is noise.
- A metric capped in D (any `|z|` above 3) can move a long way without moving D.
  Read this table for direction, the summary for what the last pass did, and D
  only for the overall weather.
- When a gap-closed figure stalls, decide which it is: levers exhausted, subject
  matter, or a source of the gap the panel cannot see. Record the verdict in the
  iteration's changelog rather than re-running the same pass.

### The detailed metric ledger

The full before/after record. One block per metric, grouped by family, in
panel order. Each block gives:

- the metric id, family, weight, unit, and whether the tolerance is a chunk SD
  or the domain floor;
- **Baseline**, its chunk SD when present, and the effective tolerance;
- **Before** (the previous iteration's value);
- **After** (this iteration's value);
- **Change** in raw units and percent, whether it moved toward or away from the
  baseline, and what fraction of the gap that closed;
- the **noise threshold** and whether the move exceeds it;
- **Gap to baseline** with `z` and status, before → after, plus the status
  change (`improved`, `worsened`, `unchanged`);
- **Trajectory**: every recorded iteration's value in order, then the baseline;
- **Next move** and the metrics that operation also moves.

The ledger is the authoritative per-metric record. Read it, and use it for any
per-metric claim in the presentation; do not reconstruct movement from the
summary table alone. Do not paste the whole ledger into the chat unless the
user asks for it — present from it and name its path.

After the last metric the ledger lists the panel metrics that were **not in
this run** (dialogue ratio without `--fiction`, the verse metrics without
`--verse`, the repetition/slop metrics with `--no-extras`, or ids excluded by
`--only`/`--skip`) so the reader can see what the numbers do not cover.

### The edit plan

The report lists the top five deviations by `weight × |z|`. Each line gives:

- baseline, target, gap, and z;
- whether to raise or lower the metric;
- the concrete operation;
- what else that operation moves;
- the last iteration's movement for that metric, if any.

Apply the plan in the report's order. Do not tune metrics that are already
`matched`. Do not chase a `close` metric if fixing it would break a
higher-weight target.

### Humanizer findings

The attached humanizer report is part of the comparison. Fix only the findings
the user approved. The humanizer's `Never inject these` list is a hard
constraint on every style edit. If a humanizer fix would move a metric away
from the baseline, say so and let the user choose; do not silently trade style
accuracy for a cosmetic change.

### When D rises

If the weighted mismatch rises after a pass:

- Check whether one high-weight metric overshot (for example, sentence length
  moved past the baseline).
- Prefer a **smaller quota** on the next pass over a full revert, unless the
  pass also changed content or introduced humanizer findings.
- If the pass broke content preservation or paragraph order, revert it and say
  why.
- Report the rise plainly. Do not claim progress that the numbers do not show.

---

## Editing rules

### Priority order

Apply levers in this order, because macro changes move many downstream metrics:

1. **Paragraphing** — paragraph length, then paragraph-length SD.
2. **Sentence geometry** — mean sentence length, then sentence-length SD, then
   how the sentences are built: simple-sentence ratio, T-unit length,
   subordination against coordination.
3. **Word weight and readability** — syllables per word, Flesch-Kincaid,
   Dale-Chall.
4. **Lexical diversity/repetition** — MATTR, MTLD, Yule's K.
5. **Register and syntax** — noun-verb ratio, lexical density, passive,
   clausal density, parse depth, nominalization, preposition and determiner
   ratios.
6. **Voice and markers** — contractions, negation, pronouns, modals, hedges,
   intensifiers.
7. **Punctuation and cohesion** — the specific marks (semicolon, colon, dash,
   parenthesis), connectives, content overlap.
8. **Rhythm** — sentence-length alternation, word bigram entropy, optional
   verse sound devices.

If you tune punctuation first, the next sentence split will undo it. If you
tune sentence geometry before paragraphing, every paragraph boundary you move
will undo part of the sentence work.

### Paragraph edits

Paragraph metrics are structural, and they pull in different directions:

- **Words per paragraph** moves when you merge or split whole paragraphs, or
  when you add or cut whole sentences.
- **Sentences per paragraph** moves with the boundaries and with adding or
  removing whole sentences inside a paragraph, but not with sentence length.
  Splitting one long sentence in two raises it; merging two paragraphs raises
  it by their sentence counts, and raises words-per-paragraph by the full size
  of the shorter paragraph.
- **Paragraph-length SD** is a spread measure. It rises from making some
  paragraphs short and others long; uniformly splitting every long paragraph
  lowers the mean and leaves the spread flat. Look at the distribution, not
  just the mean, before deciding which way to move.

Rules for paragraph work:

- Split where the topic turns, not on a word count. A paragraph that changes
  subject halfway is the one to split; a long single-topic paragraph is not a
  defect.
- Do not pad a short paragraph to reach a mean. Develop the point if it is
  underdeveloped; otherwise leave it short. Short paragraphs are part of the
  spread the baseline has.
- Do not merge two paragraphs that make different points to raise the mean.
  Merge two that continue one argument.
- Preserve paragraph order. A paragraph pass redistributes boundaries, it does
  not reorder the argument, and it must never move a quotation away from the
  claim it supports.
- Block quotations, figure captions, and display math are not paragraphs to
  tune. Leave them intact and do not count them as targets.

### One pass at a time

- Apply one coherent pass, then measure. Do not stack several unmeasured passes.
- Work at paragraph level. Keep a changelog of the operations and locations.
- Use the smallest faithful repair. Do not rewrite for its own sake.
- Preserve facts, quantities, conditions, causality, negation, uncertainty,
  names, numbers, citations, and paragraph order.
- Do not add fake detail, invented experience, or manufactured stakes.
- Do not introduce typos or fake roughness to "sound human."

### Counter the LLM's default bias

LLM rewrites tend to become **heavier, more formal, and less personal**:
longer words, more nominalizations, more passive voice, more commas, higher
MATTR, fewer first-person pronouns, fewer contractions, fewer questions, and
flatter sentence-length variation.

When the baseline is lighter or more personal, explicitly counter the default:

- keep short sentences short;
- restore contractions where the baseline uses them;
- keep first-person passages if the baseline has them;
- prefer verbs over nominalizations;
- avoid em dashes, "furthermore", "pivotal", "underscore", "foster";
- do not "polish" the voice out.

The edit plan's `Do not` list is generated from the current gaps. Follow it.

### Humanizer guardrails

Before every edit, load the humanizer's `Never inject these` list. In
particular, never add:

- invented speaker perspective or personal experience;
- manufactured stakes or forced contrarianism;
- performed candor;
- em-dash theatrics;
- staccato fragments that fake rhythm;
- invented specifics, names, dates, or mechanisms.

The humanizer's full rules are in its skill file. This skill does not replace
them, and a style target never justifies inventing content.

---

## Commands

```bash
S=~/.pi/agent/skills/style-alignment/scripts/style-align

# Phase 1: baseline profile + workdir + target copy
$S init --baseline baseline.md --target draft.md
$S init --baseline baseline.md --target draft.md --fiction
$S init --baseline baseline.md --target draft.md --verse --no-extras
$S init --baseline baseline.md --target draft.md --workdir /tmp/align

# Phase 2: initial target analysis (iteration 00)
$S compare --workdir draft.style-alignment \
  --target draft.style-alignment/target-iter-00.md \
  --humanizer-report draft.style-alignment/humanizer-00.md

# After the first edit (iteration 01)
$S compare --workdir draft.style-alignment \
  --target draft.style-alignment/target-iter-01.md \
  --humanizer-report draft.style-alignment/humanizer-01.md

# Inspect the loop
$S status --workdir draft.style-alignment
$S panel
```

Options:

| Flag | Used by | Effect |
|---|---|---|
| `--fiction` | init | Include dialogue ratio |
| `--verse` | init | Include alliteration/assonance |
| `--no-extras` | init | Skip BNC/repetition/slop metrics |
| `--keep-markdown` | init | Do not strip markdown before analysis |
| `--no-strip-apparatus` | init | Measure footnote definitions, headings, and table rows as prose |
| `--matched-z N` | init | Matched tolerance (default 0.5) |
| `--close-z N` | init | Close tolerance (default 1.0) |
| `--only IDS` | init | Comma-separated metric ids to include |
| `--skip IDS` | init | Comma-separated metric ids to exclude |
| `--timeout N` | init | Analysis timeout in seconds (default 1800) |
| `--humanizer-report PATH` | compare | Attach the humanizer detection report |
| `--iteration N` | compare | Override the auto-incremented iteration |
| `--previous-panel PATH` | compare | Override the previous target panel JSON |
| `--previous-target PATH` | compare | Label the previous target file |
| `--force` | init / compare | Overwrite an initialized workdir or an existing comparison |
| `--verbose` | init / compare | Show analysis commands and logs |

`style-align panel` lists every metric id, family, weight, and lever. Use the
ids with `--only`/`--skip` when the user wants a narrower panel.

---

## Files in the work directory

| File | Meaning |
|---|---|
| `baseline-report.md` | Phase 1 baseline profile |
| `target-iter-00.md` | Copy of the original target |
| `target-iter-NN.md` | Edited target for iteration NN |
| `comparison-00.md` | Initial target analysis (no movement) |
| `comparison-NN.md` | Post-iteration comparison: summary table (this pass), cumulative progress tables by family (baseline / original / now / change / gap closed), and the detailed per-metric ledger (baseline / before / after / change / gap / status / trajectory) |
| `comparison-NN.json` | Machine-readable comparison, including per-metric before/after fields (`gap_before`, `z_before`, `status_before`, `closure_pct`, `trajectory`) and the cumulative fields (`original`, `original_iteration`, `cumulative_change`, `gap_closed_pct`, `gap_closed_prev_pct`, `gap_closed_delta_pct`) |
| `humanizer-NN.md` | Humanizer detection report attached to the comparison |
| `raw/` | Raw stylometry JSON, Markdown, and analysis logs |
| `raw/<name>.analysis.md` | The prose-only copy actually measured (apparatus stripped); every number refers to this file |
| `state.json` | Iteration state and history; do not hand-edit unless resuming |
| `README.md` | Short workdir guide |

The original target is never modified.

---

## Presenting the result

When you present a comparison, lead with the human answer, then the numbers:

1. **What moved** since the previous iteration, and whether it moved toward the
   baseline.
2. **What is still off**, in plain language, with the top three gaps.
3. **The cumulative line**: how many metrics closed part of their gap, how many
   drifted, and the two or three largest closures (e.g. "negation 87% of its
   gap closed, sentence length 22%"). This is the number the user steers by.
4. **What the next pass would do**, and what it would cost (the coupled
   metrics).
5. **Humanizer findings** still open, and which ones the next pass would fix.
6. **The question**: another iteration, yes or no. A yes authorizes the style
   edit plan and the listed humanizer fixes.

For a paragraphing gap, say which kind it is: too few boundaries (the draft
runs paragraphs together), too many words per paragraph (the paragraphs are
thin), or too little spread (every paragraph is the same size). The number
alone does not distinguish them, and each has a different fix.

Every claim about a single metric must come from that metric's block in the
detailed ledger (before, after, change, gap before/after, status before/after,
trajectory, gap closed since iteration 00). The chat summary stays short, but
the report it names carries the full per-metric before/after line for all
metrics. When the user says "show me the report", "give me the numbers", or
asks about specific metrics, quote the ledger blocks rather than re-deriving
them.

Do not call the target "aligned" unless the selected panel is within tolerance
and the humanizer has no open high/medium findings. If the remaining gaps are
content-driven (technical terms, dialect, narrative markers), say so and do not
promise that another style pass will fix them.

---

## Limitations

- **The panel is focused, not exhaustive.** It is the length-stable,
  LLM-controllable subset from the stylometry research report. Run the
  stylometry skill separately for the full profile.
- **Length-stable is not length-proof.** The script uses fixed 1,000-word
  chunks and compares chunk means. If the baseline and target differ by more
  than about 20% in length, or if one is much shorter than 3,000 words, treat
  the comparison as noisy. For strict work, compare matched excerpts.
- **Content and genre confounds are real.** Rare words, technical terms,
  narrative markers, dialect, and repetition are driven by topic and genre as
  well as style. Do not rewrite content to move them.
- **The humanizer is an LLM pass, not a deterministic detector.** It can miss
  tells or flag intentional style. Its approval gate and guardrails still
  apply.
- **Quote detection can miss curly quotes.** Dialogue and quotation metrics may
  read zero on typographic quotes; check before targeting them.
- **Numeric constraints are hard for LLMs.** Do not trust the model's
  self-reported counts. Measure after every pass.
- **Apparatus stripping changes the numbers.** A stripped run is not comparable
  with an earlier unstripped one on the same texts. Do not carry a D from one
  to the other; re-`init` instead, and say that the new baseline is a new
  measurement when you report it.
- **Paragraph metrics depend on segmentation.** Paragraphs are blank-line
  blocks. A file with no blank lines is one paragraph, and the derived metrics
  then go `unavailable` (fewer than three blocks). If paragraph values look
  wrong, open `raw/<name>.analysis.md` and look at the block structure, not the
  source file.
- **Per-unit measures are noisy on short texts.** MTLD, paragraph-length SD,
  and sentence-length SD need a few thousand measured words to be stable. Below
  that, read them as direction only.
- **The baseline is the target, not a universal ideal.** A high or low value is
  not "good" or "bad" in isolation; it is a match or a mismatch.

---

## Example session

```
User: Align draft.md to baseline.md.

Agent: I need both paths. Is the target fiction or verse? Do you want the
standard tolerance?

User: baseline.md and draft.md. It's nonfiction. Standard.

Agent: [runs init]
        [reads baseline-report.md]
        Baseline: 24.8-word sentences, 139 words and 5.8 sentences per
        paragraph, FK 16.4, MATTR 0.80, passive 0.19, negations 0.6 per 100
        words, formality 31.
        Panel: 37 metrics. Apparatus stripped (63 footnotes, 7 headings);
        measured 13,376 of 15,995 words.
        [runs humanizer detect on target-iter-00.md]
        Humanizer: 2 high, 4 medium, 6 low findings.
        [runs compare --humanizer-report humanizer-00.md]
        Initial comparison: D 1.42; 9 matched, 6 close, 10 off.
        Top gaps: sentence length 22.6 vs 14.2; FK 10.4 vs 7.1; MATTR 0.84
        vs 0.79; contractions 0.1 vs 0.9.
        Do you want to start the first alignment iteration? I'll fix the
        approved humanizer findings in the same pass.

User: Yes, fix all humanizer findings.

Agent: [copies target-iter-00.md → target-iter-01.md]
        [applies the style edit plan: split long sentences, simplify
        vocabulary, restore contractions, repeat key terms]
        [applies the approved humanizer fixes]
        [runs humanizer detect on target-iter-01.md → humanizer-01.md]
        [runs compare --humanizer-report humanizer-01.md]
        Iteration 01: D 1.42 → 0.91.
        Moved: sentence length 22.6 → 16.8, FK 10.4 → 8.2, contractions
        0.1 → 0.7. MATTR moved the wrong way: 0.84 → 0.85; the next pass
        should repeat key terms.
        Humanizer: 1 medium finding left.
        Another iteration?

User: Yes.

...
```

---

## References

- Stylometry skill: `~/.pi/agent/skills/stylometry/SKILL.md`
- Panel research: `~/.pi/agent/skills/stylometry/evidence/style-matching-control-panel.md`
- Humanizer skill: `~/.pi/agent/skills/humanizer/SKILL.md`
- Humanizer AI tells: `~/.pi/agent/skills/humanizer/references/ai-tells.md`
- Humanizer pattern catalog: `~/.pi/agent/skills/humanizer/references/pattern-catalog.md`
