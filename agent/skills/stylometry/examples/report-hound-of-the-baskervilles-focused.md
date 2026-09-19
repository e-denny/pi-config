# Stylometric Analysis: The Hound of the Baskervilles

A stylometric profile of The Hound of the Baskervilles, produced with [pystylometry](https://github.com/craigtrim/pystylometry) at a chunk size of 1,000 words. One table holds every metric. Focused profile: readability is limited to Flesch-Kincaid and Dale-Chall, and lexical diversity to MTLD, MATTR, and rare-word ratio; `--all-metrics` reports the full set. Findings follow for Text Summary, Lexical Metrics, Readability Metrics, Syntactic Metrics, Character-Level Metrics, N-gram Entropy Metrics, Style Markers, Genre and Register, Dialect, Style Drift, Rhythm and Prosody, Cohesion and Coherence, Additional Lexical Profile.

---

## Text Summary

by Arthur Conan Doyle (1902), detective fiction. Source file: `doyle-the-hound-of-the-baskervilles.txt`.

---

## Consolidated Metrics

Every metric computed for this text, in one table (218 rows). The findings for each category follow, in the same order as the categories here. Use `--with-detail` to expand each category into its own metric tables.

| Category | Metric | Value |
|---|---|---|
| Text | Title | The Hound of the Baskervilles |
| Text | Author | Arthur Conan Doyle |
| Text | Year | 1902 |
| Text | Genre | detective fiction |
| Text | Source file | `doyle-the-hound-of-the-baskervilles.txt` |
| Text | Characters | 353,192 |
| Text | Tokens (whitespace) | 59,112 |
| Text | Sentences (segmenter) | 4,049 |
| Text | Paragraphs (segmenter) | 1,485 |
| Text | Types (distinct words) | 5,831 |
| Text | Chunk size (words) | 1,000 |
| Text | Generated | 2026-09-17 22:57 |
| Lexical | MTLD forward | 65.14 |
| Lexical | MTLD backward | 64.80 |
| Lexical | MTLD average | 64.97 |
| Lexical | MATTR | 0.8268 |
| Lexical | MATTR std dev | 0.0538 |
| Lexical | MATTR window size | 50 |
| Lexical | Rare word ratio | 0.3205 |
| Lexical | Common word ratio | 0.6707 |
| Readability | Flesch-Kincaid grade | 6.61 |
| Readability | Dale-Chall score | 8.01 |
| Readability | Dale-Chall difficult word ratio | 0.2256 |
| Readability | Dale-Chall grade | 11-12 |
| Syntactic | Noun ratio | 0.1985 |
| Syntactic | Verb ratio | 0.1258 |
| Syntactic | Adjective ratio | 0.0652 |
| Syntactic | Adverb ratio | 0.0543 |
| Syntactic | Noun-verb ratio | 1.5776 |
| Syntactic | Adjective-noun ratio | 0.3287 |
| Syntactic | Lexical density | 0.4439 |
| Syntactic | POS function word ratio | 0.2837 |
| Syntactic | Sentence count | 3,297 |
| Syntactic | Mean sentence length (words) | 17.96 |
| Syntactic | Sentence length std dev | 11.18 |
| Syntactic | Min sentence length | 1.0 |
| Syntactic | Max sentence length | 77.0 |
| Syntactic | Sentence length range | 76.0 |
| Syntactic | Mean parse tree depth | 5.04 |
| Syntactic | Max parse tree depth | 17 |
| Syntactic | T-unit count | 3,297 |
| Syntactic | Mean T-unit length (words) | 23.16 |
| Syntactic | Clausal density | 2.6621 |
| Syntactic | Dependent clause ratio | 0.4997 |
| Syntactic | Passive voice ratio | 0.1089 |
| Syntactic | Subordination index | 0.2453 |
| Syntactic | Coordination index | 0.1246 |
| Syntactic | Sentence complexity score | 0.6962 |
| Syntactic | Dependency distance | 3.4509 |
| Syntactic | Left branching ratio | 0.4440 |
| Syntactic | Right branching ratio | 0.5560 |
| Syntactic | Simple sentence ratio | 0.2872 |
| Syntactic | Simple sentence count | 947 |
| Syntactic | Compound sentence ratio | 0.0607 |
| Syntactic | Compound sentence count | 200 |
| Syntactic | Complex sentence ratio | 0.4495 |
| Syntactic | Complex sentence count | 1,482 |
| Syntactic | Compound-complex sentence ratio | 0.2026 |
| Syntactic | Compound-complex sentence count | 668 |
| Syntactic | Declarative ratio | 0.9275 |
| Syntactic | Declarative count | 3,058 |
| Syntactic | Interrogative ratio | 0.0334 |
| Syntactic | Interrogative count | 110 |
| Syntactic | Imperative ratio | 0.0200 |
| Syntactic | Imperative count | 66 |
| Syntactic | Exclamatory ratio | 0.0191 |
| Syntactic | Exclamatory count | 63 |
| Syntactic | Structural diversity (entropy) | 1.7474 |
| Syntactic | Functional diversity (entropy) | 0.4864 |
| Syntactic | Sentences classified | 3,297 |
| Character | Average word length (chars) | 4.15 |
| Character | Average sentence length (chars) | 80.05 |
| Character | Punctuation density (per 100 words) | 13.61 |
| Character | Punctuation variety | 6 |
| Character | Vowel-consonant ratio | 0.6158 |
| Character | Digit count | 93 |
| Character | Digit ratio | 0.000285 |
| Character | Uppercase ratio | 0.0290 |
| Character | Whitespace ratio | 0.1871 |
| Character | Most frequent letter | e (12.2%) |
| N-grams | Character bigram entropy (bits) | 7.6179 |
| N-grams | Character bigram perplexity | 196.89 |
| N-grams | Word bigram entropy (bits) | 9.6558 |
| N-grams | Word bigram perplexity | 822.30 |
| N-grams | Word trigram entropy (bits) | 15.5349 |
| N-grams | Word 4-gram entropy (bits) | 15.8025 |
| N-grams | Character trigram entropy (bits) | 9.9447 |
| N-grams | Character 4-gram entropy (bits) | 11.8832 |
| N-grams | POS trigram entropy (bits) | 8.7794 |
| N-grams | Distinct word trigrams | 52,147 |
| N-grams | Distinct word 4-grams | 57,836 |
| N-grams | Top word trigram | upon the moor (45) |
| Markers | Contraction ratio | 0.0000 |
| Markers | Contraction count | 0 |
| Markers | Expanded form count | 1,280 |
| Markers | Intensifier density (per 100 words) | 1.84 |
| Markers | Intensifier count | 1,101 |
| Markers | Hedging density (per 100 words) | 0.52 |
| Markers | Hedging count | 311 |
| Markers | Modal density (per 100 words) | 1.92 |
| Markers | Epistemic modal ratio | 0.7250 |
| Markers | Deontic modal ratio | 0.3969 |
| Markers | Negation density (per 100 words) | 1.42 |
| Markers | Negation count | 851 |
| Markers | Exclamation density (per 100 words) | 0.30 |
| Markers | Question density (per 100 words) | 0.86 |
| Markers | Quotation density (per 100 words) | 0.00 |
| Markers | Parenthetical density (per 100 words) | 0.02 |
| Markers | Ellipsis density (per 100 words) | 0.00 |
| Markers | Dash density (per 100 words) | 0.26 |
| Markers | Semicolon density (per 100 words) | 0.08 |
| Markers | Colon density (per 100 words) | 0.03 |
| Genre | Register classification | frozen |
| Genre | Predicted genre | conversational |
| Genre | Genre confidence | 0.6901 |
| Genre | Formality score | 0.21 |
| Genre | Latinate ratio | 0.0385 |
| Genre | Nominalization density | 1.43 |
| Genre | Passive voice density | 0.52 |
| Genre | First person ratio | 0.3956 |
| Genre | Second person ratio | 0.1281 |
| Genre | Third person ratio | 0.4763 |
| Genre | Impersonal construction density | 0.88 |
| Genre | Abstract noun ratio | 0.6317 |
| Genre | Concrete noun ratio | 0.3683 |
| Genre | Abstractness score | 0.2826 |
| Genre | Technical term density | 0.18 |
| Genre | Narrative marker density | 1.96 |
| Genre | Expository marker density | 0.31 |
| Genre | Dialogue ratio | 0.0000 |
| Genre | Fiction score | 0.5896 |
| Genre | Academic score | 0.4540 |
| Genre | Journalistic score | 0.2609 |
| Genre | Legal score | 0.3587 |
| Genre | Conversational score | 0.6505 |
| Dialect | Dialect | mixed |
| Dialect | Dialect confidence | 0.8823 |
| Dialect | British score | 0.0909 |
| Dialect | American score | 0.1152 |
| Dialect | Markedness score | 0.0776 |
| Dialect | Eye dialect count | 11 |
| Dialect | Eye dialect ratio (per 1000 words) | 0.18 |
| Dialect | Dialect chunks | 60 |
| Dialect | Dialect chunk size (words) | 1,000 |
| Dialect | British score std dev | 0.0563 |
| Dialect | American score std dev | 0.0634 |
| Drift | Status | success |
| Drift | Pattern | consistent |
| Drift | Pattern confidence | 0.8000 |
| Drift | Mean chi-squared | 342.44 |
| Drift | Std chi-squared | 25.15 |
| Drift | Max chi-squared | 433.40 |
| Drift | Min chi-squared | 235.85 |
| Drift | Trend slope | -0.1631 |
| Drift | Drift windows | 116 |
| Drift | Drift window size (words) | 1,000 |
| Drift | Drift stride (words) | 500 |
| Drift | Drift overlap ratio | 0.5000 |
| Prosody | Mean syllables per word | 1.3310 |
| Prosody | Syllable std dev | 0.6690 |
| Prosody | Rhythmic regularity | 1.9896 |
| Prosody | Syllable CV | 0.5026 |
| Prosody | Stress pattern entropy (bits) | 1.8525 |
| Prosody | Polysyllabic ratio | 0.0699 |
| Prosody | Monosyllabic ratio | 0.7585 |
| Prosody | Alliteration density | 3.0466 |
| Prosody | Assonance density | 17.9222 |
| Prosody | Consonance density | 20.1954 |
| Prosody | Sentence length alternation | 0.6522 |
| Prosody | Sentence rhythm score | 0.6934 |
| Prosody | Iambic ratio | 0.2651 |
| Prosody | Trochaic ratio | 0.6351 |
| Prosody | Sentences analysed (syllables) | 4,045 |
| Prosody | Std syllables per sentence | 14.64 |
| Prosody | Sentence syllable CV | 0.7646 |
| Prosody | Mean sentence complexity | 1.3399 |
| Prosody | Std sentence complexity | 0.2885 |
| Prosody | Complexity uniformity score | 0.8229 |
| Prosody | Syllable patterns: unique | 1,057 |
| Prosody | Syllable patterns: instances | 139,380 |
| Prosody | Pattern diversity ratio | 0.008 |
| Prosody | Repeated pattern count | 745 |
| Prosody | Repetition ratio | 0.705 |
| Prosody | Pattern entropy (bits) | 4.800 |
| Prosody | Starting pattern repetition | 0.055 |
| Prosody | Ending pattern repetition | 0.073 |
| Cohesion | Pronoun density (per 100 words) | 16.20 |
| Cohesion | Demonstrative density (per 100 words) | 2.68 |
| Cohesion | Anaphora count | 9,595 |
| Cohesion | Anaphora resolution ratio | 1.0000 |
| Cohesion | Word repetition ratio | 0.5473 |
| Cohesion | Content word overlap | 0.0163 |
| Cohesion | Connective density (per 100 words) | 7.25 |
| Cohesion | Additive connective ratio | 0.3998 |
| Cohesion | Adversative connective ratio | 0.1464 |
| Cohesion | Causal connective ratio | 0.2803 |
| Cohesion | Temporal connective ratio | 0.1735 |
| Cohesion | Adjacent sentence overlap | 0.0163 |
| Cohesion | Mean sentence similarity | 0.0081 |
| Cohesion | Paragraph topic consistency | 0.0288 |
| Cohesion | Semantic coherence score | 0.2973 |
| Cohesion | Discourse structure score | 0.9000 |
| Cohesion | Paragraph count | 1,485 |
| Cohesion | Mean paragraph length (sentences) | 2.71 |
| Extras | BNC total tokens | 59,270 |
| Extras | BNC unique tokens | 5,729 |
| Extras | BNC overused words | 3,795 |
| Extras | BNC underused words | 1,115 |
| Extras | Words not in BNC | 117 |
| Extras | Most overused word | lestrade (16,890x expected) |
| Extras | Slop score | 58,738.1556 |
| Extras | Flagged repetitive words | 1,234 |
| Extras | Flagged words per 10,000 | 488.64 |
| Extras | Mean repetition score | 120.2085 |
| Extras | Content words | 25,254 |
| Extras | Flagged repeated n-grams | 368 |
| Extras | Flagged n-grams per 10,000 | 39.09 |
| Extras | Repeated n-gram candidates | 94,147 |

---

## Lexical Metrics

An MTLD of 64.97 is moderate lexical diversity. MTLD is length-independent, so unlike raw TTR it can be compared directly with other texts. The forward and backward passes (65.14 and 64.80) agree closely, which means the figure is not an artefact of reading direction.

A MATTR of 0.8268 over a 50-word window means high local vocabulary diversity: within any short stretch of text, this much of the vocabulary is new. Window TTR ranges from 0.54 to 0.98, and the standard deviation (0.0538) shows how much that varies.

Rare-word ratio: 32.0% of tokens sit beyond rank 10,000 in the reference corpus, against 67.1% inside the top 1,000. The median token sits at rank 102. This is a vocabulary-sophistication measure, not a diversity one: it says how unusual the words are, where MTLD and MATTR say how much they vary.

---

## Readability Metrics

Flesch-Kincaid puts the text at grade 6.6; Dale-Chall scores 8.01 (grade 11-12), on the strength of 22.6% of words being outside its familiar-word list. Dale-Chall reads 4.4 grades above Flesch-Kincaid. Flesch-Kincaid weights sentence length heavily and Dale-Chall weights unfamiliar vocabulary, so the gap points at vocabulary rather than sentence construction — though Dale-Chall is calibrated on texts for young readers and always runs high on adult prose.

---

## Syntactic Metrics

A noun-to-verb ratio of 1.5776 is nominal. Noun-heavy writing foregrounds entities and description, verb-heavy writing foregrounds action; the balance shifts reliably with genre, which is why it is a standard register marker. Lexical density of 0.4439 puts 44.4% of tokens in content-word classes.

Mean sentence length of 17.96 words is short-to-moderate, with a standard deviation of 11.18. Sentences run from 1 word to 77 words across 3297 sentences. If the standard deviation is a large fraction of the mean, the text is deliberately varying its sentence lengths rather than holding to a rhythm.

Clausal density of 2.6621 clauses per T-unit is hypotactic, with a mean parse-tree depth of 5.04 (max 17). The text is moderately passive at 10.9% of clauses, and it is predominantly right-branching (55.6% right vs 44.4% left). Mean dependency distance of 3.45 words measures how far modifiers sit from what they modify, and tracks working-memory load for a reader.

The dominant structure is complex (44.9% of 3297 sentences) and the dominant function is declarative (92.8%). Complex and compound-complex sentences together account for 65.2% of the total against 34.8% simple and compound, so clauses are stacked by subordination rather than chained by coordination. Measured as entropy, the text varies its sentence shapes (1.7474 bits) more than its sentence purposes (0.4864 bits).

---

## Character-Level Metrics

Average word length of 4.15 characters and 13.61 punctuation marks per 100 words are typical of English prose. 9 of the nine most common letters here (e, t, a, o, i, h, n, s, r) belong to the standard ETAOIN SHRDLU ordering, so the character inventory is unremarkable — which is itself worth knowing, because it means the text carries no obvious cipher or heavy non-English material.

---

## N-gram Entropy Metrics

Character bigram entropy of 7.6179 bits (perplexity 196.8906) shows how predictable the orthography is, while word bigram entropy of 9.6558 bits (perplexity 822.2979) shows how predictable the collocations are. High word-level perplexity relative to character-level means the text is locally spellable but not locally formulaic: few fixed phrases, many fresh word pairings.

The most repeated word trigram is "upon the moor" at 45 occurrences, out of 52,147 distinct trigrams; word trigram entropy is 15.5349 bits.

---

## Style Markers

The text shows no contractions at all, which is a formal, largely expository surface. Intensifier density is 1.84 per 100 words against hedging density of 0.52. Intensifiers outnumber hedges by about 3.5 to 1, which is an emphatic rather than a qualifying voice. 72.5% of the modals are epistemic (possibility and inference: may, might, could) against 39.7% deontic (obligation and permission: must, should) (The two modal ratios sum to 1.1218, above 1: the library classifies modals into the two categories independently, so some modals count in both.). Because epistemic modality leads, the writing is more likely to speculate than to instruct. Semicolons run at 0.08 and exclamation marks at 0.30 per 100 words. Quotation density reads as zero despite the text containing quotation marks, because curly quotes are not matched by the counter; treat the quotation and dialogue figures in this report as lower bounds.

---

## Genre and Register

The register classifier puts this at "frozen" with a formality score of 0.21 out of 100, and predicts the genre "conversational" with confidence 0.69. Narrative markers (1.96 per 100 words) run against expository markers (0.31), and estimated dialogue covers 0.0% of the text. The register label and the formality score disagree here — "frozen" is not usually compatible with a formality score of 0.21 — so take the label as unreliable for this text. Dialogue ratio reads as zero despite the text containing quoted speech, because curly quotes are not matched by the counter.

---

## Dialect

The marker inventory classifies this as mixed English with confidence 0.88 (British 0.0909 vs American 0.1152). Markedness of 0.0776 measures how far the text departs from unmarked standard English; low markedness means few diagnostic choices were available to be made. Note the variance across chunks (std 0.0563 for British markers) before treating this as a single consistent author: dialect markers are sparse, so a mixed score is weak evidence, and 60 chunks is the denominator those means rest on.

---

## Style Drift

Over 116 windows of 1,000 words with a stride of 500 (50.0% overlap, sequential comparison), the chi-squared distance between adjacent windows averages 342.44 with a standard deviation of 25.15, peaking at 433.40. The classifier calls the pattern "consistent" with confidence 0.80 and a trend slope of -0.1631. "Consistent" means no window stands out from its neighbours; "gradual_drift" means the distance changes steadily across the text; "sudden_spike" means one boundary does, which is what pasted or freshly edited material usually looks like. The single most divergent boundary sits between windows 58 and 59 (433.40), where the words driving the distance are we, the, she, i, that.

---

## Rhythm and Prosody

1.3310 syllables per word with a standard deviation of 0.6690 gives a rhythmic regularity of 1.9896. The stress-pattern entropy of 1.8525 bits measures how varied the sound shapes are, and alliteration density (3.0466 pairs per 100 words) captures deliberate sound repetition. 7.0% of words are three syllables or longer, which is where prose rhythm usually starts to feel weighted.

Across 4,045 sentences the average is 19.14 syllables with a standard deviation of 14.64. The complexity uniformity score is 0.82; above about 0.80 is the band where sentences look machine-uniform rather than hand-varied.

Syllable-pattern repetition is 0.705 (70.5% of syllable n-grams recur), with 5.5% of sentence openings repeating a known pattern.

---

## Cohesion and Coherence

Pronoun density of 16.20 and connective density of 7.25 per 100 words are the two workhorses of cohesion here. Adjacent-sentence overlap of 0.0163 says how much vocabulary carries from one sentence to the next; a low figure with a high pronoun density is the signature of reference-by-pronoun rather than reference-by-repetition. The composite semantic coherence score is 0.2973 across 1485 paragraphs averaging 2.71 sentences each.

---

## Additional Lexical Profile

Against BNC frequencies, 3,795 words are overused, 1,115 are underused, and 117 do not appear in the corpus at all. The most overused are lestrade (16,890x), woman's (15,201x), cannot (9,289x), friend's (8,445x), lady's (8,445x); the extreme ratios are proper nouns and coinages the reference corpus has never seen, so read them as topic words rather than as style.

Repetition detection flags 1,234 content words (488.6 per 10,000) with a slop score of 58,738.2. Ranked by how far they exceed corpus expectations, the highest-scoring are merripit (15 uses), lafter (5 uses), vandeleur (4 uses), fernworthy (3 uses), lestrade (10 uses).

368 repeated n-grams were flagged out of 94,147 candidates (39.1 per 10,000). The top repeated collocation is "the moor" (140).

---

## Appendix

**Focused profile.** Readability is represented by Flesch-Kincaid and Dale-Chall, and lexical diversity by MTLD, MATTR, and rare-word ratio. The other readability formulas correlate 0.92-0.99 with Flesch-Kincaid, and the other diversity measures duplicate MTLD, MATTR, or the hapax/TTR pair; `--all-metrics` restores them. The evidence is in `evidence/metric-redundancy.md` next to this skill.

Every figure in the table above comes from the pystylometry library; this report only formats the values and applies the published bandings in the findings. Generated 2026-09-17 22:57 from `/tmp/pi-github-repos/runtime-uckyGZ/1ded2a90e704142939843b95c597b9df021446b5665aa07bde2ae57421ac2379/tests/fixtures/doyle-the-hound-of-the-baskervilles.txt` in 110.7 s, with `--chunk-size 1000` and drift windows of 1,000 words striding 500. Environment: Python 3.12.12, pystylometry 1.4.3 (https://github.com/craigtrim/pystylometry), spacy 3.8.16, cmudict 1.1.3, bnc-lookup 1.5.0, openpyxl 3.1.5.

**Skipped metrics:** none.

**References**

- Guiraud, P. (1960). *Problemes et methodes de la statistique linguistique*.
- Flesch, R. (1948). A new readability yardstick. *Journal of Applied Psychology*.
- McCarthy, P. M., & Jarvis, S. (2010). MTLD, vocd-D and HD-D: a validation study. *Behavior Research Methods*.
- Kilgarriff, A. (2001). Comparing corpora. *International Journal of Corpus Linguistics*.
- Burrows, J. (2002). Delta: a measure of stylistic difference. *Literary and Linguistic Computing*.
