# AI Tells: Full Catalog

The complete reference the skill loads during a rewrite. Ordered by depth:
substance first (what no word list catches), diction last (the shallowest), with the
v0.4.0 cited-tell categories (cliché, naming, inflation, and rhetoric
calibration) added as category 10. Each entry gives the tell and at least one
`BAD →` / `GOOD →` pair.

Treat lexical lists as a floor, never proof. Banned-word lists age. The PubMed
excess-vocabulary study (arXiv 2406.07016) measured a roughly 25× jump in
"delves" in 2024 abstracts, and writers have since learned to avoid it. A clean
lexical pass does not make text human, and a single flagged word does not make
it AI. The deep categories (1, 7, 8) decide far more than the shallow ones.

---

## 1. Substance

The hardest tells and the most important. A regex cannot see these; you have to
read for them.

**Vacuity.** A sentence or paragraph you can delete with zero information loss.

- BAD → "Data infrastructure is a critical component of modern systems. It plays
  an important role in how organizations operate and is worth careful
  consideration."
- GOOD → (deleted; say something with content instead) "Pick the store before
  you know your access patterns and you'll rewrite it within a year."

**Restatement.** The conclusion repeats the intro in new words.

- BAD → "In conclusion, as discussed above, the key takeaway is that performance
  matters."
- GOOD → end on the last real point; cut the recap.

**Meta-commentary / throat-clearing.** Narrating the document instead of
writing it.

- BAD → "This report aims to explore the multifaceted landscape of..."
- GOOD → state the finding: "Three things decide the outcome."

**Conversational scaffolding / chatbot framing.** The assistant register
leaking into the page: openers, fake engagement, and sign-offs that belong in a
chat reply, not a document. The single most recognizable tell in pasted-from-chat
text.

- BAD → "Sure! Here's the thing about caching. Great question — let me break it
  down. I hope this helps!"
- GOOD → delete the scaffolding and open on the content: "Caching helps here only
  when reads dominate writes."

**Over-signposting / fake transitional glue.** "Furthermore", "Moreover",
"Additionally", "With that in mind", "As such" used as connective filler. The
test: a transition is earned only if removing it changes the logic.

- BAD → "Furthermore, the system is fast. Moreover, it scales. Additionally, it
  is secure."
- GOOD → drop the glue; let the sentences stand, and keep a transition only where
  it marks a real turn in the argument.

**The "it depends" / "no one-size-fits-all" non-conclusion.** The canonical AI
ending that commits to nothing (see also category 8, buried verdict).

- BAD → "Ultimately, the best choice depends on your specific needs and
  requirements."
- GOOD → commit: "Use Postgres unless you're past 50k writes/sec; then revisit."

**Fabricated specificity.** Invented numbers, sources, or detail to sound
precise.

- BAD → "This approach improves performance by up to 40%." (no source)
- GOOD → cite the measurement, or cut the number. Never invent one to add texture.

**Agent self-narration.** The writing describes its own analysis.

- BAD → "Our analysis determined that the GPU utilization was suboptimal."
- GOOD → "GPU sits at 22%."

**False agency.** An abstract or inanimate subject performing a human verb. AI
reaches for this because it lets a sentence sound active while dodging the actual
actor. A complaint doesn't *become* a fix; someone fixed it. Data doesn't *tell*
you anything; you read it and drew a conclusion. The fix is to name the human:
or, when no specific person fits, put the reader in the seat with "you." Never
invent an actor to satisfy the rule (that is fabrication). In `academic` prose,
"the data show" is a genuine convention and stays.

- BAD → "The complaint becomes a fix that week."
- GOOD → "The on-call engineer shipped the fix that week."
- BAD → "The market rewards speed, and the data tells us where to invest."
- GOOD → "Buyers pay for the faster product; the conversion logs show where the
  drop-off is."

**Telling instead of showing / vague declarative.** A sentence that *announces*
weight (structural, significant, deep, hard) without naming the specific thing.
It is vacuity wearing a serious face: cut it, or replace it with the concrete
fact it gestures at.

- BAD → "The implications are significant." / "The reasons are structural." /
  "This is genuinely hard."
- GOOD → name the implication: "If this ships late, the launch slips a quarter
  and the contract renewal lapses."

---

## 2. Structure & rhythm

The structural half of the problem: rhythm and variation. Highest
mechanical leverage after substance.

**Low variation.** Every sentence the same length and shape. The single
strongest mechanical tell.

- BAD → "The system is fast. The system is reliable. The system is scalable. The
  system handles load well." (all ~5 words, same shape)
- GOOD → "The system is fast. Under sustained write load it holds p99 latency
  below 10ms, which is the number that actually matters when traffic spikes, and
  it degrades gracefully past that. Reliable enough."

**Rule of three.** The reflexive tricolon, everywhere.

- BAD → "fast, reliable, and scalable"
- GOOD → vary to two or four, or a clause: "fast, and reliable under load."

**Bold-lead-in listicles.** Every bullet `- **Term:** explanation`.

- BAD → a list where all eight items open with a bolded term and a colon.
- GOOD → convert most to prose; keep plain bullets only where scanning helps.

**Antithesis / "not only… but also"** and **"not X, it's Y"**.

- BAD → "It's not just a tool, it's a complete solution."
- GOOD → say what it is: "It handles ingestion, indexing, and query in one
  process."

**Uniform openers.** Many sentences starting the same way ("The…", "This…",
"It's important…").

- BAD → six sentences in a row opening with "The platform".
- GOOD → vary subject and structure.

**Wh-opener crutch.** A run of sentences opening with *What / When / Why / How /
Which* ("What makes this hard is…", "Why does this matter?"). A specific,
high-frequency case of uniform openers and a Socratic-posturing tell; it
becomes a tell on a run of three or a high ratio. The fix is to lead
with the subject and name the thing.

- BAD → "What makes this hard is scale. Why does that matter? How do you know?"
- GOOD → "Scale is the hard part: at 50k writes/sec the index can't keep up."

**N-gram repetition.** The same bigram/trigram recurring.

- BAD → "in order to" four times; "it is important to" twice.
- GOOD → rephrase; most can simply be cut.

**Enumerated-promise opener.** Pre-announcing a count instead of just making the
points.

- BAD → "There are five key things to consider when choosing a database."
- GOOD → make the points; if a count helps the reader, it earns its place, but
  the list usually reads better without the throat-clear.

**Balanced-antithesis cadence.** Relentless two-part symmetry, beyond the literal
"not X, it's Y". The metronome rhythm is itself the tell.

- BAD → "It's not about speed; it's about reliability. Less talk, more action.
  Not a feature, but a philosophy."
- GOOD → break the symmetry; let one idea run long and the next land short.

**Colon overuse.** The "Label: explanation" reflex outside bullets ("The answer
is simple: ...", "Here's the catch: ...").

- BAD → "The result is clear: latency wins. The reason is simple: users feel it."
- GOOD → fold the clause into the sentence: "Latency wins because users feel it."

**Negative listing.** The multi-item striptease: listing what something is *not*
across two or more sentences before revealing what it *is*. Distinct from the
two-part "not X, it's Y" (that's antithesis); this is the three-beat runway. The
reader doesn't need it. State the answer.

- BAD → "It wasn't a tooling problem. It wasn't a staffing problem. It was a
  priorities problem."
- GOOD → "We had the tools and the people; we'd ranked the work wrong."

**Dramatic fragmentation / performative simplicity.** Sentence fragments staged
for profundity ("Speed. That's it. That's the tradeoff.", "X. And Y. And Z."). A
machine cadence in expository prose. Fragments are legitimate craft in
`creative`, `casual`, and terse `release_notes`, so the tell does not apply
there. Fix it only where
the genre is straight exposition.

- BAD → "You can only pick two. That's it. That's the tradeoff."
- GOOD → "Speed, quality, cost — pick two."

---

## 2b. The syntactic signature (current-model prose)

Everything in section 2 predates the current model generation. This section is
what is left once a model has been trained away from "delve" and "tapestry": the
prose is clean, organized, and grammatically distinctive. Measured on this repo's
corpus, participial tails and clefts together carry roughly a third of the
machine-made signal in realistic modern output, and none in 2023-era caricature.

Every construction below is ordinary English that good writers use deliberately.
The tell is the rate, never the instance; one appearance is never the finding.
Do not hunt these to zero; over-correcting is its own tell.

**Resultative participial tail** is a comma plus an
`-ing` verb that supplies the consequence of the main clause, appended to sentence
after sentence. It manufactures a sense of payoff for free, and because the tail
is grammatically subordinate it also slips a claim past unexamined.

- BAD → "The new system streams updates from the write path, ensuring that a
  document is searchable within seconds. We wrote a differ that replayed a week of
  queries, giving us a concrete list of the ones that disagreed."
- GOOD → "The new system streams updates from the write path. A document is
  searchable a few seconds after it is written. We wrote a differ and replayed a
  week of production queries against both clusters. Eleven of them disagreed."
- The test: if the tail were a separate sentence, would you still assert it? When
  the answer is no, the tail was decoration.

**Cleft**: the sentence defers its real subject to stage the
point. Three forms, one habit.

- Wh-cleft. BAD → "What actually consumed the time was the reconciliation."
  GOOD → "Reconciliation consumed the time."
- Reversed cleft. BAD → "The reason the migration was hard is that our relevance
  tuning had drifted." GOOD → "Our relevance tuning had drifted, and that is what
  made the migration hard."
- It-cleft. BAD → "It is the second call that fails." GOOD → "The second call
  fails."
- One cleft in a page is rhetoric and worth keeping. Four is a cadence, and it
  reads as a writer who reaches for the same frame every time a point arrives.

**Copula-only paragraphs**: everything simply *is*.

- BAD → "Data quality is a foundational concern. The main risk is inconsistency.
  The result is a pipeline that is difficult to reason about."
- GOOD → "Bad rows reach the warehouse and nobody notices for a week. By then the
  dashboard has been wrong in three meetings."
- This one correlates with the vacuity in section 1 more than with anything
  mechanical: a paragraph where nothing happens usually is not saying anything.

**Clause welding**: ", and it is…", ", but this
means…", four or five times a page. Correct English, and doing it repeatedly
flattens the prose into one continuous middle-length line, which is the same
defect as low variation, seen from the other side.

- BAD → "The change is small on paper, and it is large in practice, and it removes
  the nightly window that everything else was scheduled around."
- GOOD → "The change is small on paper. In practice it removes the nightly window
  that everything else had quietly been scheduled around."

**Templated openings**: every
paragraph opening with the same two words, every list item opening with the same
verb or the same `-ing` form. A reader skimming sees only the openings, so
repetition there is disproportionately visible.

- BAD → four bullets that all begin "Improving…", "Reducing…", "Increasing…".
- GOOD → let the items say different kinds of thing, or fold the list into a
  sentence.

**Stacked noun chains**: "the reduction of the complexity
of the design of the interface". Make one of the nouns the verb: "simplifying the
interface cut the design work."

## 3. Diction

The shallowest layer. Fix last. A swap that leaves the sentence vague is not an
improvement. Cut instead.

**Filler verbs/adjectives** (the bulk of AI's excess vocabulary, about 66% verbs,
~18% adjectives in the PubMed study):

- delve → examine; leverage → use; utilize → use; underscore → show; showcase →
  show; facilitate → help; foster → support; harness → use.
- robust, seamless, crucial, pivotal, vital, comprehensive, multifaceted,
  cutting-edge, revolutionary → usually cut; they add no information.
- intricate → complex; realm → area; myriad/plethora → many; elevate → raise.

**Clichés.** "at the end of the day", "when it comes to", "in today's digital
age".

- BAD → "When it comes to performance, at the end of the day it's about latency."
- GOOD → "Performance here means latency."

**Business jargon**: corporate buzzwords that
delete cleanly: synergy, leverage, circle back, touch base, move the needle,
low-hanging fruit, value-add, core competency, actionable, best-in-class,
operationalize, paradigm shift, thought leadership, north star, table stakes,
mission-critical, frictionless, empower, supercharge, disruptive.

- Keep a term that does work (a precise domain term a reader needs); cut a word
  you could delete with no loss of meaning. The test is whether the word carries
  information.
- BAD → "We leverage our synergies to operationalize best-in-class, actionable
  solutions."
- GOOD → "We share one data pipeline across both teams, which cut duplicated
  ETL work in half."
- BAD → "This is mission-critical and moves the needle for stakeholders."
- GOOD → "This blocks the launch until it's fixed."

**The "not X, it's Y" template** (also structural; see category 2).

**Weak intensifiers.** "really", "very", "quite", "extremely", "incredibly"
propping up a flabby adjective.

- BAD → "This is a really important and very powerful feature."
- GOOD → delete the intensifier; if the sentence weakens, the adjective was doing
  the work and needs a stronger word, not an amplifier: "This feature ships the
  whole release."

**Gratuitous reformulation.** "In other words", "Simply put", "To put it another
way" followed by a restatement. Often the second version is the only one worth
keeping.

- BAD → "Latency is the time to first byte. In other words, how long users wait."
- GOOD → "Latency is how long users wait for the first byte."

**Hype-verb class.** "revolutionize", "transform", "unlock", "empower",
"supercharge", "elevate". The verb cousins of puffery; cut or replace with the
concrete action.

- BAD → "This unlocks new potential and empowers teams to supercharge delivery."
- GOOD → "This lets two teams share one pipeline, which cut release time in half."

---

## 4. Sourcing

**Vague attribution.** Authority with no source.

- BAD → "Studies suggest that..."; "Experts believe..."; "It is widely known..."
- GOOD → name the source ("the 2024 MLPerf results show...") or cut the claim.

**Redundancy / pleonasm.** A word that pays for nothing.

- BAD → "end result", "close proximity", "new innovation", "past history",
  "completely eliminate".
- GOOD → "result", "proximity", "innovation", "history", "eliminate".

**Tailing significance clause.** An empty "highlighting/underscoring its X"
tacked on.

- BAD → "...reduced latency, highlighting its commitment to performance."
- GOOD → cut the clause, or give a real consequence: "...reduced latency, which
  let us drop two cache layers."

---

## 7. Consistency

One author holds one voice and one set of materials. Drift reads as machine even
when every sentence is clean.

**Terminology drift.** One concept, several names.

- BAD → "the model" → "the LLM" → "the network" → "the system", all for the same
  thing.
- GOOD → pick one term and keep it.

**Dialect drift.** Mixed American/British spelling.

- BAD → "optimize" in one paragraph, "optimise" in the next; "color" and
  "colour".
- GOOD → one dialect throughout.

**Heading-case drift.** Title Case headings mixed with sentence case.

- GOOD → pick one convention and hold it.

**Voice/tense drift.** Findings in present tense, then past, then back.

- GOOD → one tense for findings, one author voice end to end.

---

## 8. Stance & evaluation

The deepest human quality: judgment. A flawless but non-committal survey still
reads as AI. This is what most separates human writing from machine writing.

**Fence-sitting / false balance.** Presenting options as equally valid to avoid
committing.

- BAD → "There are several approaches, each with its own tradeoffs and merits."
- GOOD → "Use FSDP. Pipeline parallelism wins only above 70B parameters, and you
  aren't there."

**Buried verdict.** The recommendation arrives last, hedged.

- BAD → three paragraphs of survey, then "it may be worth considering option B."
- GOOD → lead with the verdict, then justify it.

**Missing mechanism.** A claim with no "why".

- BAD → "Postgres is the better choice here."
- GOOD → "Postgres is the better choice: you keep transactional guarantees and
  mature access-control tooling while partitioning handles write scale."

**Asymmetric tradeoffs stated as symmetric.** Real choices are usually lopsided.

- GOOD → "NoSQL scales further, but you'd rebuild consistency and access control
  by hand — the wrong place to economize for regulated data."

**Naming genuine limits.** Honest stance, not hedging.

- GOOD → "Not load-tested past 50k writes/sec, and this assumes a single region."

---

## 9. Punctuation & mechanics (dashes, repetition, spacing)

Mechanical correctness (dash style, doubled words, spacing) plus the
consistency rules around them. These are
universal-core: wrong in every register.

### Dashes: use the right mark, and stay consistent

Three marks, three jobs. Mixing them up, or overusing the em-dash, is one of the
loudest AI tells.

- **Hyphen `-`** joins compound modifiers only: *well-known*, *state-of-the-art*,
  *read-only*. It is never a sentence connector.
- **En-dash `–`** is for ranges and spans: *10–20 requests*, *2024–25*,
  *pages 30–34*. Not a pause in a sentence.
- **Em-dash `—`** is one of the loudest AI tells. Outside the `creative`
  register, replace nearly all of them with a comma, period, colon, or
  parentheses. *Vary* the mark so you don't trade the dash signature for a
  uniform comma signature. A paired aside becomes an appositive
  (`result — which surprised us — held` → `result, which surprised us, held`); a
  single dash usually wants a period or a colon. Reserve the em-dash for
  `creative`, where wide cadence is the genre's tool. The rewrite pass converts
  em-dashes (and `--`, spaced hyphens, non-numeric en-dashes) to commas, then
  upgrades to a period, colon, or parenthesis where those read better.

Hard rules:

- **Never use `--` or a spaced hyphen ` - ` as a dash.** That is raw draft
  markup, not typography.
  - BAD → "The migration was risky -- we staged it." / "The plan - in short - worked."
  - GOOD → "The migration was risky, so we staged it." / "The plan worked, in short."
- **Pick one em-dash spacing and hold it.** American style sets it tight
  (`risk—we`); journalistic/British style spaces it (`risk — we`). Either is
  fine; mixing both in one document is a drift tell.
- **Em-dash overuse is the headline tell.** Two or more dashed asides in a short
  passage reads as machine cadence even when each is grammatical.
  - BAD → "The result — which surprised us — held up — mostly — under load."
  - GOOD → "The result surprised us. It held up under load, mostly."

### Repetition: three kinds, three fixes

- **Doubled words** ("the the", "to to", "is is") are editing typos. Cut the
  duplicate. (A real "that that" or "had had" is grammatical and stays.)
  - BAD → "We we shipped it." → GOOD → "We shipped it."
- **Phrase repetition.** The same bigram/trigram recurring ("it is important
  to" twice, "in order to" four times). Rephrase or cut; see category 2.
- **Structural repetition.** Consecutive sentences with the same opening
  ("This lets… This means… This is…"). Vary the subject and shape; see category 2.

The one repetition you *keep*: a single term per concept (don't rotate
"the model" / "the LLM" / "the network"). That is terminology consistency
(category 7), not the repetition to fix. Repeating a precise name is correct;
repeating a sentence shape is the tell.

### Spacing & punctuation mechanics

- **No space before** `,` `;` `:` `!` `?`; exactly one space after. ("done ,"
  and "ready ?" are errors.)
- **One terminal mark.** Not "!!", "??", or "?!?". One period or one question
  mark. (Interrobang `?!` is a rare, deliberate exception, casual/creative only.)
- **One sentence-spacing convention** (one space or two) held throughout, not mixed.
- **One quote style.** Don't mix straight (`"`) and curly (`"` `"`) quotes, or
  straight and curly apostrophes, in the same document.
- **One ellipsis style** (`…` or `...`), not both.

---

## 10. Cliché, naming, and inflation

The categories below were added in v0.4.0 from the cited-tell evidence
(JCarterJohnson/vibecoded-design-tells, MIT; oberskills, MIT) and Pangram Labs'
phrase-overuse measurements. They sit between diction and substance: each is a
specific, high-frequency reflex a reader recognizes on sight.

**Cliché metaphor.** The stock figurative phrase reached for instead of the
literal fact. AI defaults to a small set: *foundation*, *landscape*, *journey*,
*double-edged sword*, *tapestry*.

- BAD → "Building on this foundation, we navigate the evolving landscape of our
  data journey, a double-edged sword of opportunity and risk."
- GOOD → "We added partitioning to the existing schema. It cut query time but
  doubled the write path's complexity."

**Name selection.** Invented people skew hard to a few names. AI reaches for
*Emily* and *Sarah* in 63-70% of generated examples and over-uses the *Dr.* title.
A cast that is all Emilys and Doctors reads as synthetic.

- BAD → "Dr. Emily Carter and Dr. Sarah Chen led the study."
- GOOD → use varied, ordinary names, or better, name the real person, or cut
  the example. Never invent a person to add texture.

**Significance inflation.** Empty phrases that assert importance without earning
it: *opens new avenues*, *paves the way*, *cannot be overstated*, *marks a turning
point*.

- BAD → "This opens new avenues and paves the way for progress whose importance
  cannot be overstated."
- GOOD → name the consequence: "This lets the next team skip the manual ETL step,
  which was the slowest part of onboarding."

**Superlative creep.** Claims that outrun the evidence. *Best*, *most powerful*,
*revolutionary*, *unprecedented* applied to ordinary results. Match the claim to
what you measured.

- BAD → "This is the most powerful, revolutionary approach to caching available."
- GOOD → "This cache cut p99 read latency from 80ms to 30ms on our workload."

**Sycophancy.** Reflexive praise and agreement bleeding into prose: "Great
question!", "You're absolutely right", "Excellent point". One of the top cited
tells, and no word list catches all of it; read for the reflex.

- BAD → "Great question! You're absolutely right that caching matters here."
- GOOD → "Caching matters here because reads outnumber writes ten to one."

**Aidiolect phrases.** Multi-word collocations AI over-produces by huge margins.
Pangram Labs measured the overuse rate against a human baseline: *as a poignant*
~49,000x, *as a powerful reminder* ~43,000x, *faced numerous challenges* ~30,000x,
*the complex interplay* ~21,000x, *vibrant tapestry* ~17,000x, *in the
ever-evolving* ~11,000x. Any of these is a near-certain tell.

- BAD → "In the ever-evolving landscape, the complex interplay of forces is a
  powerful reminder of our vibrant tapestry."
- GOOD → cut every phrase and state the actual point, or delete the sentence.

**Rhetoric calibration.** The governing rule for this whole section: **claim
strength must not exceed evidence strength.** Two-thirds of AI outputs are
rhetorically stronger than the human original they replace; rhetoric intensity
correlates with estimated LLM usage at r=0.904. So the safest default is to
*understate*. If you measured a 40% drop, say 40%, not "dramatic." If you have one
example, don't say "consistently." Significance inflation, superlative creep,
and aidiolect phrases all serve this one rule.

- BAD → "This revolutionary result dramatically transforms how we think about
  latency."
- GOOD → "This cut median latency by a third in our one test; we haven't checked
  it under sustained load."

