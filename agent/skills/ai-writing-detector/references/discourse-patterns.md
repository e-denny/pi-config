# Discourse patterns (package layer)

The vendored engine (`scripts/patterns.js`) scores vocabulary, stock phrases,
and a few stylometric shapes. It cannot see **argument architecture**: how the
prose arranges and narrates its own case. A draft can pass every lexical check
and still read as machine-ordered because every paragraph announces its count,
explains its own structure, and grades its own moves.

`scripts/discourse.js` is the package-layer detector for that layer. It is not
part of the vendored engine, so the engine pin is untouched. It emits the same
issue shape (`type`, `text`, `severity`, `suggestion`) and the report layer
counts it in `bands.discourse_signals`, `discourse.*`, and `combined_score`.

Signals only. Never an authorship verdict. A pattern hit is a place to read
again, not proof.

## What it catches

| id | Tell | Severity |
| --- | --- | --- |
| `announced-enumeration` | Announced count then that many parallel slots: *Two conditions…*, *Three ratios…*, *at three levels*, *of two kinds* | medium |
| `metacommentary` | The prose narrates its own construction: *is part of the argument*, *The distinction is not academic*, *carries the weight*, *matters more than the symbols*, *it needs saying plainly*, *This chapter has…*, *That is what it means to say* | medium |
| `worth-framing` | Evaluative aside before the material arrives: *is worth keeping/having/naming/seeing* | medium |
| `catechetical-qa` | Question and a one-to-three-word answer, repeated: *What is the measure? Labour time.* | medium |
| `subtractive-reveal` | Essence staged by removal: *Strip away everything… and what remains is*, *boils down to* | medium |
| `dramatized-frame` | Drama announced before the claim: *contains a scandal*, *is easy to mistake for a technicality* | medium |
| `negated-tag` | Clipped appositive negation at the end of a clause: *the mechanism, not an obstacle to it*, *the normal case, not an exception*, *a contract, not a moral accusation* | medium |
| `imperative-reveal` | Staged imperative with a dramatic consequence: *Press on the profit and the answers arrive at once*, *Run the three together and the theory becomes…* | medium |
| `triple-definition` | Three-part parallel definition behind a semicolon: *X is…; Y is…; Z is…* | low |
| `parallel-scaffold` | Three or more consecutive sentences sharing a two-word opener frame: *Against the first… Against the second…*, *It is X. It is Y. It is Z.* | medium |

Two density advisories, not per-hit signals:

- `chapter-pointer-density` at >= 2.5 per 1k words. Chapter pointers are
  legitimate in a book's roadmap chapter; the advisory reports when the prose
  starts to read as a table of contents.
- `contrast-density` at >= 2 per 1k words of *rather than*. The frame is a
  legitimate distinction; at density it becomes the default sentence shape.

Per-paragraph cluster rule: a paragraph carrying two or more distinct ids adds a
`rhetorical-architecture` advisory naming them. One hit can be a stylistic
choice; a paragraph built from three is a scaffold.

Quoted spans are excluded from `negated-tag` and `imperative-reveal`. A negation
tail inside an attributed quotation belongs to the quoted writer, and the report
would otherwise score a quotation as the draft's own prose. The exclusion is a
plain double-quote parity count, so an unclosed quote silences the rest of the
paragraph.

## Calibration

The `negated-tag` tail is deliberately length-limited to a short noun phrase
(up to four words including the article). A long negation (*not the price of the
whole day's labour*) is ordinary prose; the tell is the clipped tag. The
`imperative-reveal` verb list is restricted to staged-demonstration verbs
(*press, strip, remove, run, reorder, change, turn, set, add*). Expository
setups (*suppose*, *consider*, *imagine*) and worked examples (*take a firm with
c = 50*) are excluded because they introduce material rather than stage a
reveal.

Three boundaries were widened after a second flagged-tell pass found them:

- The announced-count pattern tolerates a closing quote or bracket between the
  sentence terminator and the quantifier, because *…the prophets!" Two things
  follow…* was being skipped.
- The counting prepositions include *through*, so *the expression develops
  through four stages* is the same signal as *into two departments*.
- `metacommentary` covers *this chapter divides/turns/leaves/ends/begins/looks*,
  *in what follows*, and *for this chapter*; `worth-framing` covers *worth
  avoiding/considering/flagging/mentioning*.

The widened forms add one hit in ch02 and one or two each in four other
chapters of the 22-chapter book the change was calibrated against; they stay
quiet on the human-ops fixture.

## Reporting

The report gains:

- `bands.discourse_signals` — count
- `discourse.score` / `discourse.label` / `discourse.by_pattern` / `discourse.examples` / `discourse.advisories`
- `combined_score` — `score` (engine) + `discourse.score`, capped at 100. `--fail-above` uses the combined score.

When the engine score is low but discourse signals exist, the report adds a
warning saying so. That is the case the vocabulary-only engine used to report as
`score: 0, issues: 0`.

## What it does NOT do

It does not detect the tell from a single well-earned instance. It does not
score deliberate anaphora, procedures, specs, checklists, FAQs, interviews, or
fiction dialogue. It does not read attribution, so it cannot tell a writer's
voice from a scaffold. Treat every hit as an editorial prompt; the writer
decides.

## Carve-outs to apply by hand

- Announced counts in a procedure, spec, or checklist are structure, not a tell.
- `worth` framing that names audience and value is a real recommendation.
- A single structural signpost in a long technical document is useful. One
  "this chapter has" summary at the end of a chapter is a convention; four
  identical ones are the tell.
- Catechetical Q&A in an interview, FAQ, quiz, or dialogue is the genre.
- A `rather than` contrast that corrects a belief the reader holds is doing work.
- A negation tail that corrects a belief the reader holds, or where both halves
  carry information, is doing work. The tell is the repeated tag shape, not one
  negation. The count in `by_pattern` is the signal, not the individual hit.
- An imperative that hands the reader a real instruction (*Take the value of
  labour-power and divide by the wage*) is a procedure, not a reveal.
