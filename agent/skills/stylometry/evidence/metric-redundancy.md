# Which pystylometry metrics are redundant?

Evidence for narrowing the report to a small set of measures per category.

## What this is based on

- 16 public-domain books, 1,069,146 words total (Project Gutenberg), spanning 3.4k to
  213k words, fiction, plays, essays, and translation: 3,420 words (Swift, *A Modest
  Proposal*) up to 212,796 (Melville, *Moby Dick*).
- Every metric computed at `chunk_size=1000`.
- Two designs, because they answer different questions:
  - **Within-text (per chunk)**: correlations across the ~1,000-word chunks of each book,
    pooled by Fisher z over the 16 books. n is large; this asks whether the measures move
    together as style varies *inside* a document.
  - **Between-text (document means)**: one value per book, n = 16. This asks whether the
    measures rank whole texts the same way. Only 16 points, so ±0.25 is noise here.
- Spearman throughout, since these measures are monotone but not linear in each other.

## Readability: highly redundant, with two real exceptions

Per-chunk Spearman, pooled over 16 books (n roughly 800 chunk pairs per cell).

| | Flesch ease | Flesch-Kincaid | SMOG | Fog | Coleman-Liau | ARI | Dale-Chall | Linsear Write | FORCAST | Powers-Sumner-Kearl | Fry: words/sent | Fry: syll/100w |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Flesch ease** | 1.00 | -0.95 | -0.95 | -0.91 | -0.88 | -0.88 | -0.68 | -0.86 | -0.38 | -0.81 | -0.37 | -0.35 |
| **Flesch-Kincaid** | -0.95 | 1.00 | +0.92 | +0.98 | +0.85 | +0.98 | +0.61 | +0.97 | +0.29 | +0.95 | +0.44 | +0.28 |
| **SMOG** | -0.95 | +0.92 | 1.00 | +0.92 | +0.85 | +0.87 | +0.62 | +0.86 | +0.33 | +0.81 | +0.38 | +0.32 |
| **Fog** | -0.91 | +0.98 | +0.92 | 1.00 | +0.77 | +0.97 | +0.55 | +0.98 | +0.24 | +0.95 | +0.46 | +0.24 |
| **Coleman-Liau** | -0.88 | +0.85 | +0.85 | +0.77 | 1.00 | +0.83 | +0.72 | +0.75 | +0.38 | +0.71 | +0.32 | +0.33 |
| **ARI** | -0.88 | +0.98 | +0.87 | +0.97 | +0.83 | 1.00 | +0.58 | +0.99 | +0.23 | +0.98 | +0.45 | +0.23 |
| **Dale-Chall** | -0.68 | +0.61 | +0.62 | +0.55 | +0.72 | +0.58 | 1.00 | +0.52 | +0.29 | +0.48 | +0.27 | +0.25 |
| **Linsear Write** | -0.86 | +0.97 | +0.86 | +0.98 | +0.75 | +0.99 | +0.52 | 1.00 | +0.19 | +0.99 | +0.46 | +0.19 |
| **FORCAST** | -0.38 | +0.29 | +0.33 | +0.24 | +0.38 | +0.23 | +0.29 | +0.19 | 1.00 | +0.16 | +0.20 | +0.82 |
| **Powers-Sumner-Kearl** | -0.81 | +0.95 | +0.81 | +0.95 | +0.71 | +0.98 | +0.48 | +0.99 | +0.16 | 1.00 | +0.46 | +0.16 |
| **Fry: words/sent** | -0.37 | +0.44 | +0.38 | +0.46 | +0.32 | +0.45 | +0.27 | +0.46 | +0.20 | +0.46 | 1.00 | +0.21 |
| **Fry: syll/100w** | -0.35 | +0.28 | +0.32 | +0.24 | +0.33 | +0.23 | +0.25 | +0.19 | +0.82 | +0.16 | +0.21 | 1.00 |

15 of 66 pairs correlate at |rho| >= 0.90. The tightest:

| rho | pair |
|---|---|
| +0.99 | Linsear Write vs Powers-Sumner-Kearl |
| +0.99 | ARI vs Linsear Write |
| +0.98 | Flesch-Kincaid vs Fog |
| +0.98 | ARI vs Powers-Sumner-Kearl |
| +0.98 | Flesch-Kincaid vs ARI |
| +0.98 | Fog vs Linsear Write |
| +0.97 | Flesch-Kincaid vs Linsear Write |
| +0.97 | Fog vs ARI |
| +0.95 | Fog vs Powers-Sumner-Kearl |
| -0.95 | Flesch ease vs SMOG |
| -0.95 | Flesch ease vs Flesch-Kincaid |
| +0.95 | Flesch-Kincaid vs Powers-Sumner-Kearl |
| +0.92 | Flesch-Kincaid vs SMOG |
| +0.92 | SMOG vs Fog |

The formulas are structurally the same object. Flesch Reading Ease is
`206.835 - 1.015*(words/sentence) - 84.6*(syllables/word)`; Flesch-Kincaid,
Fog, SMOG and Powers-Sumner-Kearl substitute different coefficients and a
different word-difficulty proxy (syllables per word, share of 3+ syllable
words); Coleman-Liau and ARI replace syllables with letters per word or per
100 words; Dale-Chall replaces the proxy again with the share of words absent
from a familiar-word list; FORCAST drops the sentence-length term entirely;
Fry is the two-dimensional graph version of the same two axes; Linsear Write
scores easy and hard words per sentence directly.

So every formula here is a function of at most two variables: a sentence-length
term and a word-difficulty proxy. The correlations follow from that:

- Formulas sharing a proxy (FK, Fog, SMOG, ARI, Coleman-Liau, Linsear, PSK)
  agree at 0.92-0.99.
- **Dale-Chall is the outlier** (0.45-0.75 with the rest, 0.51 with
  Flesch-Kincaid): familiarity is a different construct from syllable count. A
  word can be long and familiar ("basketball") or short and unfamiliar
  ("nacre").
- **FORCAST is the second outlier** (0.16-0.48): it is the only formula with no
  sentence-length term, so it measures lexical weight alone.
- The single ingredients — Fry's words/sentence and syllables/100 words — sit at
  0.2-0.6 with the composites, as expected for parts of a sum.

For each formula, its strongest correlation with any other formula (per-chunk):

| Metric | max abs rho |
|---|---|
| Linsear Write | 0.99 |
| Powers-Sumner-Kearl | 0.99 |
| ARI | 0.99 |
| Flesch-Kincaid | 0.98 |
| Fog | 0.98 |
| Flesch ease | 0.95 |
| SMOG | 0.95 |
| Coleman-Liau | 0.88 |
| FORCAST | 0.82 |
| Fry: syll/100w | 0.82 |
| Dale-Chall | 0.72 |
| Fry: words/sent | 0.46 |

## Lexical diversity: not one factor, but three tight couples and two loners

Between-text Spearman on document means (n = 16). Note that vocd-D, MATTR, MSTTR,
HD-D and the frequency-sophistication ratios return a single document-level value
in pystylometry (`*_dist` has length 1), so they can only be compared this way;
TTR, MTLD, Yule's K and hapax ratio also have per-chunk series.

| | TTR (raw) | MTLD | Yule K | hapax ratio | MATTR | MSTTR | vocd-D | HD-D | rare-word ratio | advanced-word ratio |
|---|---|---|---|---|---|---|---|---|---|---|
| **TTR (raw)** | 1.00 | +0.42 | +0.04 | +0.89 | +0.51 | +0.76 | +0.32 | +0.31 | +0.62 | +0.62 |
| **MTLD** | +0.42 | 1.00 | -0.60 | +0.53 | +0.38 | +0.30 | -0.18 | +0.03 | -0.21 | -0.21 |
| **Yule K** | +0.04 | -0.60 | 1.00 | -0.03 | +0.08 | +0.16 | +0.09 | -0.31 | +0.39 | +0.39 |
| **hapax ratio** | +0.89 | +0.53 | -0.03 | 1.00 | +0.38 | +0.60 | -0.02 | +0.07 | +0.41 | +0.41 |
| **MATTR** | +0.51 | +0.38 | +0.08 | +0.38 | 1.00 | +0.92 | +0.64 | +0.14 | +0.37 | +0.37 |
| **MSTTR** | +0.76 | +0.30 | +0.16 | +0.60 | +0.92 | 1.00 | +0.67 | +0.24 | +0.58 | +0.58 |
| **vocd-D** | +0.32 | -0.18 | +0.09 | -0.02 | +0.64 | +0.67 | 1.00 | +0.55 | +0.56 | +0.56 |
| **HD-D** | +0.31 | +0.03 | -0.31 | +0.07 | +0.14 | +0.24 | +0.55 | 1.00 | +0.26 | +0.26 |
| **rare-word ratio** | +0.62 | -0.21 | +0.39 | +0.41 | +0.37 | +0.58 | +0.56 | +0.26 | 1.00 | +1.00 |
| **advanced-word ratio** | +0.62 | -0.21 | +0.39 | +0.41 | +0.37 | +0.58 | +0.56 | +0.26 | +1.00 | 1.00 |

Reading it:

- **Identical pair**: rare-word ratio and advanced-word ratio correlate at +1.00 —
  they are two labels on the same quantity. Keep one.
- **Near-duplicate pair**: MATTR and MSTTR at +0.92. Both are moving-window TTR;
  they differ only in window sizing. Keep one.
- **Near-duplicate pair**: raw TTR and hapax ratio at +0.89. Both measure how much
  of the vocabulary appears only once, per chunk.
- **Inverse pair**: MTLD and Yule's K at -0.60. Same axis, opposite sign.
- **Largely independent of everything**: HD-D (max 0.55) and vocd-D (max 0.67).
  Neither is redundant with TTR, MTLD, Yule, or the rare-word ratios.
- MTLD vs vocd-D is -0.18, MTLD vs HD-D +0.03, Yule's K vs MATTR +0.08, TTR vs
  Yule's K +0.04. Four measures that all claim to be "vocabulary diversity"
  share almost nothing once you compare whole texts.

Within a single document (per-chunk, where TTR/MTLD/Yule/hapax do have series),
only TTR vs hapax ratio is strong (+0.88); MTLD vs Yule's K is -0.62; the other
four pairs are 0.16-0.40. So chunk-level variation in "diversity" is not one
thing either.

## What the literature says

- McCarthy & Jarvis (2010) validated MTLD against three other indices: it
  correlated +.84 with Maas, +.69 with vocd-D (D), +.85 with Yule's K, and only
  +.32 with raw TTR. They read the low TTR correlation as discriminant validity
  (MTLD is not just length-contaminated TTR) and the high Yule's K correlation as
  convergent validity — i.e. MTLD and Yule's K are close to interchangeable.
- Fergadiotis, Wright & West (2013) ran a confirmatory factor analysis over four
  indices and found MTLD and MATTR were "relatively pure" measures of lexical
  diversity, while vocd-D and HD-D covaried with sample length (construct-
  irrelevant method factors). Fergadiotis et al. (2015), with 442 speakers, reached
  the same conclusion: MTLD and MATTR load most strongly on the diversity factor.
- Raw TTR is length-dependent by construction; the whole reason MTLD, vocd-D,
  HD-D, MATTR and MSTTR exist is to remove that dependence.

The literature and the correlations here agree on the practical upshot: MTLD and
MATTR are the two defensible representatives of the "length-invariant diversity"
family, and vocd-D and HD-D are the ones to drop.

## Recommended minimal sets

If you want one or two measures per category:

| Category | Keep | Drop, and why |
|---|---|---|
| Readability | **Flesch-Kincaid grade** (syllable-based) and **Dale-Chall** (familiar-word-based) | Fog, SMOG, ARI, Coleman-Liau, Linsear, Powers-Sumner-Kearl are 0.92-0.99 correlated with Flesch-Kincaid and add no independent information; FORCAST and Fry add little that the other two miss. The FK/Dale-Chall correlation of +0.51 is the point: they disagree in an informative way. |
| Lexical diversity | **MTLD** (whole-text, length-invariant) and **MATTR** (local, window-invariant) | TTR is length-contaminated; Yule's K is MTLD's inverse; hapax/Sichel/Honore duplicate TTR and are chunk-length artefacts; vocd-D and HD-D carry sample-size effects and are not validated; MSTTR duplicates MATTR. |
| Vocabulary sophistication | **rare-word ratio** | advanced-word ratio is the same number; mean/median frequency rank are the same distribution summarised differently; academic-word ratio is worth keeping only for academic prose. |
| Syntactic | **mean sentence length + sentence-length SD**, and **clausal density** | POS ratios and sentence-type distributions are still cheap and interpretable, but they duplicate the same underlying structure: subordination shows up in clausal density, parse depth, T-units, and the complex-sentence ratio alike. |
| Markers | **contraction ratio** and **hedging density** | intensifiers, modals, negation, and punctuation densities are all fine individually, but they are a la carte signals rather than a small summary; pick the two that match the question at hand. |
| Rhythm / prosody | **rhythmic regularity** (or syllables per word) and **complexity uniformity** | the stress-pattern, alliteration/assonance, and syllable-pattern-repetition metrics are derivatives of the same syllable counts. |
| Style drift | **drift pattern + mean chi-squared** | the window configuration and threshold tables are provenance, not signal. |

Caveats: n = 16 for the between-text numbers, so treat those correlations as
indicative rather than precise; the per-chunk matrix is much better powered but
answers the within-document question. All of the above assumes English prose at
a chunk size of 1,000 words. Corpus size, genre, and register all shift these
relationships, which is exactly why the library exposes them all in the first
place.
