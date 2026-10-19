# Stylometric matching: an inventory of length-stable measures and the text edits that move them

**Status:** research report only. No skill code or `SKILL.md` was changed; this
report was added under `evidence/`. It is for the planned "match a draft to a
baseline" mode of the stylometry skill.

**Question.** The skill currently measures one text. The proposed mode compares a
**baseline** text with a **candidate** text and iteratively rewrites the
candidate until its stylometric profile matches the baseline. Some existing
measures are absolute counts and cannot be compared across texts of different
lengths. Others are averages, percentages, densities, or standard deviations
that can. The useful panel is further limited to measures an LLM can actually
steer by changing its output.

This report does three things:

1. Inventories every metric the skill reports and classifies its length
   behaviour.
2. Identifies the subset that is safe to compare across texts of different
   lengths.
3. For each candidate measure, describes the text operation that raises or
   lowers it, and the collateral changes that operation causes.

The short answer: **use fixed-window means and fixed-denominator
proportions/densities; drop counts, totals, extrema, whole-document
diversity ratios, unstable curve fits, labels, and confidence scores.** Even
the safe set is not perfectly length-invariant, so the matching loop should
compare equal-length windows and use the baseline's own chunk-to-chunk
variation as the tolerance.

---

## 0. Executive summary

- **More than 40 of the report's ~220 rows are absolute counts or totals.**
  They scale with document length by construction and must never be compared
  between texts of different lengths. Examples: characters, tokens, sentences,
  paragraphs, types, hapax count, TTR-type counts, BNC overused/underused
  counts, flagged repetition counts, distinct n-gram counts.
- **Whole-document measures are also length-biased**, even when they look like
  ratios: raw TTR, root TTR (Guiraud), log TTR (Herdan), HD-D, and the prosody
  pattern-diversity/repetition ratios. Raw TTR on a 1,110-word
  prefix of *Pride and Prejudice* is 0.481; on an 80,066-word prefix it is
  0.077. HD-D rises from 515 to 7,320 over the same range.
- **Fixed-window means are the safe core.** STTR, MTLD, MATTR, MSTTR, Yule's K,
  hapax ratio, and all chunk-mean readability scores are stable once the text
  is at least a few thousand words. The skill's own 16-book evidence corpus
  (1.07M words, chunk size 1,000) shows correlations with document length of
  +0.05 for MATTR, +0.04 for MTLD, +0.09 for MSTTR, and -0.10 for hapax ratio.
  The exceptions are the measures that ignore chunking: HD-D correlates +0.94
  with length, and vocd-D +0.47.
- **The controllable panel is much smaller than the metric list.** Roughly 20
  measures in eight families carry almost all the useful signal: sentence
  geometry, word weight, readability, lexical diversity/repetition,
  vocabulary sophistication, POS/verb style, clause architecture, and
  punctuation/marker habits. Most remaining metrics are either redundant with
  these (the syllable-based readability formulas correlate 0.92-0.99) or
  composites that follow automatically.
- **Every strong lever has collateral effects.** Sentence splitting lowers
  Flesch-Kincaid, Fog, ARI, and Coleman-Liau simultaneously. Nominalization
  raises noun ratio and formality but lowers verb ratio and readability ease.
  Synonym substitution raises MATTR/MTLD but also raises rare-word ratio and
  often syllable count. Matching therefore needs a priority order and a
  measurement loop, not a one-shot prompt.
- **LLMs have a default rewriting bias that must be counter-steered.** A large
  paired study of 60,786 human texts and AI rewrites found that rewriting
  reliably makes text lexically heavier and more formal: longer words
  (d = 1.57 for 7+ letter words), more nominalizations (d = 1.12), higher
  MATTR (d = 1.31), more passive voice, more commas, fewer first-person
  pronouns, fewer contractions, fewer questions, and flatter sentence-length
  variation. If the baseline is lighter or more personal, the model's default
  pass will overshoot in the wrong direction.
- **LLMs are poor at numeric constraints.** A 2026 benchmark found performance
  drops as numeric constraints get stricter. The loop must measure externally
  after each pass, not trust the model's self-reported compliance.

### 0.1 One-page answer

**Safe to compare across lengths** (same chunk/window settings; both texts at
least ~3,000 words, ideally 5,000+):

- **Sentence geometry**: mean sentence length, sentence-length SD, sentence
  length alternation, sentence rhythm.
- **Word geometry**: mean syllables per word, average word length,
  polysyllabic/monosyllabic ratios, syllable CV.
- **Readability**: Flesch-Kincaid, Dale-Chall, FORCAST; SMOG, Fog, ARI,
  Coleman-Liau and Linsear as confirmation.
- **Diversity/repetition**: MATTR, MTLD, MSTTR, STTR, Yule's K, hapax ratio.
- **Vocabulary**: rare/common/academic/advanced word ratios, mean/median
  frequency rank.
- **POS**: noun, verb, adjective, adverb ratios; noun-verb ratio; lexical
  density; determiner/preposition/conjunction/pronoun/auxiliary ratios.
- **Syntax**: passive ratio, clausal density, dependent-clause ratio,
  subordination/coordination indices, mean parse depth, mean dependency
  distance, simple/compound/complex ratios, sentence-type ratios.
- **Markers**: contraction ratio; intensifier, hedge, modal, negation,
  exclamation, question, parenthetical, ellipsis, dash, semicolon, colon
  densities.
- **Register**: Latinate ratio, nominalization density, first/second/third
  person ratios, impersonal density, abstract/concrete noun ratios, narrative
  and expository marker densities, formality score (summary only).
- **Cohesion**: pronoun/demonstrative/connective densities, word repetition
  ratio, content-word overlap, paragraph topic consistency, mean paragraph
  length.
- **Prosody**: syllable ratios, alliteration/assonance/consonance densities,
  sentence-length alternation, sentence rhythm, starting/ending pattern
  repetition.
- **Extras**: flagged words per 10,000, flagged n-grams per 10,000.

**Not safe for cross-length matching:**

- All counts and totals: characters, tokens, sentences, paragraphs, types,
  chunks, hapax count, dislegomena count, n-gram counts, BNC counts, flagged
  counts, content words.
- All extrema: max/min/range sentence length, max parse depth.
- Whole-document diversity: raw TTR, root TTR, log TTR, HD-D (as implemented),
  pattern diversity ratio, pattern repetition ratio.
- Unstable or saturating estimators: vocd-D, punctuation variety, structural
  and functional diversity entropy, pattern entropy, anaphora resolution
  ratio, discourse structure score, dialect/genre/drift confidence.
- Labels: register, predicted genre, dialect, drift pattern, Flesch band,
  Dale-Chall grade, Fry zone.
- Composites as direct targets: formality, genre scores, semantic coherence,
  sentence complexity, average grade. Target their components instead.

**Quick decision rule.** If the denominator is words, sentences, tokens, or a
fixed window, and the value is a proportion, density, mean, or standard
deviation, it is probably safe. If the value is a count, a max/min, or a ratio
of unique types to total tokens, it is not. If the value is a label or a
confidence score, it is not a target.

---

## 1. How the skill computes values (and why aggregation matters)

All metrics come from `pystylometry` at a fixed `chunk_size` (default 1,000
words). The aggregation rule determines whether a metric survives a
cross-length comparison.

| Aggregation | What the reported number is | Length behaviour | Examples |
|---|---|---|---|
| **Whole-document measure** | One ratio or estimator over the entire text | Biased: denominators grow faster than numerators | Raw TTR, root TTR, log TTR, HD-D |
| **Fixed-window mean** | Mean of per-chunk values, each computed on the same window size | Stable if both texts have at least one full window and settings match | MTLD, Yule's K, hapax ratio, STTR, readability scores, character metrics |
| **Fixed-denominator proportion/density** | Count divided by words, sentences, or tokens over the whole text | Stable in expectation; noise falls as length grows | Function-word ratios, POS ratios, marker densities, punctuation density, syllable ratios |
| **Single-pass mean over units** | Mean over all sentences/words/paragraphs | Stable in expectation; noisy for short texts | Mean sentence length, sentence-length SD, dependency distance, paragraph length |
| **Absolute count/total** | Sum or count | Grows with length by construction | Types, tokens, sentences, paragraphs, hapax count, BNC counts, flagged counts |
| **Extreme** | Max, min, range | Grows with length (more chances to see an extreme) | Max sentence length, min sentence length, sentence-length range, max parse depth |
| **Sample-size-sensitive estimator** | Entropy, curve fit, saturating variety count, confidence | Biased or unstable at small N | N-gram entropy, vocd-D, punctuation variety, structural diversity, pattern entropy |
| **Composite/label** | Weighted sum or category | Categorical or composite; not a clean target | Formality score, genre scores, average grade, register label, drift pattern |

### 1.1 The chunking caveat

A fixed-window mean is only comparable when the window size is identical.
`MATTR` uses a 50-word moving window, `MSTTR` 100-word segments, `MTLD` a 0.72
TTR threshold within 1,000-word chunks, and most other metrics 1,000-word
chunks. Changing `--chunk-size` changes the values. The matching loop must pin
`chunk_size=1000`, `window_size=50`, `segment_size=100`, and the MTLD threshold
(0.72) for both texts.

A text shorter than one chunk is a special case: the "chunk mean" is computed
on a partial chunk, so it is biased toward the values of a short sample.
**Do not run the matching loop on texts shorter than about 3,000 words.** Five
thousand words is better; ten thousand is comfortable. If the baseline is long
and the candidate is short, compare equal-length windows, not the whole
documents.

### 1.2 Reported metric vs raw metric

Some report rows are rounded or transformed versions of the underlying value.
The JSON output (`--json`) contains the full dataclasses, including each
metric's per-chunk `Distribution` (mean, median, std, range, IQR, values). The
matching loop should read the JSON, not scrape the markdown table. For example,
`Flesch difficulty band`, `Dale-Chall grade`, and `Register classification`
are labels derived from the numeric values; target the number, not the label.

---

## 2. Which measures survive a cross-length comparison?

### 2.1 Empirical evidence from the skill's own corpus

`evidence/measurements.json` contains 16 public-domain books (1,069,146 words)
measured at chunk size 1,000. Correlating each book's document mean with its
word count gives a direct check on length dependence:

| Metric | Spearman rho with book length | Aggregation | Verdict |
|---|---:|---|---|
| HD-D | **+0.94** | whole text, no chunking | exclude |
| vocd-D | **+0.47** | whole text curve fit | exclude |
| Yule's K | -0.33 | per-chunk mean | usable (mild trend) |
| Flesch reading ease | -0.14 | per-chunk mean | usable |
| Advanced word ratio | +0.13 | whole text proportion | usable |
| Rare word ratio | +0.13 | whole text proportion | usable |
| Raw TTR (per-chunk series in this corpus) | +0.14 | per-chunk mean | usable at fixed chunk size |
| MSTTR | +0.09 | whole text, fixed segments | usable |
| Flesch-Kincaid grade | +0.07 | per-chunk mean | usable |
| Gunning Fog | +0.07 | per-chunk mean | usable |
| MATTR | +0.05 | whole text, fixed window | usable |
| MTLD | +0.04 | per-chunk mean | usable |
| Dale-Chall | -0.02 | per-chunk mean | usable |
| Hapax ratio | -0.10 | per-chunk mean | usable |

The important contrast is **HD-D versus MATTR/MTLD**. HD-D is the one lexical
measure in the set that ignores chunking and uses the full text length; it
grows monotonically and substantially with the document. MATTR and MTLD are
computed on fixed windows/chunks and are essentially uncorrelated with length. This is not a
claim that MATTR/MTLD are perfect; it is a claim that their fixed-window
construction removes the dominant length effect.

One row needs a note: the evidence corpus stored `ttr_raw` as a *per-chunk*
series, so its +0.14 is the correlation for the mean per-chunk TTR, not for
the report's whole-document raw TTR. The report's raw TTR is the whole-document
ratio and is strongly length-biased (see the prefix table below).

These are cross-book associations, so they mix length with genre, topic, and
period. The near-zero values are evidence that a measure is not mechanically
length-driven; they do not prove perfect invariance. The Yule's K value
(-0.33) is the largest among the chunk-based measures and may reflect genre or
content rather than length, but it is a reminder that even chunk-based measures
are not perfectly invariant.

### 2.2 Original prefix check on *Pride and Prejudice*

To see the direction and size of the bias, the installed library was run on
prefixes of *Pride and Prejudice* (Project Gutenberg 1342), cut at paragraph
boundaries. The prefix design confounds length with content (later chapters
are different), so it is illustrative, not a controlled experiment. It shows
which measures are mechanically length-driven.

| Metric | 1,110 words | 3,241 | 5,021 | 10,006 | 20,032 | 40,070 | 80,066 | 80k / 20k |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Raw TTR | 0.481 | 0.346 | 0.322 | 0.226 | 0.159 | 0.114 | 0.077 | 0.48 |
| Root TTR | 16.02 | 19.71 | 22.87 | 22.60 | 22.55 | 22.76 | 21.74 | 0.96 |
| Log TTR | 0.896 | 0.869 | 0.867 | 0.838 | 0.815 | 0.795 | 0.773 | 0.95 |
| STTR | n/a | 0.467 | 0.474 | 0.434 | 0.425 | 0.426 | 0.425 | 1.00 |
| MTLD | 80.70 | 72.77 | 60.64 | 58.49 | 65.04 | 68.60 | 73.31 | 1.13 |
| Yule's K | 133.2 | 140.8 | 155.2 | 132.0 | 139.6 | 140.5 | 130.6 | 0.94 |
| Hapax ratio | 0.464 | 0.337 | 0.384 | 0.325 | 0.270 | 0.254 | 0.255 | 0.95 |
| Hapax count | 445 | 1,152 | 1,782 | 3,046 | 5,895 | 11,865 | 23,639 | 4.01 |
| MATTR | 0.825 | 0.817 | 0.818 | 0.826 | 0.835 | 0.835 | 0.835 | 1.00 |
| MSTTR | 0.740 | 0.733 | 0.736 | 0.739 | 0.749 | 0.747 | 0.746 | 1.00 |
| HD-D | 514.6 | 1,139 | 1,711 | 2,507 | 3,706 | 5,350 | 7,320 | 1.98 |
| vocd-D | 4.90 | 4.92 | 4.96 | 5.00 | 5.03 | 5.00 | 4.99 | 0.99 |
| Rare word ratio | 0.415 | 0.369 | 0.394 | 0.364 | 0.350 | 0.346 | 0.335 | 0.96 |
| Flesch-Kincaid grade | 18.98 | 14.88 | 12.73 | 10.52 | 9.68 | 10.41 | 10.51 | 1.09 |
| Dale-Chall | 10.94 | 10.13 | 9.79 | 9.05 | 8.68 | 8.83 | 8.74 | 1.01 |
| Word bigram entropy | 8.37 | 9.40 | 8.95 | 9.15 | 9.54 | 9.68 | 9.74 | 1.02 |

Read this table for the shape, not the exact values:

- **Raw TTR collapses** by a factor of six from 1k to 80k. Root and log TTR
  decline slowly but still move; root TTR moves 4% from 20k to 80k.
- **Hapax count grows linearly** with length. The ratio is stable after about
  3k words.
- **HD-D grows monotonically and substantially** and has no plateau; it is not
  usable across lengths.
- **MATTR, MSTTR, Yule's K, and hapax ratio are essentially flat** after about
  3k words; STTR settles after about 10k in this text. MTLD wanders by 10-20%
  because it is a mean of integer factor lengths and is sensitive to content and
  word order, not because it has a strong length trend.
- **Readability changes at short lengths** mostly because the opening chapters
  have a different mix of sentence lengths and vocabulary (long narrative
  sentences alongside short dialogue), not because the formulas are
  length-biased. At 10k and above the values are within about a grade of each
  other; below that, content and sample size both matter. This is a content
  confound, not a pure length effect.
- **Word bigram entropy rises slightly** in this prefix design because later
  chapters have different collocations. At a fixed 1,000-word chunk the
  estimator bias is constant; the rise here is content. For texts shorter than
  one chunk, the downward sample-size bias adds a real length effect (see
  §2.4).

### 2.3 The theoretical view

Tweedie and Baayen (1998) tested the classic "constants" of lexical richness
and found that almost all of them vary systematically with text length. In
their Monte Carlo analysis, only Yule's K was constant across all text
lengths; Honoré's R, Sichel's S, and some LNRE parameters were approximately
constant only above a minimum N. In real prose, even the theoretically
constant measures can deviate because word use is not random. Their
recommendation is not to compare a single constant across texts of very
different lengths, but to compare **developmental profiles** (the trajectory of
the measure as the text grows) or to use confidence intervals from
randomisation.

For this project the practical translation is:

- Do not compare whole-document diversity ratios across lengths.
- Prefer fixed-window means, which are the closest practical analogue of a
  developmental profile: each window is measured at the same N.
- When the texts differ in length, either compare equal-length windows or
  compare the *distribution* of per-chunk values, not just the document mean.
- Treat a single mean as a noisy estimate; use the chunk SD or a bootstrap CI
  as the tolerance.

### 2.4 Entropy and other sample-size-sensitive estimators

`pystylometry` computes n-gram entropy with the plug-in estimator
`H = -Σ p log2 p` on each chunk or window. The plug-in estimator is biased
downward at small N; the leading correction is the Miller-Madow term
`(K - 1) / (2N)`, where K is the number of observed distinct n-grams. At a fixed
1,000-word chunk the bias is constant, so two long texts are comparable. A text
shorter than one chunk has a larger downward bias, and a text with a much
smaller vocabulary will have a smaller K and less bias. Do not interpret a
small entropy difference between a long and a short text as a style difference
unless the window sizes are equal.

The same caution applies to:

- **Standard deviations of per-unit values** (sentence length, syllables per
  word, paragraph length): they are usable ratios, but a short sample
  underestimates the population SD. Use them as targets only when both texts
  contain at least ~100 sentences.
- **vocd-D**: a curve fit with random sampling; unstable on short texts and
  capable of a negative R². The skill already flags this.
- **Punctuation variety**: a count of distinct punctuation types; it saturates
  at the size of the punctuation inventory and is not a smooth style measure.
- **Structural/functional diversity**: Shannon entropy over four categories;
  with four bins the maximum is 2 bits, and small samples bias it downward.
- **Prosody pattern entropy and pattern diversity/repetition ratios**: these
  are type-token statistics over sentence syllable patterns; the unique/total
  ratio declines with length.
- **Dialect/genre/drift confidence scores**: these are functions of evidence
  quantity, not only of style.
- **BNC overuse/underuse**: the expected count is `relative_frequency ×
  total_tokens`, so the *number* of overused words grows with length even when
  the style is unchanged. Only the ratio (observed/expected) is
  length-stable.

---

## 3. Full inventory by category

**Class codes**

| Code | Meaning |
|---|---|
| `abs` | absolute count/total; grows with length |
| `doc` | whole-document ratio with length bias |
| `ext` | extreme value (max/min/range); grows with length |
| `ratio` | proportion/density/mean over a fixed denominator; length-stable in expectation |
| `win` | fixed-window/chunk mean; length-stable if settings match |
| `est` | sample-size-sensitive estimator or saturating count |
| `cat` | categorical label or confidence |
| `X` | composite/derived/redundant |

**Control codes**

| Code | Meaning |
|---|---|
| `D` | Direct: a local text edit moves it predictably |
| `I` | Indirect: requires global paraphrase or word choice |
| `O` | Opaque: not reliably steerable, or not worth steering |

**Verdicts**

- **Target** — include in the matching panel.
- **Confirm** — useful secondary check, usually correlated with a target.
- **Monitor** — inspect for context, do not optimise.
- **Exclude** — do not compare across lengths or do not target.

### 3.1 Text summary

| Metric | Class | Ctrl | Verdict | Note |
|---|---|---|---|---|
| Characters | abs | O | Exclude | Fixed by content and length |
| Tokens (whitespace) | abs | O | Exclude | Length |
| Sentences (segmenter) | abs | O | Exclude | Length |
| Paragraphs (segmenter) | abs | D | Monitor | Compare mean paragraph length instead |
| Types (distinct words) | abs | O | Exclude | Length |
| Title / Author / Year / Genre / Source file | meta | — | Ignore | Provenance only |
| Chunk size | config | — | Fix | Must be identical |
| Generated | meta | — | Ignore | — |

### 3.2 Lexical

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Raw TTR | doc | I | Exclude | Falls with length; use MATTR/STTR |
| Root TTR (Guiraud) | doc | I | Exclude | Less steep, still length-biased |
| Log TTR (Herdan C) | doc | I | Exclude | Slow decline with length |
| STTR | win | I | Target | Up: more new types per 1,000-word chunk. Down: recycle vocabulary. Needs ≥2,000 words |
| Delta std | est | O | Monitor | Chunk-to-chunk TTR volatility; noisy with few chunks |
| Types | abs | O | Exclude | Length |
| Tokens (analysed) | abs | O | Exclude | Length |
| Chunks | abs | O | Exclude | Length |
| MTLD forward | win | I | Target | Up: vary content words, spread new types evenly. Down: repeat key words, cluster repeats |
| MTLD backward | win | I | Confirm | Same construct, reverse pass |
| MTLD average | win | I | Target | Primary MTLD number |
| Yule's K | win | I | Target | Up: repeat a few content words (m² weighting). Down: remove tics and refrains |
| Yule's I | win | I | Confirm | Inverse of K; redundant |
| Hapax count | abs | O | Exclude | Length |
| Hapax ratio | win | I | Confirm | Up: one-off words. Down: recycle vocabulary. Chunk-size dependent |
| Dislegomena count | abs | O | Exclude | Length |
| Dislegomena ratio | win | I | Monitor | Weak and hard to steer |
| Sichel's S | win | O | Monitor | Weak discriminator in the literature |
| Honoré's R | win | O | Monitor | Mostly inverse hapax; redundant |
| Function word ratio | ratio | I | Target | Up: grammatical words (determiners, prepositions, auxiliaries). Down: content words |
| Function word diversity | doc | O | Exclude | Unique/total function words; numerator saturates while denominator grows, so it declines with length |
| Determiner ratio | ratio | D | Target | Up: articles with every noun. Down: bare plurals, pronouns, proper names |
| Preposition ratio | ratio | D | Target | Up: explicit prepositional phrases. Down: verb-particle and possessive constructions |
| Conjunction ratio | ratio | D | Target | Up: and/but/because/although. Down: parataxis |
| Pronoun ratio | ratio | D | Target | Up: first/second person and dialogue. Down: repeated full noun phrases |
| Auxiliary ratio | ratio | D | Target | Up: passive/progressive/modal constructions. Down: simple present/past |
| Particle ratio | ratio | O | Monitor | Phrasal verbs; topic-dependent |
| vocd-D parameter | est | O | Exclude | Unstable curve fit; +0.47 with length in the 16-book corpus; negative R² on *Hound* |
| vocd-D curve fit R² | est | O | Exclude | Diagnostic only |
| MATTR | win | I | Target (primary) | Up: synonyms, paraphrase, new types within 50-word windows. Down: repeat words within windows |
| MATTR std dev | win | I | Confirm | Up: uneven local diversity. Down: even |
| MATTR window size | config | — | Fix | Must be identical |
| MSTTR | win | I | Confirm | Same as MATTR at 100-word segments; correlated 0.92 |
| MSTTR std dev | win | I | Monitor | — |
| MSTTR segment size | config | — | Fix | Must be identical |
| HD-D | doc | O | Exclude | Grows with N; +0.94 across 16 books; not length-invariant in this implementation |
| Mean frequency rank | ratio | I | Target | Up: rarer words. Down: common words |
| Median frequency rank | ratio | I | Confirm | Robust version of mean rank |
| Rare word ratio | ratio | I | Target | Up: words beyond COCA rank 10,000. Down: everyday vocabulary |
| Common word ratio | ratio | I | Confirm | Inverse of rare; redundant |
| Academic word ratio | ratio | I | Monitor | Only useful if the baseline genre is academic |
| Advanced word ratio | ratio | I | Confirm | Union of rare and academic; redundant with rare |
| Word class labels | abs/cat | O | Exclude | Count of labels |
| Non-lexical surface forms | abs | O | Exclude | Count |
| Largest non-lexical class | cat | O | Exclude | — |

### 3.3 Readability

All readability values are per-chunk means (class `win`). They are safe across
lengths at fixed chunk size, but the family is highly redundant: the formulas
are functions of the same two variables, sentence length and a word-difficulty
proxy, and correlate 0.92-0.99 with each other. Keep Flesch-Kincaid and
Dale-Chall as the two non-duplicative targets; use the others as confirmation.

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Flesch reading ease | win | D | Target | Up: split sentences, shorter words. Down: merge sentences, polysyllables |
| Flesch-Kincaid grade | win | D | Target (primary) | Up: longer sentences and more syllables per word. Down: split and simplify |
| Flesch difficulty band | cat | O | Exclude | Label derived from ease |
| SMOG index | win | D | Confirm | Up: polysyllables per sentence. Down: split sentences and simplify vocabulary |
| SMOG grade | win | D | Confirm | Same |
| Gunning Fog index | win | D | Target | Up: sentence length plus 3+ syllable words. Down: split and simplify |
| Gunning Fog grade | win | D | Confirm | Same |
| Coleman-Liau index | win | D | Confirm | Up: letters per word and sentence length. Down: shorter words and sentences |
| Coleman-Liau grade | win | D | Confirm | Same |
| ARI score | win | D | Confirm | Up: characters per word and sentence length. Down: shorter words and sentences |
| ARI grade | win | D | Confirm | Same |
| Fry grade | cat | O | Monitor | Discrete chart zone |
| Fry syllables per 100 words | win | D | Target | Up: polysyllables. Down: monosyllables |
| FORCAST score | win | D | Target | Up: fewer monosyllables (more polysyllables). Down: more monosyllables. No sentence-length term |
| FORCAST grade | win | D | Confirm | Same |
| Powers-Sumner-Kearl score | win | D | Monitor | Mostly sentence length in this implementation; redundant |
| Powers-Sumner-Kearl grade | win | D | Monitor | Same |
| Dale-Chall score | win | D | Target (primary) | Up: unfamiliar words and long sentences. Down: familiar words and shorter sentences |
| Dale-Chall difficult word ratio | win | D | Target (primary) | Up: words outside the Dale-Chall 3,000 familiar list. Down: everyday words |
| Dale-Chall grade | cat | O | Monitor | Label derived from score |
| Linsear Write score | win | D | Confirm | Up: 3+ syllable words per sentence. Down: easy words and shorter sentences |
| Linsear Write grade | win | D | Confirm | Same |
| Average grade level | X | O | Monitor | Composite summary only |

### 3.4 Syntactic

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Noun ratio | ratio | D | Target | Up: nominalizations, noun phrases. Down: verbs, pronouns, dialogue |
| Verb ratio | ratio | D | Target | Up: finite/active verbs. Down: nominalize |
| Adjective ratio | ratio | D | Target | Up: attributive adjectives. Down: concrete nouns and verbs |
| Adverb ratio | ratio | D | Target | Up: -ly and degree adverbs. Down: strong verbs |
| Noun-verb ratio | ratio | D | Target | Up: nominal style. Down: verbal style |
| Adjective-noun ratio | ratio | D | Target | Up: modifiers per noun. Down: bare nouns |
| Lexical density | ratio | D | Target | Up: content POS. Down: function words |
| POS function word ratio | ratio | D | Target | Up: DET+ADP+CONJ. Down: content words |
| Sentence count | abs | O | Exclude | Length |
| Mean sentence length (words) | ratio | D | Target (primary) | Up: merge sentences, add clauses. Down: split at clause boundaries |
| Sentence length std dev | ratio | D | Target (primary) | Up: mix very short and long sentences. Down: homogenize lengths |
| Min sentence length | ext | O | Exclude | Length-sensitive extreme |
| Max sentence length | ext | O | Exclude | Length-sensitive extreme |
| Sentence length range | ext | O | Exclude | Length-sensitive extreme |
| Mean parse tree depth | ratio | D | Target | Up: relative clauses, participial phrases, nested PPs. Down: flatten to SVO |
| Max parse tree depth | ext | O | Exclude | Length-sensitive extreme |
| T-unit count | abs | O | Exclude | Length |
| Mean T-unit length (words) | ratio | D | Confirm | Up: modifiers inside the clause. Down: shorter clauses |
| Clausal density | ratio | D | Target | Up: more clauses per T-unit. Down: simple sentences |
| Dependent clause ratio | ratio | D | Target | Up: because/although/which/when clauses. Down: parataxis |
| Passive voice ratio | ratio | D | Target | Up: be/get + past participle. Down: active voice |
| Subordination index | ratio | D | Confirm | Up: subordinate conjunctions. Down: coordination |
| Coordination index | ratio | D | Confirm | Up: and/but/or clauses. Down: subordination |
| Sentence complexity score | X | D | Confirm | Composite of depth, clausal density, T-unit length, subordination, dependency distance |
| Dependency distance | ratio | D | Target (optional) | Up: postposed modifiers, parentheticals. Down: canonical adjacent SVO |
| Left branching ratio | ratio | D | Monitor | Up: premodifiers. Down: postmodifiers |
| Right branching ratio | ratio | D | Monitor | Inverse of left branching |
| Simple sentence ratio | ratio | D | Target | Up: simple sentences. Down: combine clauses |
| Compound sentence ratio | ratio | D | Confirm | Up: coordinated independent clauses. Down: simple |
| Complex sentence ratio | ratio | D | Confirm | Up: dependent clauses. Down: simple |
| Compound-complex sentence ratio | ratio | D | Confirm | Up: both. Down: simple |
| Simple/compound/complex counts | abs | O | Exclude | Length |
| Declarative ratio | ratio | D | Target | Up: statements. Down: questions/imperatives |
| Interrogative ratio | ratio | D | Target | Up: questions. Down: statements |
| Imperative ratio | ratio | D | Target | Up: commands. Down: statements |
| Exclamatory ratio | ratio | D | Target | Up: exclamations. Down: statements |
| Sentence-type counts | abs | O | Exclude | Length |
| Structural diversity (entropy) | est | I | Monitor | Up: mix four structural types. Down: one type. Four bins, small-sample bias |
| Functional diversity (entropy) | est | I | Monitor | Up: mix declarative/question/imperative/exclamatory. Down: all declarative |
| Sentences classified | abs | O | Exclude | Length |

### 3.5 Character-level

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Average word length (chars) | ratio | D | Target | Up: longer words. Down: shorter words |
| Average sentence length (chars) | ratio | D | Confirm | Up: longer sentences or longer words. Down: either |
| Punctuation density (per 100 words) | ratio | D | Target | Up: commas, semicolons, dashes, quotes. Down: strip punctuation |
| Punctuation variety | est | O | Monitor | Unique punctuation types; saturates |
| Vowel-consonant ratio | ratio | O | Monitor | Weak; word choice |
| Digit count | abs | O | Exclude | Length |
| Digit ratio | ratio | D | Monitor | Up: digits. Down: spelled numbers |
| Uppercase ratio | ratio | D | Monitor | Up: proper nouns, acronyms, caps. Down: lowercase |
| Whitespace ratio | ratio | O | Monitor | Word/paragraph length; weak |
| Most frequent letter | cat | O | Exclude | — |

### 3.6 N-grams

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Character bigram entropy | win/est | I | Confirm | Up: orthographic variety, longer words. Down: repeated morphology |
| Character bigram perplexity | X | O | Exclude | 2^H; redundant |
| Word bigram entropy | win/est | I | Target | Up: varied collocations. Down: formulaic pairs |
| Word bigram perplexity | X | O | Exclude | 2^H; redundant |
| Word trigram entropy | win/est | I | Confirm | Up: varied 3-word patterns. Down: catchphrases |
| Word 4-gram entropy | win/est | I | Monitor | Sparse; noisy |
| Character trigram entropy | win/est | I | Monitor | — |
| Character 4-gram entropy | win/est | I | Monitor | — |
| POS trigram entropy | win/est | I | Target | Up: varied syntactic patterns. Down: repetitive clause templates |
| Distinct word trigrams | abs | O | Exclude | Length |
| Distinct word 4-grams | abs | O | Exclude | Length |
| Top word trigram | abs/cat | O | Exclude | Length and content |

### 3.7 Style markers

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Contraction ratio | ratio | D | Target | Up: don't/I'm/it's. Down: do not/I am/it is |
| Contraction count | abs | O | Exclude | Length |
| Expanded form count | abs | O | Exclude | Length |
| Intensifier density (per 100 words) | ratio | D | Target | Up: very/really/extremely/quite. Down: remove |
| Intensifier count | abs | O | Exclude | Length |
| Hedging density (per 100 words) | ratio | D | Target | Up: maybe/perhaps/about/roughly. Down: assertive |
| Hedging count | abs | O | Exclude | Length |
| Modal density (per 100 words) | ratio | D | Target | Up: can/could/may/might/must/should/will/would. Down: remove |
| Epistemic modal ratio | ratio | D | Target | Up: may/might/could. Down: must/should/can |
| Deontic modal ratio | ratio | D | Confirm | Overlapping category; can sum above 1 with epistemic |
| Negation density (per 100 words) | ratio | D | Target | Up: not/never/no/none/neither/n't. Down: affirmative |
| Negation count | abs | O | Exclude | Length |
| Exclamation density | ratio | D | Target | Up: `!`. Down: remove |
| Question density | ratio | D | Target | Up: `?`. Down: statements |
| Quotation density | ratio | D | Monitor | Quote detection misses curly quotes; verify before targeting |
| Parenthetical density | ratio | D | Target | Up: parentheses. Down: remove |
| Ellipsis density | ratio | D | Target | Up: `...`. Down: remove |
| Dash density | ratio | D | Target | Up: dashes. Down: remove |
| Semicolon density | ratio | D | Target | Up: semicolons. Down: commas/periods |
| Colon density | ratio | D | Target | Up: colons. Down: remove |

### 3.8 Genre and register

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Register classification | cat | O | Exclude | Label; can disagree with formality score |
| Predicted genre | cat | O | Exclude | Label |
| Genre confidence | est | O | Exclude | Evidence quantity, not style |
| Formality score | X | D/I | Target (composite) | Up: Latinate, nominalization, passive, no first person/conversational markers. Down: reverse. Inspect components when it deviates |
| Latinate ratio | ratio | I | Target | Up: commence/utilize/demonstrate. Down: start/use/show |
| Nominalization density | ratio | D | Target (primary) | Up: -tion/-sion/-ment/-ness/-ity. Down: verbs |
| Passive voice density | ratio | D | Confirm | Same family as passive ratio; different implementation |
| First person ratio | ratio | D | Target | Up: I/we. Down: third person/impersonal |
| Second person ratio | ratio | D | Confirm | Up: you. Down: third person |
| Third person ratio | ratio | D | Confirm | Up: he/she/they/it. Down: first/second |
| Impersonal construction density | ratio | D | Target | Up: "it is", "there is", "one must". Down: personal subjects |
| Abstract noun ratio | ratio | I | Target | Up: abstract nouns. Down: concrete nouns |
| Concrete noun ratio | ratio | I | Confirm | Inverse |
| Abstractness score | X | O | Monitor | Composite |
| Technical term density | ratio | I | Monitor | Up: jargon. Down: plain terms. Genre-specific |
| Narrative marker density | ratio | D | Target | Up: then/later/suddenly/meanwhile. Down: remove |
| Expository marker density | ratio | D | Target | Up: however/therefore/for example. Down: remove |
| Dialogue ratio | ratio | D | Monitor | Up: quoted speech. Down: narration. Quote detection caveat |
| Fiction score | X | O | Monitor | Composite |
| Academic score | X | O | Monitor | Composite |
| Journalistic score | X | O | Monitor | Composite |
| Legal score | X | O | Monitor | Composite |
| Conversational score | X | O | Monitor | Composite |

### 3.9 Dialect

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Dialect | cat | O | Exclude | Label |
| Dialect confidence | cat | O | Exclude | Evidence quantity |
| British score | ratio | D | Target if dialect match | Up: -our/-ise/-re, British lexis. Down: American forms |
| American score | ratio | D | Target if dialect match | Up: -or/-ize/-er, American lexis. Down: British forms |
| Markedness score | ratio | O | Monitor | Strength of evidence |
| Eye dialect count | abs | O | Exclude | Length |
| Eye dialect ratio (per 1,000 words) | ratio | D | Target if dialect match | Up: respellings. Down: standard spelling |
| Dialect chunks | abs | O | Exclude | Length |
| Dialect chunk size | config | — | Fix | Must be identical |
| British/American score std dev | ratio | O | Monitor | Consistency across chunks |

### 3.10 Drift

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Status | cat | O | Exclude | Label |
| Pattern | cat | O | Exclude | Label |
| Pattern confidence | est | O | Exclude | Window count |
| Mean chi-squared | win* | O | Monitor | Up: vary style between windows. Down: keep uniform. Compare only at same window size/top-N |
| Std chi-squared | win* | O | Monitor | Up: uneven drift. Down: even |
| Max chi-squared | ext | O | Exclude | Extreme |
| Min chi-squared | ext | O | Exclude | Extreme |
| Trend slope | win* | O | Monitor | Up: later windows more different. Down: uniform |
| Drift windows | abs | O | Exclude | Length |
| Drift window size | config | — | Fix | Must be identical |
| Drift stride | config | — | Fix | Must be identical |
| Drift overlap ratio | config | — | Fix | Must be identical |

### 3.11 Prosody

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Mean syllables per word | ratio | D | Target | Up: polysyllabic words. Down: monosyllabic words |
| Syllable std dev | ratio | I | Confirm | Up: mix word lengths. Down: uniform |
| Rhythmic regularity | ratio | I | Confirm | Up: uniform syllable counts. Down: mix |
| Syllable CV | ratio | I | Confirm | Inverse of regularity |
| Stress pattern entropy | est | I | Monitor | Up: varied stress patterns. Down: uniform |
| Polysyllabic ratio | ratio | D | Target | Up: 3+ syllable words. Down: short words |
| Monosyllabic ratio | ratio | D | Confirm | Inverse |
| Alliteration density | ratio | D | Target if verse | Up: same initial consonants. Down: vary |
| Assonance density | ratio | D | Target if verse | Up: same vowel sounds. Down: vary |
| Consonance density | ratio | D | Target if verse | Up: same final consonants. Down: vary |
| Sentence length alternation | ratio | D | Target | Up: alternate long and short sentences. Down: uniform |
| Sentence rhythm score | X | D | Confirm | Composite |
| Iambic ratio | ratio | I | Monitor | Up: iambic word choices. Down: trochaic |
| Trochaic ratio | ratio | I | Monitor | Inverse |
| Sentences analysed | abs | O | Exclude | Length |
| Std syllables per sentence | ratio | I | Confirm | Up: vary sentence/word lengths. Down: uniform |
| Sentence syllable CV | ratio | I | Confirm | Same |
| Mean sentence complexity | ratio | I | Monitor | Composite |
| Std sentence complexity | ratio | I | Target | Up: vary complexity. Down: uniform |
| Complexity uniformity score | X | I | Target | Up: uniform (AI-like). Down: vary |
| Syllable patterns unique | abs | O | Exclude | Length |
| Syllable patterns instances | abs | O | Exclude | Length |
| Pattern diversity ratio | doc | O | Exclude | Unique/total; declines with length |
| Repeated pattern count | abs | O | Exclude | Length |
| Repetition ratio | doc | O | Exclude | Repeated/total; length-biased |
| Pattern entropy | est | O | Monitor | Sample-size-sensitive |
| Starting pattern repetition | ratio | D | Target | Up: repeat sentence openers. Down: vary |
| Ending pattern repetition | ratio | D | Target | Up: repeat endings. Down: vary |

### 3.12 Cohesion

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| Pronoun density (per 100 words) | ratio | D | Target | Up: first/second person, dialogue. Down: repeated full NPs |
| Demonstrative density (per 100 words) | ratio | D | Target | Up: this/that/these/those. Down: full NPs |
| Anaphora count | abs | O | Exclude | Length |
| Anaphora resolution ratio | ratio | O | Exclude | Near 1.0; saturated |
| Word repetition ratio | ratio | I | Target | Up: repeat content words. Down: synonyms |
| Content word overlap | ratio | I | Target | Up: repeat content words across adjacent sentences. Down: topic shift |
| Connective density (per 100 words) | ratio | D | Target | Up: however/therefore/moreover/then. Down: parataxis |
| Additive connective ratio | ratio | D | Target | Up: and/moreover/furthermore. Down: remove |
| Adversative connective ratio | ratio | D | Target | Up: but/however/yet. Down: remove |
| Causal connective ratio | ratio | D | Target | Up: because/therefore/thus. Down: remove |
| Temporal connective ratio | ratio | D | Target | Up: then/later/meanwhile. Down: remove |
| Adjacent sentence overlap | ratio | I | Confirm | Same as content word overlap |
| Mean sentence similarity | ratio | I | Confirm | Up: same vocabulary/topic. Down: varied |
| Paragraph topic consistency | ratio | I | Target | Up: one topic per paragraph. Down: mix topics |
| Semantic coherence score | X | O | Monitor | Composite |
| Discourse structure score | est | O | Monitor | Saturated heuristic |
| Paragraph count | abs | O | Exclude | Length |
| Mean paragraph length (sentences) | ratio | D | Target | Up: merge paragraphs. Down: split paragraphs |

### 3.13 Extras (BNC and repetition/slop)

| Metric | Class | Ctrl | Verdict | How to move it |
|---|---|---|---|---|
| BNC total tokens | abs | O | Exclude | Length |
| BNC unique tokens | abs | O | Exclude | Length |
| BNC overused words | abs | O | Exclude | Count; length-dependent |
| BNC underused words | abs | O | Exclude | Count; length-dependent |
| Words not in BNC | abs | O | Exclude | Count |
| Most overused word | abs/cat | O | Exclude | Content |
| Slop score | est | I | Monitor | Density × mean score; the n-gram flag threshold grows with length |
| Flagged repetitive words | abs | O | Exclude | Length |
| Flagged words per 10,000 | ratio | I | Target | Down: remove clichés and repeated content words |
| Mean repetition score | ratio | I | Monitor | Depends on which words were flagged |
| Content words | abs | O | Exclude | Length |
| Flagged repeated n-grams | abs | O | Exclude | Length |
| Flagged n-grams per 10,000 | ratio | I | Target | Down: remove repeated phrases |
| Repeated n-gram candidates | abs | O | Exclude | Length |

### 3.14 Pairwise helpers mentioned in the skill (not in the consolidated table)

The skill's "Comparing two texts" section mentions library-native pairwise
measures. They are not in the consolidated report table, and they are not
good per-iteration targets, but they are useful as final validation.

| Metric | Class | Ctrl | Verdict | Note |
|---|---|---|---|---|
| Burrows' Delta | distance | O | Validate only | Standardised Manhattan distance over top-N function words; requires the same feature set and comparable sample lengths. Lower = more similar. It is a distance, not a direction. |
| Zeta | distance | O | Validate only | Distinctive-word score; sensitive to sample size and feature selection. |
| Kilgarriff chi-squared | distance | O | Validate only | Same family as drift chi-square; window- and sample-size dependent. |
| Vocabulary overlap | doc | O | Exclude | Overlap/unique ratio declines as either text grows; not length-invariant. |
| NCD (compression distance) | est | O | Validate only | Compressor- and length-dependent; a sanity check, not a target. |

Use these after the panel has converged: if the panel matches but Delta or
vocabulary overlap still says the texts are far apart, the panel is missing a
feature family. Do not tune Delta directly; it has no single direction.

---

## 4. The control panel

### 4.1 Recommended primary and secondary targets

These are chosen to be length-stable, non-redundant, and directly or indirectly
steerable. Weights are suggestions for the matching score; they can be exposed
as configuration.

| # | Metric | Weight | Direction lever (up / down) | Main collateral effects |
|---:|---|---:|---|---|
| 1 | Mean sentence length (words) | 1.0 | Merge / split at clause boundaries | FK, Fog, ARI, CLI, sentence rhythm, punctuation |
| 2 | Sentence length std dev | 1.0 | Mix very short and long / homogenize | Mean sentence length, rhythm |
| 3 | Mean syllables per word | 0.75 | Polysyllabic/Latinate / monosyllabic/Germanic | Readability, word length, formality |
| 4 | Flesch-Kincaid grade | 1.0 | Longer sentences + polysyllables / split + simplify | All readability formulas |
| 5 | Dale-Chall difficult word ratio | 1.0 | Unfamiliar words / familiar 3,000-word list | Rare-word ratio, frequency rank, syllables |
| 6 | MATTR (window 50) | 1.0 | Synonym/paraphrase variety / repeat key words | MTLD, Yule, rare ratio, readability |
| 7 | MTLD (threshold 0.72) | 0.75 | New types spread evenly / cluster repeats | MATTR, Yule, hapax |
| 8 | Yule's K | 0.75 | Repeat a few content words / remove tics | MTLD, MATTR (inverse) |
| 9 | Rare word ratio | 0.5 | Technical/specific/archaic words / everyday words | Dale-Chall, syllables, readability |
| 10 | Noun-verb ratio | 0.75 | Nominalize / verbalize | Lexical density, passive, formality, syllables |
| 11 | Lexical density | 0.75 | Content words, drop function words / pronouns and prepositions | Noun ratio, readability |
| 12 | Adjective ratio | 0.5 | Attributive modifiers / concrete nouns and verbs | Word length, readability |
| 13 | Adverb ratio | 0.5 | -ly and degree adverbs / strong verbs | Syllables, word length |
| 14 | Passive voice ratio | 1.0 | Be/get + past participle / active voice | Impersonal density, formality, noun ratio |
| 15 | Clausal density | 0.75 | More clauses per T-unit / simple sentences | Sentence length, parse depth, punctuation |
| 16 | Contraction ratio | 0.75 | don't/I'm / do not/I am | Formality, first person, readability |
| 17 | Pronoun density | 0.75 | First/second person, dialogue / full NPs | Cohesion, formality, noun ratio |
| 18 | Connective density | 0.75 | However/therefore/moreover/then / parataxis | Cohesion, syllables, punctuation |
| 19 | Punctuation density | 0.5 | Commas/semicolons/dashes / strip | Sentence segmentation, rhythm |
| 20 | Mean dependency distance | 0.5 | Postpose modifiers / canonical SVO | Parse depth, readability |
| 21 | Sentence length alternation | 0.5 | Alternate long/short / uniform | Sentence-length SD |
| 22 | Word bigram entropy | 0.5 | Varied collocations / formulaic pairs | MATTR, punctuation |
| 23 | Formality score | 0.5 | Latinate + nominalization + passive, no first person / reverse | Many of the above |
| 24 | First-person ratio | 0.5 | I/we / third person | Pronoun density, formality |
| 25 | Dialogue ratio | 0.5 (fiction) | Quoted speech / narration | Pronoun density, sentence length, punctuation |
| 26 | Alliteration/assonance | 0.5 (verse) | Sound repetition / vary | Syllables, word choice |

If the panel must be smaller, keep 1-8, 10-11, and 14-18. Those cover the
largest variance and the clearest levers. The rest are confirmatory.

### 4.2 Why these and not the rest

- **Readability**: all ten formulas are variations on two axes. Keeping
  Flesch-Kincaid plus Dale-Chall covers the syllable/word-length axis and the
  word-familiarity axis. FORCAST is useful as a pure monosyllable check when
  sentence length is already matched. The rest are confirmatory.
- **Lexical diversity**: MATTR, MTLD, and Yule's K are the three least
  redundant axes (local diversity, global factor length, repetition
  concentration). MSTTR is a close correlate of MATTR. Raw/root/log TTR and
  HD-D as implemented here (whole-text, not chunked) are length-biased. vocd-D
  is unstable. Hapax ratio is a secondary check.
- **Vocabulary sophistication**: rare-word ratio, mean frequency rank, and
  Dale-Chall difficult ratio overlap heavily. Rare-word ratio is the most
  interpretable; mean rank is a continuous version; Dale-Chall is the
  readability-facing version.
- **Syntax**: noun/verb ratio, lexical density, passive ratio, and clausal
  density are the four strongest, most controllable axes. Dependency distance
  and parse depth are harder but add genuine syntactic information.
- **Markers**: contraction, pronoun, connective, and punctuation densities are
  the most local and reliable. Intensifier, hedge, modal, and negation are good
  secondary targets. Quotation density is unreliable with curly quotes.
- **Composites**: formality score, genre scores, semantic coherence, and
  sentence complexity are useful summaries but poor targets; optimise their
  components instead.

### 4.3 Coupling and conflict map

The strong levers are not independent. This is the main reason a one-shot
rewrite fails.

| If you… | You also… |
|---|---|
| Split sentences | Lower FK/Fog/ARI/CLI, raise sentence count, shorten mean sentence length, reduce sentence-length variance unless you split selectively |
| Merge sentences | Raise FK/Fog/ARI/CLI, lengthen mean sentence length, reduce sentence count |
| Use Latinate/polysyllabic words | Raise syllables/word, average word length, FK/Fog/ARI/CLI, formality, noun ratio; lower Flesch ease |
| Nominalize verbs | Raise noun ratio, nominalization density, formality, lexical density; lower verb ratio, readability ease |
| Passivize | Raise passive ratio, impersonal density, formality, noun ratio; lower verb ratio, first person |
| Add contractions | Raise contraction ratio; lower formality, average word length, syllables/word |
| Add first-person pronouns | Raise pronoun density, first-person ratio, cohesion; lower formality, noun ratio, lexical density |
| Add connectives | Raise connective density, cohesion, syllables/word; may raise formality |
| Diversify vocabulary | Raise MATTR/MTLD, rare-word ratio, syllables/word; may raise readability grade |
| Repeat key words | Raise Yule's K, content overlap, cohesion; lower MATTR/MTLD, rare-word ratio |
| Add punctuation | Raise punctuation density; commas do not split sentences in spaCy, periods do; semicolons/colons may not split |
| Add dialogue | Raise pronoun density, quotation density, contraction ratio; tend to lower formality, sentence length, lexical density |
| Vary sentence length | Raise sentence-length SD and alternation; may raise mean if long sentences dominate |

**Hard conflicts to expect:**

- **Low readability grade vs high lexical diversity.** Simple words are usually
  common words, which lowers rare-word ratio and can lower MATTR. Resolution:
  keep sentences short and use varied *simple* words (synonyms, concrete
  nouns) rather than Latinate vocabulary.
- **High formality vs low readability grade.** Latinate vocabulary and
  nominalizations raise both formality and grade. Resolution: if the baseline
  is formal but readable, use formal *sentence structure* with shorter words;
  or accept that some metrics cannot all match.
- **High passive ratio vs high verb ratio.** Passive constructions reduce
  finite active verbs. Resolution: decide which axis is primary; usually the
  baseline's passive ratio is the better target because it is directly
  measurable.
- **High contraction/first-person style vs high formality.** These pull in
  opposite directions. Resolution: match the baseline's register first, then
  fine-tune.
- **High Yule's K vs high MATTR/MTLD.** Repetition and diversity are inverse.
  Resolution: use Yule's K as a repetition check, not as an independent target,
  unless the baseline is markedly repetitive.

### 4.4 The LLM's default rewriting bias

A large paired study (60,786 human academic texts, eight model configurations)
measured what happens when an LLM rewrites human text. The direction was
consistent across models:

| Feature | Human source | AI rewrite | Effect |
|---|---:|---:|---|
| Words with 7+ letters per 1,000 | 357 | 444 | d = +1.57 |
| Mean word length | 5.51 chars | 6.12 chars | d = +1.54 |
| MATTR | 0.785 | 0.827 | d = +1.31 |
| Nominalizations per 1,000 | 58 | 75 | d = +1.12 |
| -ly adverbs per 1,000 | 12.3 | 17.9 | d = +0.60 |
| Commas per 1,000 | 62.7 | 71.2 | d = +0.47 |
| Semicolons per 1,000 | 3.87 | 4.47 | — |
| Colons per 1,000 | 1.98 | 1.50 | — |
| Parentheses per 1,000 | 15.6 | 14.0 | — |
| First person per 1,000 | 4.34 | 2.19 | — |
| Contractions per 1,000 | 0.32 | 0.15 | — |
| Questions per 1,000 | 0.34 | 0.22 | — |
| Repeated sentence openers per 100 transitions | 7.2 | 2.7 | d = -0.45 |
| Em dashes per 1,000 | 0 (normalized corpus) | 4.06 | — |

The prior study in the same series found that all eight models flatten
sentence-length variation; the flattening strength varied about eightfold
across models. The practical implication: **if the baseline is a human text
with varied sentence lengths, contractions, first-person passages, and simple
vocabulary, the model's default rewrite will move away from it.** The matching
prompt must explicitly counter the default: preserve short sentences, restore
contractions, avoid nominalizations and em dashes, and do not "polish" the
voice out.

This evidence is from academic rewriting; fiction and dialogue may show
different magnitudes. The direction (heavier, more formal, less personal) is
the part to generalize cautiously.

### 4.5 Operations lexicon

Use these names in prompts and changelogs. Each is a concrete edit, not an
adjective.

| Operation | What the model does | Metrics moved |
|---|---|---|
| **SPLIT** | Replace a comma/conjunction with a period and capitalize | Sentence length down, sentence count up, FK/Fog/ARI down |
| **MERGE** | Join two sentences with a semicolon or conjunction | Sentence length up, sentence count down, readability grade up |
| **SUBORDINATE** | Turn one sentence into a because/although/which/when clause | Clausal density up, dependent ratio up, sentence length up |
| **COORDINATE** | Join clauses with and/but/or | Coordination index up, compound ratio up |
| **NOMINALIZE** | Turn a verb/adjective into a noun ("decide" → "decision") | Noun ratio up, nominalization up, verb ratio down, formality up |
| **VERBALIZE** | Reverse nominalization ("the implementation of" → "they implemented") | Verb ratio up, noun ratio down, readability ease up |
| **PASSIVIZE** | "X did Y" → "Y was done by X" | Passive ratio up, impersonal density up, first person down |
| **ACTIVATE** | Reverse passive | Passive ratio down, verb ratio up |
| **LATINIZE** | Swap Germanic for Latinate synonyms ("start" → "commence") | Syllables/word up, word length up, formality up, readability grade up |
| **GERMANIZE** | Reverse Latinate | Syllables/word down, readability ease up |
| **MODIFY** | Add attributive adjectives or adverbs | Adjective/adverb ratio up, word length up |
| **STRIP_MODIFIERS** | Remove adjectives/adverbs | Adjective/adverb ratio down, word length down |
| **DIVERSIFY** | Synonym substitution, paraphrase, specific nouns | MATTR/MTLD up, rare ratio up, Yule down |
| **REPEAT** | Reuse key content words and phrases | Yule up, content overlap up, MATTR/MTLD down |
| **PRONOMINALIZE** | Replace repeated NPs with pronouns | Pronoun density up, noun ratio down, lexical density down |
| **FULL_NP** | Reverse pronominalization | Pronoun density down, noun ratio up |
| **CONTRACT** | "do not" → "don't" | Contraction ratio up, formality down, word length down |
| **EXPAND** | Reverse contraction | Contraction ratio down, formality up |
| **HEDGE** | Add maybe/perhaps/about/roughly | Hedging density up |
| **BOOST** | Add very/really/extremely | Intensifier density up |
| **MODALIZE** | Add may/might/could | Modal density up, epistemic ratio up |
| **DEONTICIZE** | Add must/should/can | Modal density up, deontic ratio up |
| **NEGATE** | Add not/never/no | Negation density up |
| **CONNECT** | Add however/therefore/moreover/then | Connective density up, cohesion up |
| **DISCONNECT** | Remove connectives, use parataxis | Connective density down |
| **PUNCTUATE** | Add commas/semicolons/dashes/parentheses | Punctuation density up |
| **DEPUNCTUATE** | Remove optional punctuation | Punctuation density down |
| **DIALOGUE** | Convert narration to quoted speech | Quotation/dialogue ratio up, pronoun density up, sentence length down |
| **NARRATE** | Convert quoted speech to reported speech | Quotation/dialogue ratio down |
| **VARY_RHYTHM** | Alternate very short and long sentences | Sentence-length SD and alternation up |
| **HOMOGENIZE** | Make sentence lengths similar | Sentence-length SD and alternation down |
| **EMBED** | Add relative/participial/appositive structures | Parse depth up, dependency distance up, clausal density up |
| **FLATTEN** | Remove embeddings, use SVO | Parse depth down, dependency distance down |
| **FIRST_PERSON** | Use I/we as subjects | First-person ratio up, pronoun density up, formality down |
| **IMPERSONALIZE** | Replace personal subjects with impersonal constructions | First-person ratio down, impersonal density up, formality up |
| **ALLITERATE** | Choose words with the same initial sound | Alliteration density up |
| **ASSONATE** | Choose words with the same vowel sound | Assonance density up |

---

## 5. Quantitative sensitivity: which lever buys the most movement

The readability formulas are explicit linear combinations, so their
sensitivity can be read off the coefficients. This matters for prioritising
edits: the same text change can move one formula by half a grade and another
by two grades.

| Formula | Dominant terms | What one unit costs |
|---|---|---|
| Flesch Reading Ease | `-1.015 × ASL - 84.6 × syll/word` | 1 point ≈ 1 word of ASL, or 1.18 extra syllables per 100 words |
| Flesch-Kincaid Grade | `+0.39 × ASL + 11.8 × syll/word` | 1 grade ≈ 2.56 words of ASL, or 8.5 extra syllables per 100 words |
| Gunning Fog | `0.4 × (ASL + % complex words)` | 1 point ≈ 2.5 words of ASL, or 2.5 percentage points complex words |
| Dale-Chall | `0.1579 × % difficult + 0.0496 × ASL` | 1 point ≈ 6.3 percentage points difficult words, or 20 words of ASL |
| Coleman-Liau | `0.0588 × letters/100w - 0.296 × sentences/100w` | 1 point ≈ 0.17 extra letters per word, or 3.4 fewer sentences per 100 words |
| ARI | `4.71 × chars/word + 0.5 × ASL` | 1 point ≈ 0.21 extra characters per word, or 2 words of ASL |
| Powers-Sumner-Kearl | `0.0778 × ASL + 0.0455 × syll/word` | 1 point ≈ 12.9 words of ASL; the syllable term is nearly negligible |
| Linsear Write | `(easy + 3 × hard) / sentences` | 1 grade ≈ 1 hard-for-easy word substitution per sentence |
| FORCAST | `20 - (monosyllables per 150 words) / 10` | 1 grade ≈ 10 fewer monosyllables per 150 words (6.7% of tokens) |
| SMOG | `1.043 × sqrt(polysyllables × 30 / sentences)` | Nonlinear; splitting sentences lowers it, adding polysyllables raises it |

**Practical ranking of levers by breadth:**

1. **Sentence length** moves every readability formula, sentence-length SD,
   sentence rhythm, punctuation density, and often lexical density. It is the
   first macro lever.
2. **Word length / syllables per word** moves every syllable-based formula,
   average word length, polysyllabic ratio, formality, and often lexical
   diversity. It is the second macro lever.
3. **Vocabulary familiarity** (Dale-Chall, rare ratio) moves readability only
   through Dale-Chall and the frequency metrics, but it is the only way to
   match the vocabulary axis without changing sentence geometry.
4. **Nominalization/passive** moves POS ratios, formality, and readability
   without changing sentence count. It is the main register lever.
5. **Punctuation and markers** are fine-tuning levers; they move their own
   densities and little else.

---

## 6. Iterative matching protocol

### 6.1 Normalize before measuring

- Strip markdown, YAML frontmatter, footnotes, references, and boilerplate
  from both texts with the same settings.
- Use the same language/dialect. Dialect scores will otherwise dominate.
- Pin `chunk_size=1000`, `MATTR window=50`, `MSTTR segment=100`, `MTLD
  threshold=0.72`, `drift window=1000`, `drift stride=500`.
- Match genre and topic as closely as possible. Many metrics (rare words,
  technical terms, narrative markers, BNC overuse, dialect) are content- or
  genre-driven. If the baseline is a legal brief and the draft is a short
  story, some differences are irreducible and should be excluded from the
  score, not "fixed" by changing the content.
- Keep the candidate near its intended length (for example, within ±5%).
  Style edits should not silently pad or cut the document; if length is part
  of the brief, treat it as a hard constraint and use equal-length windows for
  measurement.

Command sketch:

```bash
S=~/.pi/agent/skills/stylometry/scripts/stylometry-report
$S baseline.md --json baseline.json --quiet
$S candidate.md --json candidate.json --quiet
```

Read the `*_dist.std` fields from the JSON for the baseline's chunk-to-chunk
variation; the markdown table usually shows only the mean.

### 6.2 Compare equal-length windows

If the texts differ in length by more than about 20%, do not compare the whole
documents. Use one of these designs:

1. **Common-length prefix**: take the first N words of both, where N is the
   smaller word count (capped at, say, 10,000). Simple, but sensitive to the
   opening.
2. **Stratified windows**: take N-word windows from the beginning, middle, and
   end of each text. Average the metric across windows. This captures drift.
3. **Disjoint windows**: cut each text into all possible N-word windows,
   compute the metric per window, and compare distributions (mean, SD). This
   is the closest to a developmental profile and is the most robust.
4. **Bootstrap**: resample sentences or chunks to build a confidence interval
   for each metric. If the baseline and candidate intervals overlap, treat the
   difference as noise.

Recommended N: 3,000-5,000 words. Below 3,000, many metrics are too noisy;
above 10,000, content drift starts to dominate.

### 6.3 Score the mismatch

For each metric `m` in the panel:

- Baseline mean `μ_b`, baseline chunk SD `σ_b`
- Candidate mean `μ_c`
- Effect size `z_m = (μ_c - μ_b) / max(σ_b, floor_m)`

`floor_m` prevents a tiny baseline SD from producing enormous z-scores. Use a
domain floor, e.g.:

- proportions/densities: `max(σ_b, 0.01-0.02)` (1-2 percentage points)
- readability grades: `max(σ_b, 0.5 grade)`
- sentence length: `max(σ_b, 1 word)`
- MATTR/MTLD/Yule: `max(σ_b, 2-5% of μ_b)`

Interpretation: `σ_b` is the baseline's internal spread across chunks, not the
standard error of its mean. If the baseline is homogeneous, `σ_b` is small and
the loop will chase small differences; the floor prevents that. If the
baseline is heterogeneous, `σ_b` is large and the tolerance is loose. That is
appropriate: a candidate cannot be expected to match a moving target more
precisely than the baseline matches itself.

Aggregate:

```
D = sqrt( Σ w_m · min(z_m², 9) / Σ w_m )
```

The cap at 9 prevents one wild metric from dominating. `D` is a weighted RMS
effect size; it is not a p-value.

### 6.4 Tolerances

| Effect size `z` | Interpretation | Action |
|---|---|---|
| ≤ 0.5 | matched | none |
| 0.5-1.0 | minor drift | fix if the lever is cheap and does not break another target |
| 1.0-2.0 | mismatch | include in the next pass |
| > 2.0 | large mismatch | prioritise; check for a measurement or content confound first |

For count-like proportions, also require a minimum absolute difference (e.g.,
at least 1 percentage point) so that a large N does not make a trivial
difference look important. For long texts, statistical significance is easy;
stylistic relevance is not.

### 6.5 The loop

1. **Measure baseline.** Compute the panel on the baseline, including chunk
   SDs. Optionally split the baseline in half and measure both halves to
   estimate its internal variability. If the two halves differ by more than the
   tolerance on a metric, that metric is unstable for this baseline; downweight
   it.
2. **Measure candidate.** Compute the same panel.
3. **Rank deviations.** Sort by `|z_m| · w_m`. Ignore excluded metrics.
4. **Pick 1-3 levers.** Prefer the largest deviation that is directly
   controllable. Do not pick two levers that conflict (e.g., "raise MATTR" and
   "raise Yule's K").
5. **Write an edit plan.** For each lever, specify the operation, the quota
   (per 1,000 words or per paragraph), and the expected direction. Include a
   "do not" list for the model's default biases.
6. **Apply at paragraph level.** Keep a changelog. Do not rewrite the whole
   document in one pass unless it is short.
7. **Re-measure.** Accept the pass if the weighted mismatch `D` falls and no
   primary metric's `|z|` rises by more than 0.5. Otherwise revert and try a
   smaller quota.
8. **Repeat.** Stop after 5-8 passes, when `D` is below the target, or when the
   remaining deviations are all in metrics that cannot be moved without
   changing content.
9. **Report residuals.** List the metrics that could not be matched, the
   content or genre reason, and the size of the remaining gap. Do not pretend
   a match is perfect.

### 6.6 Priority order

Do not tune in metric order. Tune in lever order:

1. **Macro geometry**: sentence length mean and SD, word length/syllables.
2. **Readability**: FK and Dale-Chall; use FORCAST if vocabulary weight is
   still off.
3. **Lexical diversity/repetition**: MATTR, MTLD, Yule's K.
4. **Register/syntax**: noun/verb ratio, lexical density, passive, clausal
   density.
5. **Voice/markers**: contractions, pronouns, modals, hedges, negation.
6. **Punctuation and cohesion**: punctuation density, connectives, content
   overlap.
7. **Rhythm**: sentence alternation, word bigram entropy, alliteration (if
   verse).

Macro changes move many downstream metrics. If you tune punctuation first, the
next sentence split will undo it.

### 6.7 What not to chase

- **Noise**: metrics with a baseline chunk SD larger than the gap you are
  trying to close. For example, sentence-length max/min and pattern entropy.
- **Labels**: register, predicted genre, dialect, drift pattern, Flesch band,
  Dale-Chall grade, Fry zone. Target the underlying numbers.
- **Saturated metrics**: anaphora resolution (near 1.0), discourse structure
  (near 0.9), punctuation variety (6-8), functional diversity (four bins).
- **Content-driven metrics**: technical term density, narrative/expository
  markers, BNC overuse, dialect scores. Match genre first; do not rewrite
  content to move them.
- **Composites**: formality, genre scores, semantic coherence, sentence
  complexity. Optimise their components; the composite will follow.

---

## 7. Prompting the LLM for controlled style matching

### 7.1 Principles

1. **Give numbers, not adjectives.** "Make it more formal" is not measurable.
   "Replace 20% of finite verbs with nominalizations; use `do not` for every
   contraction" is.
2. **Give operations and quotas.** Per 1,000 words or per paragraph is easier
   for a model to apply than a document-wide target.
3. **Give examples from the baseline.** Two or three short baseline paragraphs
   as style anchors are more effective than a list of adjectives. Do not ask
   the model to copy their content.
4. **Counter the default bias.** If the baseline is light, explicitly forbid
   nominalizations, em dashes, "furthermore/pivotal/underscore", and
   over-polishing.
5. **Preserve content.** Names, numbers, dates, citations, claims, and
   paragraph order are hard constraints. Style edits should not add or remove
   facts.
6. **Measure after every pass.** The model's self-report is not reliable, and
   numeric-constraint benchmarks show it often misses explicit counts.
7. **Do not over-edit.** A pass that fixes one metric but breaks three is a
   net loss. Use the weighted score.

### 7.2 Example prompt

```
You are revising a draft to match a measured style profile. Preserve all
facts, names, numbers, and claims. Do not add new content. Do not remove
substantive content.

BASELINE TARGETS (current draft in parentheses):
- Mean sentence length: 14.2 words (22.6)
- Sentence-length SD: 9.1 (4.3)
- Syllables per word: 1.38 (1.52)
- Flesch-Kincaid grade: 7.1 (10.4)
- Dale-Chall difficult-word ratio: 0.16 (0.24)
- MATTR (window 50): 0.79 (0.84)
- Contractions: 0.9 per 100 words (0.1)
- First-person pronouns: 2.1 per 100 words (0.4)

OPERATIONS FOR THIS PASS:
1. SPLIT every sentence longer than 28 words at a clause boundary. Do not add
   new clauses; just punctuate the existing ones as separate sentences.
2. MERGE adjacent sentences shorter than 6 words when they share a subject.
3. GERMANIZE 15 Latinate words per 1,000 words (e.g., commence -> start,
   utilize -> use, approximately -> about, demonstrate -> show).
4. CONTRACT in dialogue and first-person passages (do not -> don't, I am -> I'm).
5. Do NOT add nominalizations, passive voice, em dashes, or the words
   "furthermore", "pivotal", "underscore", "foster".
6. Keep the paragraph order and the argument.

Output only the revised text, then a short changelog of the operations you
applied and where.
```

### 7.3 Retry feedback

The stylometric-transfer project demonstrates a practical pattern: after each
chunk, compare the output's measurements with the target and re-prompt with
the failed constraints, actual vs target values, and preservation instructions.
A simpler version for this skill:

```
The previous pass missed these targets:
- Mean sentence length: 19.4 (target 14.2) — split more sentences over 24 words.
- MATTR: 0.81 (target 0.79) — repeat key terms more; reduce synonym swaps.
- Contractions: 0.3 (target 0.9) — contract every "do not", "cannot", "I am"
  in dialogue and first-person passages.
Keep everything that already matches. Do not change facts or paragraph order.
```

### 7.4 Content-preservation check

Style transfer research consistently treats style accuracy, content
preservation, and fluency as separate axes. A matching loop should include a
content check, not just a style score:

- Named entities and numbers unchanged.
- Claims and their order unchanged.
- No new facts or arguments.
- No loss of substantive detail.
- A semantic similarity check (embedding cosine or an LLM judge) above a
  threshold.

If the style pass requires changing content to move a content-driven metric
(technical terms, narrative markers, dialect), stop and exclude that metric
from the score instead.

---

## 8. Proposed v2 metric panel (machine-readable sketch)

This is a recommendation for the future skill change, not an implementation.
It lists the metrics, weights, directions, and tolerance floors.

```yaml
# lever: [operation that raises the metric, operation that lowers it]
chunk_size: 1000
mattr_window: 50
msttr_segment: 100
mtld_threshold: 0.72
min_words: 3000

panel:
  - id: mean_sentence_length
    weight: 1.0
    class: ratio
    lever: [MERGE, SPLIT]
    floor: 1.0
  - id: sentence_length_std
    weight: 1.0
    class: ratio
    lever: [VARY_RHYTHM, HOMOGENIZE]
    floor: 1.0
  - id: syllables_per_word
    weight: 0.75
    class: ratio
    lever: [LATINIZE, GERMANIZE]
    floor: 0.02
  - id: flesch_kincaid_grade
    weight: 1.0
    class: win
    lever: [SPLIT, MERGE, LATINIZE, GERMANIZE]
    floor: 0.5
  - id: dale_chall_difficult_ratio
    weight: 1.0
    class: win
    lever: [DIVERSIFY, SIMPLIFY]
    floor: 0.01
  - id: mattr
    weight: 1.0
    class: win
    lever: [DIVERSIFY, REPEAT]
    floor: 0.02
  - id: mtld
    weight: 0.75
    class: win
    lever: [DIVERSIFY, REPEAT]
    floor: 3.0
  - id: yule_k
    weight: 0.75
    class: win
    lever: [REPEAT, DIVERSIFY]
    floor: 5.0
  - id: rare_word_ratio
    weight: 0.5
    class: ratio
    lever: [LATINIZE, GERMANIZE]
    floor: 0.01
  - id: noun_verb_ratio
    weight: 0.75
    class: ratio
    lever: [NOMINALIZE, VERBALIZE]
    floor: 0.05
  - id: lexical_density
    weight: 0.75
    class: ratio
    lever: [NOMINALIZE, PRONOMINALIZE]
    floor: 0.01
  - id: adjective_ratio
    weight: 0.5
    class: ratio
    lever: [MODIFY, STRIP_MODIFIERS]
    floor: 0.01
  - id: adverb_ratio
    weight: 0.5
    class: ratio
    lever: [MODIFY, STRIP_MODIFIERS]
    floor: 0.01
  - id: passive_ratio
    weight: 1.0
    class: ratio
    lever: [PASSIVIZE, ACTIVATE]
    floor: 0.02
  - id: clausal_density
    weight: 0.75
    class: ratio
    lever: [SUBORDINATE, FLATTEN]
    floor: 0.05
  - id: contraction_ratio
    weight: 0.75
    class: ratio
    lever: [CONTRACT, EXPAND]
    floor: 0.01
  - id: pronoun_density
    weight: 0.75
    class: ratio
    lever: [PRONOMINALIZE, FULL_NP]
    floor: 0.01
  - id: connective_density
    weight: 0.75
    class: ratio
    lever: [CONNECT, DISCONNECT]
    floor: 0.01
  - id: punctuation_density
    weight: 0.5
    class: ratio
    lever: [PUNCTUATE, DEPUNCTUATE]
    floor: 0.01
  - id: dependency_distance
    weight: 0.5
    class: ratio
    lever: [EMBED, FLATTEN]
    floor: 0.1
  - id: sentence_length_alternation
    weight: 0.5
    class: ratio
    lever: [VARY_RHYTHM]
    floor: 0.02
  - id: word_bigram_entropy
    weight: 0.5
    class: win
    lever: [DIVERSIFY, REPEAT]
    floor: 0.1
  - id: formality_score
    # composites split direction explicitly because they mix several levers
    weight: 0.5
    class: composite
    lever_up: [LATINIZE, NOMINALIZE, PASSIVIZE]
    lever_down: [GERMANIZE, VERBALIZE, ACTIVATE, CONTRACT]
    floor: 2.0
  - id: first_person_ratio
    weight: 0.5
    class: ratio
    lever: [FIRST_PERSON, IMPERSONALIZE]
    floor: 0.01
  - id: dialogue_ratio
    weight: 0.5
    class: ratio
    lever: [DIALOGUE, NARRATE]
    floor: 0.02
    condition: fiction
```

### 8.1 Skill integration notes (future work)

- Add a `--baseline PATH` mode that runs the analysis on both texts and writes
  a comparison report plus a machine-readable JSON diff.
- The diff should include per-metric baseline mean, candidate mean, baseline
  chunk SD, z-score, direction, weight, and verdict.
- Add a `--panel` option to select the matching panel and a `--weights` file.
- Keep the full inventory available for human inspection, but do not include
  excluded metrics in the matching score.
- Add an "edit plan" output: top deviations, recommended operations, quotas,
  and a "do not" list derived from the model's default bias.
- Add a `--window N` option for equal-length comparison, independent of the
  analysis chunk size.
- The report should state the normalization, chunk size, window size, sample
  length, and number of windows used. Two matching reports are only comparable
  at the same settings.
---

## 9. Limitations and open questions

1. **No measure is perfectly length-invariant.** Tweedie and Baayen found that
   almost all classic lexical constants vary with length; in their Monte Carlo
   analysis only Yule's K was constant across all lengths (Z was approximately
   constant after a minimum sample), and even K can deviate in real prose. The
   fixed-window strategy is a practical control, not a mathematical guarantee.
2. **Content and genre confounds are large.** Rare words, technical terms,
   narrative markers, dialect, and BNC overuse are driven by topic and genre
   as much as by style. Matching them may require changing content, which
   conflicts with meaning preservation. The matching panel should be
   genre-conditioned.
3. **Chunk-level noise is substantial for short texts.** A 3,000-word text has
   only three 1,000-word chunks. The chunk SD is itself uncertain. Bootstrap
   or use more windows if possible.
4. **Some metrics are redundant by construction.** Readability formulas
   correlate 0.92-0.99; MATTR/MSTTR 0.92; rare/advanced ratio 1.00. Including
   all of them double-counts the same axis. The panel weights should reflect
   this.
5. **LLM controllability is imperfect.** Readability-controlled generation
   studies show that strong models can follow grade-level targets but with a
   gap, and weaker models barely move. Numeric constraints are especially
   fragile. The loop must measure and correct.
6. **The default-bias evidence is from academic rewriting.** The direction is
   likely general (heavier, more formal, less personal), but the magnitudes
   may differ in fiction, poetry, or dialogue-heavy prose. Validate on the
   target genre.
7. **The report's quotation/dialogue counters miss curly quotes.** If the
   baseline uses typographic quotes, quotation density and dialogue ratio may
   read zero. Do not target them without checking. The skill already warns
   about this.
8. **The formality score can disagree with the register label.** The *Hound*
   example is labelled "frozen" with a formality score of 0.21. Target the
   numeric score or its components, not the label.
9. **Drift chi-square is window-size-dependent.** Compare only at the same
   window size, stride, and top-N. Do not compare a 1,000-word-window drift
   value with a 2,000-word-window value.
10. **The matching objective is multi-objective.** There is no single "correct"
    weighting. The user should be able to prioritise (e.g., readability first,
    or diversity first) and see the trade-offs.

---

## References

### pystylometry and the skill

1. `pystylometry` source, pinned commit `ce3c62b`; metric modules under
   `lexical/`, `readability/`, `syntactic/`, `character/`, `ngrams/`,
   `stylistic/`, `dialect/`, `consistency/`, `prosody/`.
   <https://github.com/craigtrim/pystylometry>
2. Skill evidence, `evidence/metric-redundancy.md` (16 books, 1.07M words,
   chunk size 1,000; within- and between-text correlations).
3. Skill evidence, `evidence/measurements.json` (per-chunk series for 16
   books).

### Length dependence and lexical diversity

4. Tweedie, F. J., & Baayen, R. H. (1998). How variable may a constant be?
   Measures of lexical richness in perspective. *Computers and the Humanities*,
   32, 323-352.
   <https://quantling.org/~hbaayen/publications/TweedieBaayen1998.pdf>
5. Zechner, N. (2023). Length dependence of vocabulary richness. *NoDaLiDa
   2023*, 565-573.
   <https://aclanthology.org/2023.nodalida-1.56.pdf>
6. McCarthy, P. M., & Jarvis, S. (2010). MTLD, vocd-D, and HD-D: A validation
   study of sophisticated approaches to lexical diversity assessment.
   *Behavior Research Methods*, 42(2), 381-392.
   <https://doi.org/10.3758/BRM.42.2.381>
7. Covington, M. A., & McFall, J. D. (2010). Cutting the Gordian knot: The
   moving-average type-token ratio (MATTR). *Journal of Quantitative
   Linguistics*, 17(2), 94-100.
8. Miranda-García, A., & Calle-Martín, J. (2005). Yule's characteristic K
   revisited. *Language Resources and Evaluation*, 39, 287-294.
   <https://doi.org/10.1007/s10579-005-8622-8>
9. Koizumi, R., & In'nami, Y. (2012). Effects of text length on lexical
   diversity measures: Using short texts with less than 200 tokens. *System*,
   40(4), 554-564.
   <https://eric.ed.gov/?id=EJ986928>
10. "Investigating minimum text lengths for lexical diversity indices"
    (2020). *Assessing Writing*.
    <https://www.sciencedirect.com/science/article/pii/S1075293520300660>
11. Evert, S., et al. (2017). Does size matter? Authorship attribution, small
    samples, big problem. *Digital Scholarship in the Humanities*.
    <https://doi.org/10.1093/llc/fqt066>
12. Miller, G. A. (1955). Note on the bias of information estimates. In
    H. Quastler (Ed.), *Information Theory in Psychology* (pp. 95-100). The
    Miller-Madow correction also credits Madow (1948). See the estimator
    documentation:
    <https://search.r-project.org/CRAN/refmans/entropy/html/entropy.MillerMadow.html>

### Readability

13. Kincaid, J. P., et al. (1975). Derivation of new readability formulas for
    Navy enlisted personnel. *Research Branch Report 8-75*.
14. Dale, E., & Chall, J. S. (1948). A formula for predicting readability.
    *Educational Research Bulletin*, 27(1), 11-28.
15. Gunning, R. (1952). *The Technique of Clear Writing*. McGraw-Hill.
16. Coleman, M., & Liau, T. L. (1975). A computer readability formula designed
    for machine scoring. *Journal of Applied Psychology*, 60(2), 283-284.
17. Senter, R. J., & Smith, E. A. (1967). *Automated Readability Index*.
    AMRL-TR-6620.
18. "Readability indices structure and optimal features" (2023). *Axioms*,
    12(5), 421. <https://doi.org/10.3390/axioms12050421>

### Stylometry, features, and LLM style transfer

19. Lagutina, K., et al. (2019). A survey on stylometric text features.
    *FRUCT 25*.
    <https://fruct.org/files/publications/volume-25/fruct25/Lag.pdf>
20. Mosteller, F., & Wallace, D. L. (1964). *Inference and Disputed
    Authorship: The Federalist*. Addison-Wesley.
21. Burrows, J. F. (2002). "Delta": A measure of stylistic difference and a
    guide to likely authorship. *Literary and Linguistic Computing*, 17(3),
    267-287.
22. ReadCtrl: Personalizing text generation with readability-controlled
    instruction learning (2024/2025). The paper shows that stronger models move
    toward grade-level targets but with a persistent gap, and weaker models
    barely move at all.
    <https://arxiv.org/html/2406.09205v1>
23. TextPulse Research (2026). *Stylometric Fingerprints of AI Rewriting:
    Punctuation, Syntax, and Model Attribution Across 60,786 Paired Texts*.
    Working paper.
    <https://textpulse.ai/research/textpulse-style-fingerprints-2026.pdf>
24. Liu, P., et al. (2024). Step-by-step: Controlling arbitrary style in text
    with large language models. *LREC-COLING 2024*.
    <https://aclanthology.org/2024.lrec-main.1328/>
25. Personalized author obfuscation with large language models (2025).
    <https://arxiv.org/abs/2505.12090>
26. Wang, H., et al. (2026). Can large language models handle numeric
    constraints? A comprehensive study and solutions. *PRICAI 2025*.
    <https://doi.org/10.1007/978-981-95-7078-2_16>
27. `stylometric-transfer`: interpretable stylometric profiling and
    constraint-guided author-style transfer.
    <https://github.com/ngpepin/stylometric-transfer>
28. "The style of machines: A stylometric study of LLM generation and
    translation" (2026). *StyleNLP*.
    <https://aclanthology.org/2026.stygenai-1.5.pdf>
29. Sentence length and style (lextutor.ca): rough bands for sentence-length
    standard deviation in fiction vs information text.
    <https://www.lextutor.ca/tools/ex_sent/style_tip.html>
30. Temple University Libraries, *Stylometry Methods and Practices: Methods*.
    <https://guides.temple.edu/stylometryfordh/methods>

---

*End of report.*
