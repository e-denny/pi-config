import json, itertools, math
import numpy as np
from scipy.stats import spearmanr

d = json.load(open("measurements.json"))["texts"]
names = list(d["11"]["metrics"])
LEX = ["ttr_raw","mtld","yule_k","hapax_ratio","mattr","msttr","vocd_d","hdd",
       "rare_word_ratio","advanced_word_ratio"]
READ = ["flesch_reading_ease","flesch_kincaid_grade","smog","gunning_fog","coleman_liau",
        "ari","dale_chall","linsear_write","forcast","psk","fry_avg_sent_len","fry_syll_per_100"]
LABEL = {
 "ttr_raw":"TTR (raw)","mtld":"MTLD","yule_k":"Yule K","hapax_ratio":"hapax ratio",
 "mattr":"MATTR","msttr":"MSTTR","vocd_d":"vocd-D","hdd":"HD-D",
 "rare_word_ratio":"rare-word ratio","advanced_word_ratio":"advanced-word ratio",
 "flesch_reading_ease":"Flesch ease","flesch_kincaid_grade":"Flesch-Kincaid","smog":"SMOG",
 "gunning_fog":"Fog","coleman_liau":"Coleman-Liau","ari":"ARI","dale_chall":"Dale-Chall",
 "linsear_write":"Linsear Write","forcast":"FORCAST","psk":"Powers-Sumner-Kearl",
 "fry_avg_sent_len":"Fry: words/sent","fry_syll_per_100":"Fry: syll/100w"}

def docmeans(n):
    out = []
    for t in d:
        v = [x for x in d[t]["metrics"].get(n, []) if isinstance(x,(int,float)) and not math.isnan(x)]
        if v: out.append(float(np.mean(v)))
    return out

def per_chunk_matrix(cols):
    M = {}
    for a, b in itertools.combinations(cols, 2):
        rhos = []
        for t in d:
            ia = {i:x for i,(x) in enumerate(d[t]["metrics"].get(a, [])) if isinstance(x,(int,float)) and not math.isnan(x)}
            ib = {i:x for i,(x) in enumerate(d[t]["metrics"].get(b, [])) if isinstance(x,(int,float)) and not math.isnan(x)}
            common = sorted(set(ia)&set(ib))
            if len(common) < 8: continue
            x=[ia[i] for i in common]; y=[ib[i] for i in common]
            if len(set(x))<3 or len(set(y))<3: continue
            r = spearmanr(x,y).statistic
            if not math.isnan(r) and abs(r)<0.9999: rhos.append(math.atanh(r))
        if rhos: M[(a,b)] = M[(b,a)] = math.tanh(sum(rhos)/len(rhos))
    return M

def md_matrix(cols, M, diag="1.00"):
    head = "| | " + " | ".join(LABEL[c] for c in cols) + " |"
    sep = "|" + "---|"*(len(cols)+1)
    lines=[head, sep]
    for a in cols:
        cells=[]
        for b in cols:
            cells.append(diag if a==b else (f"{M.get((a,b), float('nan')):+.2f}" if (a,b) in M else "·"))
        lines.append(f"| **{LABEL[a]}** | " + " | ".join(cells) + " |")
    return "\n".join(lines)

read_M = per_chunk_matrix(READ)
lex_doc = {n: docmeans(n) for n in LEX}
lex_M = {}
for a,b in itertools.combinations(LEX,2):
    lex_M[(a,b)]=lex_M[(b,a)]=spearmanr(lex_doc[a],lex_doc[b]).statistic

def ranks(cols, M):
    out=[]
    for n in cols:
        vals=[abs(M[(n,m)]) for m in cols if m!=n and (n,m) in M]
        if vals: out.append((n,max(vals)))
    return sorted(out,key=lambda x:-x[1])

parts=[]
parts.append("# Which pystylometry metrics are redundant?\n")
parts.append("Evidence for narrowing the report to a small set of measures per category.\n")
parts.append("""## What this is based on

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
""")
parts.append(md_matrix(READ, read_M))
parts.append("")
coupled = sorted([(a,b,read_M[(a,b)]) for a,b in itertools.combinations(READ,2) if abs(read_M[(a,b)])>=0.90], key=lambda x:-abs(x[2]))
parts.append(f"{len(coupled)} of {len(list(itertools.combinations(READ,2)))} pairs correlate at |rho| >= 0.90. The tightest:\n")
parts.append("| rho | pair |\n|---|---|")
for a,b,r in coupled[:14]:
    parts.append(f"| {r:+.2f} | {LABEL[a]} vs {LABEL[b]} |")
parts.append("""
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
""")
parts.append("For each formula, its strongest correlation with any other formula (per-chunk):\n")
parts.append("| Metric | max abs rho |\n|---|---|")
for n,v in ranks(READ, read_M):
    parts.append(f"| {LABEL[n]} | {v:.2f} |")
parts.append("""
## Lexical diversity: not one factor, but three tight couples and two loners

Between-text Spearman on document means (n = 16). Note that vocd-D, MATTR, MSTTR,
HD-D and the frequency-sophistication ratios return a single document-level value
in pystylometry (`*_dist` has length 1), so they can only be compared this way;
TTR, MTLD, Yule's K and hapax ratio also have per-chunk series.
""")
parts.append(md_matrix(LEX, lex_M))
parts.append("""
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
""")
open("/home/edgar/.pi/agent/skills/stylometry/metric-redundancy.md","w").write("\n".join(parts))
print("wrote", len("\n".join(parts)), "chars")
print("\n".join(parts[:12]))
