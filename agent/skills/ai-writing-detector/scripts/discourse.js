"use strict";

/**
 * Package-layer discourse analyzer for ai-writing-detector.
 *
 * The vendored engine (patterns.js) matches vocabulary, phrases, and a few
 * stylometric shapes. It cannot see argument architecture: announced-count
 * enumerations, sentences that narrate the argument's own construction,
 * evaluative asides, catechetical Q&A, subtraction-to-essence reveals,
 * imperative-and-consequence staging, and appositive negation tags.
 * Those tells survive vocabulary cleanup, which is why a long, heavily edited
 * chapter can score 0 while reading as machine-ordered.
 *
 * This module is NOT part of the vendored engine. It is the skill's own layer,
 * like report.js. It emits the same issue shape the engine uses so the report
 * layer can count, bucket, and display the hits. Signals only; never
 * authorship proof.
 *
 * Pattern catalog counterpart: humanizer/references/pattern-catalog.md
 * patterns 9 and 107-114. Rationale: references/discourse-patterns.md.
 */

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

// Nouns that turn a number into an announced list. Kept explicit so the
// pattern does not fire on every "three" in the language.
const COUNT_NOUNS =
  "conditions?|questions?|ratios?|levels?|things?|parts?|reasons?|ways?|stages?|" +
  "kinds?|forms?|points?|elements?|factors?|layers?|modes?|routes?|faces?|steps?|" +
  "mechanisms?|dimensions?|errors?|claims?|charges?|defences?|defenses?|readings?|" +
  "phases?|regimes?|variants?|strands?|schools?|types?|positions?|senses?|" +
  "functions?|moments?|movements?|periods?|traditions?|departments?|cases?|axes?|" +
  "poles?|answers?|propositions?|requirements?|tasks?|rules?|principles?|sources?|" +
  "camps?|theorems?|identities?|gaps?|fields?|spheres?|readings?";

const QUANTIFIERS = "Two|Three|Four|Five|Six|Seven|Several|A few|Many";

/**
 * Each pattern: id, name, severity, suggestion, and a find(text) or regex.
 * `regex` entries run globally over the cleaned prose.
 */
const PATTERNS = [
  {
    id: "announced-enumeration",
    name: "Announced-count enumeration",
    severity: "medium",
    suggestion: "drop the count and lead with the first item, or let the number emerge",
    regex: new RegExp(
      "(?:^|[.!?][\"'\u201D\u2019)\\]]?\\s+)(?:" +
        QUANTIFIERS +
        ")\\s+(?:" +
        COUNT_NOUNS +
        ")\\b|\\b(?:of|at|in|into|with|by|through)\\s+(?:two|three|four|five|several)\\s+(?:" +
        COUNT_NOUNS +
        ")\\b",
      "gi"
    ),
  },
  {
    id: "metacommentary",
    name: "Argument-architecture narration",
    severity: "medium",
    suggestion: "cut the sentence that tells the reader how to read the argument",
    regex:
      /\b(?:is|was|are|were)\s+part of the argument\b|\bthe (?:distinction|difference|point|order|sequence|shape|structure) is (?:not academic|part of the|what matters)\b|\bcarries? the weight\b|\b(?:is|are|was|were) the (?:one|point|thing) to (?:keep|remember|notice)\b|\bmatters? more than the symbols\b|\b(?:it|this) (?:needs?|needed) saying plainly\b|\bto (?:say|put) it plainly\b|\bthe (?:whole )?(?:point|claim|argument) (?:is|was) that\b|\bwhat matters (?:here|for this chapter) is\b|\bthe tripartition matters\b|\bkeeping them apart (?:prevents|avoids)\b|\bthe (?:point|purpose|lesson|aim|moral) of (?:the|this|that)\s+\w+\s+is\b|\bthat is the (?:answer|point|argument|claim)\b|\bthis chapter (?:is|is not|does|does not|exists|maps|gives|has|divides|turns|leaves|ends|begins|looks|sets)\b|\bthe rest of this chapter\b|\b(?:that|this) (?:shape|outline|order|structure|map|list) is what follows\b|\bthat is what it means to say\b|\bin what follows\b|\bfor this chapter\b|\bthe point here is\b/gi,
  },
  {
    id: "worth-framing",
    name: "Evaluative 'worth' framing",
    severity: "medium",
    suggestion: "deliver the material instead of grading it before the reader sees it",
    regex:
      /\b(?:is|are|was|were)\s+worth\s+(?:keeping|having|naming|seeing|noting|remembering|separating|reading|doing|making|quoting|saying|avoiding|considering|flagging|mentioning)\b|\bit is worth\s+(?:noting|remembering|saying|stating|seeing|avoiding|considering)\b|\bworth (?:keeping|having|naming|noting|remembering)\b/gi,
  },
  {
    id: "catechetical-qa",
    name: "Catechetical question and short answer",
    severity: "medium",
    suggestion: "fold the answer into a clause; one question and one answer is enough",
    regex: /\?[\s"'”’)\]]+((?:[A-Z][\w'’-]+)(?:\s+[\w'’-]+){0,3})\.(?=\s|$)/g,
    filter: (m) => {
      const answer = String(m[1] || "").trim();
      return answer && answer.split(/\s+/).length <= 3;
    },
  },
  {
    id: "subtractive-reveal",
    name: "Subtraction-to-essence reveal",
    severity: "medium",
    suggestion: "state the essence directly; keep subtraction only where it does real work",
    regex:
      /\b(?:strip|strips|stripping|remove|removes|removing|take|takes|taking|peel|peels|peeling)\b[^.!?]{0,240}?\b(?:what (?:remains|is left|'s left)|remains is|is left is|the (?:essence|core|residue))\b|\b(?:boils|comes) down to\b|\bat bottom,?\s/gi,
  },
  {
    id: "dramatized-frame",
    name: "Dramatized thesis opener",
    severity: "medium",
    suggestion: "state the claim and let the reader decide whether it is dramatic",
    regex:
      /\b(?:contains?|hides?|conceals?|veils?)\s+an?\s+(?:scandal|paradox|contradiction|surprise|secret)\b|\bis easy to mistake for\b|\bmistake(?:n)? for a (?:technicality|detail|coincidence|side issue)\b|\bthe scandal is\b|\bthe dirty secret\b|\bwhat nobody tells you\b|\bthe real story (?:is|was)\b/gi,
  },
  {
    id: "negated-tag",
    name: "Appositive negation tag",
    severity: "medium",
    suggestion:
      "state the positive claim; keep the negation only where the reader holds the opposite belief",
    regex:
      /,\s+(?:and\s+)?not\s+(?:just\s+|merely\s+|simply\s+|only\s+)?(?:a|an|the\s+)?[\w'’-]+(?:\s+[\w'’-]+){0,3}(?=[.!?,;:]|\s+(?:and|but|which|since)\b|$)/gi,
    filter: (m, prose) => !insideQuote(prose, m.index),
  },
  {
    id: "imperative-reveal",
    name: "Imperative-and-consequence reveal",
    severity: "medium",
    suggestion:
      "state the consequence as a claim; the staged imperative is the tell, not the consequence",
    regex:
      /(?:^|[.!?]\s+)(?:Press|Strip|Remove|Run|Reorder|Change|Turn|Set|Add)\b[^.!?]{0,140}?\band\b[^.!?]{0,140}?[.!?]/g,
    filter: (m, prose) => !insideQuote(prose, m.index),
  },
  {
    id: "triple-definition",
    name: "Three-part parallel definition",
    severity: "low",
    suggestion: "split the three clauses or drop one; a semicolon triple reads as a set piece",
    regex:
      /(?:[^.!?;]{3,}?\b(?:is|are|was|were)\b[^.!?;]*;){2}[^.!?;]{3,}?\./g,
  },
  {
    id: "chapter-pointer",
    name: "Chapter-pointer signpost",
    severity: "low",
    suggestion: "keep pointers the reader needs; drop the ones that only place the argument",
    regex:
      /\bchapters?\s+\d+(?:\s*(?:to|–|-|and)\s*\d+)?|\bchapter \d+(?:'s)?\b|\bchapters? \d+['’]?s?\b/gi,
    densityOnly: true,
  },
  {
    id: "contrast-frame",
    name: "'rather than' contrast frame",
    severity: "low",
    suggestion: "vary the join; not every distinction needs the X-rather-than-Y shape",
    regex: /\brather than\b/gi,
    densityOnly: true,
  },
];

const PARAGRAPH_CLUSTER_THRESHOLD = 2;

/**
 * True when `index` sits inside a double-quoted span, so a tell that belongs
 * to a quotation is not scored as the writer's own.
 */
function insideQuote(text, index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    const c = text[i];
    if (c === '"') depth ^= 1;
    else if (c === "\u201C") depth += 1;
    else if (c === "\u201D") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/** Remove YAML frontmatter, code fences, figures, footnotes, quotes, headings. */
function stripNonProse(text) {
  let t = String(text || "");
  t = t.replace(/^---\n[\s\S]*?\n---\n/, "");
  t = t.replace(/```[\s\S]*?```/g, "\n");
  t = t.replace(/^##\s+Notes\s*$[\s\S]*$/m, "");
  const kept = [];
  let inFigure = false;
  for (const line of t.split("\n")) {
    if (/^\*\*\[FIGURE/.test(line)) {
      inFigure = true;
      continue;
    }
    if (inFigure) {
      if (line.trim() === "" || /\]\*\*\s*$/.test(line)) inFigure = false;
      continue;
    }
    if (/^\s*>/.test(line)) continue;
    if (/^\[\^/.test(line)) continue;
    if (/^\s{2,}\S/.test(line)) continue; // footnote continuation
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^!\[\[/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/[*_`]/g, "");
}

function paragraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

function sentences(paragraph) {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(text) {
  const t = String(text || "").trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

/** Consecutive sentences sharing a two-word opener frame. */
function parallelScaffold(paragraph) {
  const sents = sentences(paragraph);
  if (sents.length < 4) return [];
  const heads = sents.map((s) => {
    const words = s
      .replace(/^["'“”([]+/, "")
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.toLowerCase().replace(/[^a-z'’-]/g, ""));
    return words.join(" ").trim();
  });
  const counts = new Map();
  for (const h of heads) {
    if (!h || h.split(" ").length < 2) continue;
    // A pronoun head is only a scaffold when the frame is a copula run
    // ("It is X. It is Y. It is Z."); varied pronoun verbs are normal prose.
    if (/^(it|he|she|they|we|i|you|this|that|there)\b/.test(h) && !/^(it|this|that|there|they) (is|are|was|were)\b/.test(h)) {
      continue;
    }
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  const out = [];
  for (const [h, n] of counts) {
    if (n >= 3) {
      out.push({
        type: "discourse-parallel-scaffold",
        text: `"${h} …" repeated across ${n} consecutive sentences`,
        severity: "medium",
        suggestion: "break the scaffold; vary the joins or drop the labels",
      });
    }
  }
  return out;
}

function matchPattern(pat, prose) {
  if (pat.densityOnly) return [];
  const out = [];
  const re = new RegExp(pat.regex.source, pat.regex.flags.includes("g") ? pat.regex.flags : pat.regex.flags + "g");
  let m;
  while ((m = re.exec(prose)) !== null) {
    if (pat.filter && !pat.filter(m, prose)) {
      if (m.index === re.lastIndex) re.lastIndex += 1;
      continue;
    }
    out.push({
      type: `discourse-${pat.id}`,
      text: m[0].replace(/^[.!?]["'“”’)\]]?\s*/, "").replace(/\s+/g, " ").trim(),
      severity: pat.severity,
      suggestion: pat.suggestion,
    });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {{score:number,label:string,signal_count:number,paragraph_count:number,
 *   density_per_1k:number,by_pattern:Record<string,number>,
 *   issues:Array<object>,advisories:Array<object>}}
 */
function analyzeDiscourse(text) {
  const prose = stripNonProse(text);
  const words = wordCount(prose);
  const paras = paragraphs(prose);
  const issues = [];
  const advisories = [];
  let clusteredParagraphs = 0;
  let pointerCount = 0;
  let contrastCount = 0;

  for (const pat of PATTERNS) {
    if (pat.densityOnly) {
      const re = new RegExp(pat.regex.source, "gi");
      let m;
      let n = 0;
      while ((m = re.exec(prose)) !== null) n += 1;
      if (pat.id === "chapter-pointer") pointerCount = n;
      else if (pat.id === "contrast-frame") contrastCount = n;
      continue;
    }
    for (const p of paras) {
      const hits = matchPattern(pat, p);
      for (const h of hits) {
        issues.push({ ...h, paragraph: p.slice(0, 100) });
      }
    }
  }

  for (const p of paras) {
    const scaffold = parallelScaffold(p);
    for (const s of scaffold) issues.push({ ...s, paragraph: p.slice(0, 100) });
    const ids = new Set(
      issues.filter((i) => i.paragraph === p.slice(0, 100)).map((i) => i.type)
    );
    if (ids.size >= PARAGRAPH_CLUSTER_THRESHOLD) {
      clusteredParagraphs += 1;
      advisories.push({
        type: "discourse-rhetorical-architecture",
        text: p.slice(0, 140),
        severity: "high",
        suggestion:
          "paragraph carries " +
          ids.size +
          " distinct discourse tells (" +
          [...ids].map((t) => t.replace("discourse-", "")).join(", ") +
          "); unpick the scaffold before editing vocabulary",
      });
    }
  }

  // Chapter pointers are legitimate in a roadmap chapter; report density only.
  const pointerDensity = words ? (pointerCount / words) * 1000 : 0;
  const contrastDensity = words ? (contrastCount / words) * 1000 : 0;
  if (contrastDensity >= 2) {
    advisories.push({
      type: "discourse-contrast-density",
      text: `${contrastCount} "rather than" contrast frames (${contrastDensity.toFixed(1)} per 1k words)`,
      severity: "medium",
      suggestion:
        "the contrast frame is the dominant sentence shape; convert some to direct statements",
    });
  }
  if (pointerDensity >= 2.5) {
    advisories.push({
      type: "discourse-chapter-pointer-density",
      text: `${pointerCount} chapter pointers (${pointerDensity.toFixed(1)} per 1k words)`,
      severity: "low",
      suggestion:
        "pointers are useful in an introduction, but this density makes the prose read as a table of contents",
    });
  }

  const byPattern = {};
  for (const i of issues) byPattern[i.type] = (byPattern[i.type] || 0) + 1;

  const raw = issues.reduce((n, i) => n + (SEVERITY_WEIGHT[i.severity] || 1), 0);
  const lengthFactor = Math.max(1, Math.log2(words / 150));
  const score = issues.length
    ? Math.min(60, Math.round((raw * 1.5) / lengthFactor))
    : 0;
  const label =
    score === 0 ? "No discourse signals"
      : score <= 15 ? "Minor discourse signals"
      : score <= 35 ? "Some discourse signals"
      : score <= 50 ? "Notable discourse signals"
      : "Heavy discourse signals";

  return {
    score,
    label,
    signal_count: issues.length,
    paragraph_count: clusteredParagraphs,
    density_per_1k: words ? Math.round((issues.length / words) * 1000 * 100) / 100 : 0,
    by_pattern: byPattern,
    issues,
    advisories,
  };
}

module.exports = { analyzeDiscourse, DISCOURSE_PATTERNS: PATTERNS, stripNonProse };
