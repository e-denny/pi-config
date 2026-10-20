/**
 * pi-answer — pure-logic smoke tests (split, consolidate, args).
 * Run with: bun smoke-test.ts
 *
 * The first case is the user's real DeepSeek 4-question decision message.
 */
import { buildReply } from "./src/consolidate.ts";
import { splitQuestions } from "./src/split.ts";
import { parseArgs } from "./src/util.ts";

const DEEPSEEK_EXAMPLE = ` Notes on the groupings you might want to veto:
 - Ch 11 sits late — classical political economy as history after the system is built; alternative: move it to a Part 0 (before
   ch 2) as intellectual background
 - Ch 12 merges imperialism + finance capital + colonial accumulation (your three shards → one chapter)
 - Elephant chapters 14–15 deliberately re-use austrian-school/transformation material but argue, where the core chapters
   explain — no duplication, different job

 ➡️ Adopt the map as proposed (or adjust — reorder, merge, split, rename).

 ────────────────────────────────────────────────────────────────────────────────

 ❓ Q2 (D7) - Length: 18 chapters at ~6k = ~105–110k words. Options: accept ~108k · trim to ~95k (cut ~1k/chapter) · expand to
 ~120k (defence chapters get room to breathe).

 ➡️ Accept ~108k, with defence chapters (13–15) deliberately leaner (~4.5k) and development chapters (2–10) at ~6.5k. The
 defence chapters argue a case the reader has already been equipped to see.

 ────────────────────────────────────────────────────────────────────────────────

 ❓ Q3 (D14) - Working title: Candidates:
 - "Marxian Economics for a World in Crisis: A Defence" — states purpose and stakes
 - "Why Marx Still Matters: A Defence and a Guide" — direct, Piketty-adjacent echo
 - "The Case for Marx: Value, Crisis, and the Modern World"
 - "After the Elephants: Marxian Economics Reconsidered" — provocative

 ➡️ "Why Marx Still Matters: A Defence and a Guide" — matches your thesis verbatim ("never refuted… still relevant") and
 signals both the argument and the survey. Happy to workshop it later (D14 is cheap to revisit).

 ────────────────────────────────────────────────────────────────────────────────

 ❓ Q4 (D15) - Front/back matter: Recommend:
 - Preface — why this book, personal note
 - Glossary — every concept built up in ch 2–3 gets an entry
 - Appendix A — reproduction schemas and the transformation algebra (formal derivations)
 - Appendix B — "How to read Capital" — a roadmap mapping the book's chapters to Marx's volumes
 - Annotated bibliography — the wiki's sources, ranked by entry point
 - No footnotes; endnotes only where a source citation must interrupt

 ➡️ Adopt as proposed (or adjust).

 ────────────────────────────────────────────────────────────────────────────────

 Terse answers fine — e.g. "1 adopt but move ch 11 earlier, 2 108k, 3 title 2, 4 adopt".`;

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${extra ? `\n    got: ${extra}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n[1] splitQuestions — DeepSeek decision-format example");
const r = splitQuestions(DEEPSEEK_EXAMPLE);
check("detects exactly 4 questions", r.questions.length === 4, JSON.stringify(r.questions.map((q) => q.label)));
check(
  "labels Q1|Q2 (D7)|Q3 (D14)|Q4 (D15)",
  r.questions.map((q) => q.label).join("|") === "Q1|Q2 (D7)|Q3 (D14)|Q4 (D15)",
  JSON.stringify(r.questions.map((q) => q.label)),
);
check("Q1 is implicit (has proposal)", r.questions[0].proposed?.startsWith("Adopt the map") ?? false, r.questions[0].proposed);
check("Q1 text keeps veto bullets", r.questions[0].text.includes("Ch 12 merges"), r.questions[0].text.slice(0, 200));
check("Q2 text starts with 'Length'", r.questions[1].text.startsWith("Length"), r.questions[1].text.slice(0, 80));
check("Q2 proposal is multi-line", (r.questions[1].proposed ?? "").includes("deliberately leaner"), r.questions[1].proposed);
check("Q3 candidates preserved", r.questions[2].text.includes("After the Elephants"), r.questions[2].text.slice(0, 200));
check("trailing note captured", r.trailing.startsWith("Terse answers fine"), r.trailing.slice(0, 80));
check("no preamble (consumed by Q1)", r.preamble === "", r.preamble.slice(0, 80));

console.log("\n[2] buildReply — terse (default) and verbose");
const terse = buildReply(r.questions, [
  "Adopt, but move ch 11 to Part 0",
  "Accept ~108k",
  "Title 2",
  "Adopt as proposed",
]);
check(
  "terse reply labels",
  terse.includes("Q1:") && terse.includes("Q2 (D7):") && terse.includes("Q3 (D14):") && terse.includes("Q4 (D15):"),
  terse,
);
check("terse reply includes answers", terse.includes("move ch 11 to Part 0") && terse.includes("Accept ~108k"), terse);
const verbose = buildReply(r.questions, ["a", "b", "c", "d"], { verbose: true });
check("verbose includes question text", verbose.includes("Length: 18 chapters") && verbose.includes("Working title"), verbose.slice(0, 200));
check("verbose includes answers", verbose.includes("\n   a") || verbose.includes("   a"), verbose.slice(0, 120));
check("no-answer fallback", buildReply(r.questions, ["x", "", "y", ""]).includes("(no answer)"), buildReply(r.questions, ["x", "", "y", ""]));

// ---------------------------------------------------------------------------
console.log("\n[3] splitQuestions — classic numbered questions");
const numbered = splitQuestions(`I have a few questions before we start:

1. What operating system are you on?
2. Which editor do you use?
3. How large is the repository?`);
check("numbered: 3 questions", numbered.questions.length === 3, JSON.stringify(numbered.questions.map((q) => q.label)));
check("numbered: labels 1. 2. 3.", numbered.questions.map((q) => q.label).join("|") === "1.|2.|3.", JSON.stringify(numbered.questions.map((q) => q.label)));
check("numbered: preamble kept", numbered.preamble.includes("few questions"), numbered.preamble);

console.log("\n[4] splitQuestions — bullets");
const bullets = splitQuestions(`- What is your experience with Rust?
- Have you used pi before?
- What are you building?`);
check("bullets: 3 questions", bullets.questions.length === 3, JSON.stringify(bullets.questions.map((q) => q.label)));
check("bullets: labels", bullets.questions.every((q) => q.label === "•"), JSON.stringify(bullets.questions.map((q) => q.label)));

console.log("\n[5] splitQuestions — prose fallback");
const prose = splitQuestions(`Thanks for the quick turnaround. What OS are you on? And which editor do you prefer? Also, is this repo public?`);
check("prose: 3 questions", prose.questions.length === 3, JSON.stringify(prose.questions.map((q) => q.text)));
check("prose: labels empty (indexed)", prose.questions.every((q) => q.label === ""), JSON.stringify(prose.questions.map((q) => q.label)));
const proseSingle = splitQuestions(`Great work. Do you have any questions before I continue?`);
check("prose: single rhetorical question NOT split", proseSingle.questions.length === 0, JSON.stringify(proseSingle.questions));

console.log("\n[6] splitQuestions — noise and no-split cases");
check("noise: 'Does that make sense?' filtered", splitQuestions(`Does that make sense? Any questions?`).questions.length === 0);
check("no-split: statement list", splitQuestions(`1. Added auth\n2. Fixed tests\n3. Ran linter`).questions.length === 0);
check("no-split: plain prose without questions", splitQuestions(`This is just a status update. Everything is fine.`).questions.length === 0);
check(
  "mixed: numbered drops statement items, keeps question items",
  (() => {
    const q = splitQuestions(`1. What changed?\n2. Files touched:\n   - src/a.ts\n3. Tests?`);
    return q.questions.length === 2 && q.questions[0].text === "What changed?" && q.questions[1].text === "Tests?";
  })(),
  JSON.stringify(splitQuestions(`1. What changed?\n2. Files touched:\n   - src/a.ts\n3. Tests?`).questions),
);

console.log("\n[7] splitQuestions — plain Q-label variants");
const qlabels = splitQuestions(`**Q1:** What is the deploy process?
Q2 - Who is on call this week?
Question 3) What is the rollback plan?`);
check("q-label variants: 3 questions", qlabels.questions.length === 3, JSON.stringify(qlabels.questions.map((q) => q.label)));
check("q-label variants: labels", qlabels.questions.map((q) => q.label).join("|") === "Q1|Q2|Q3", JSON.stringify(qlabels.questions.map((q) => q.label)));
check("q-label bold stripped", qlabels.questions[0].text === "What is the deploy process?", qlabels.questions[0].text);

const singleQ = splitQuestions(`Q2 (D7) - Length: 18 chapters at ~6k words. Options: accept ~108k or trim to ~95k.

➡️ Accept ~108k.`);
check("single Q-label question still offered", singleQ.questions.length === 1, JSON.stringify(singleQ.questions));
check("single: label + proposal", singleQ.questions[0].label === "Q2 (D7)" && singleQ.questions[0].proposed === "Accept ~108k.", JSON.stringify(singleQ.questions[0]));

console.log("\n[8] parseArgs");
const pa = parseArgs(`--text "hello world" --file notes.md --verbose --agent`);
check("parseArgs text with quotes", pa.text === "hello world", JSON.stringify(pa));
check("parseArgs file", pa.file === "notes.md", JSON.stringify(pa));
check("parseArgs flags", pa.verbose === true && pa.agent === true, JSON.stringify(pa));
const pb = parseArgs("--text=plain");
check("parseArgs = form", pb.text === "plain", JSON.stringify(pb));

console.log("");
if (failures === 0) {
  console.log("All smoke tests passed ✓");
} else {
  console.error(`${failures} smoke test(s) failed ✗`);
  process.exit(1);
}
