/**
 * pi-answer — question splitting.
 *
 * Detects batch questions in an LLM reply and splits them into individual
 * question items, capturing optional proposal lines (➡️) the LLM offered.
 *
 * Supported formats (tried in order):
 *   1. Q-label mode — lines starting with `Q1:`, `❓ Q2 (D7) - ...`,
 *      `Question 3 - ...`, optionally bold/blockquoted. The first block can be
 *      an *implicit Q1*: unmarked text before the first explicit marker that
 *      contains a ➡️ proposal line (the DeepSeek decision-confirmation format).
 *   2. Numbered mode — `1.` / `1)` list items whose text ends with `?`.
 *   3. Bullet mode — `-` / `*` / `•` items whose text ends with `?`.
 *   4. Prose mode — sentences ending with `?` (only splits when ≥ 2 found, to
 *      avoid hijacking ordinary conversation).
 *
 * A `➡️` (or `→`) line inside a question block is treated as the LLM's
 * proposed answer for that question; the answering flow prefills it so the
 * user can adopt, edit, or replace it. Dash/equals separator lines split
 * blocks, and text after the last block (e.g. "Terse answers fine — ...") is
 * captured as `trailing` and surfaced in the flow as a note.
 */

export interface Question {
  /** Display label, e.g. "Q2 (D7)", "1.", "•", or "" for prose-detected questions. */
  label: string;
  /** The question / decision text, without the label. */
  text: string;
  /** The LLM's proposed answer for this question (from a ➡️ line), if any. */
  proposed?: string;
}

export interface SplitResult {
  /** Text before the first question (context for the answerer), or "". */
  preamble: string;
  /** Detected questions in order. */
  questions: Question[];
  /** Text after the last question (e.g. "Terse answers fine..."), or "". */
  trailing: string;
}

interface Block {
  label: string;
  lines: string[];
  proposed: string[];
}

// ---------------------------------------------------------------------------
// Marker patterns
// ---------------------------------------------------------------------------

const Q_LABEL_RE =
  /^\s*(?:(?:>\s*)?\*{1,3}\s*)?(?:[❓❔⁉️]\s*)?(Q|Question)(?=[\s\d:.)(\-–—]|$)(?:\.?\s*(\d+))?(?:\s*\(([^)]*)\))?\s*[:.)\-–—]?\s*(.*)$/i;

const NUMBERED_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/;

const BULLET_RE = /^\s*([-*•▪◦‣])\s+(.*)$/;

const SEPARATOR_RE = /^\s*[─━═=-]{3,}\s*$/;

const PROPOSED_RE = /^\s*(?:➡️|➡|→|=>|->)\s*(.*)$/;

function makeLabel(num: string | undefined, ref: string | undefined): string {
  const n = num ?? "";
  const r = ref ? ` (${ref})` : "";
  return `Q${n}${r}`;
}

function qLabelMarker(line: string): { label: string; rest: string } | null {
  const m = Q_LABEL_RE.exec(line);
  if (!m) return null;
  return { label: makeLabel(m[2], m[3]), rest: stripAsterisks(m[4]) };
}

function numberedMarker(line: string): { label: string; rest: string } | null {
  const m = NUMBERED_RE.exec(line);
  if (!m) return null;
  return { label: `${m[1]}.`, rest: m[2].trim() };
}

function bulletMarker(line: string): { label: string; rest: string } | null {
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  return { label: "•", rest: m[2].trim() };
}

function stripAsterisks(s: string): string {
  return s.replace(/^\*+|\*+$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Block collection
// ---------------------------------------------------------------------------

/**
 * Walk the lines once, grouping them into blocks. A marker line starts a new
 * block; continuation lines append to the current block's text (or to its
 * proposed answer once a ➡️ line has been seen); separator lines finalize the
 * current block. Lines before the first block become the preamble; lines after
 * the last block become trailing.
 */
function collectBlocks(
  lines: string[],
  marker: (line: string) => { label: string; rest: string } | null,
): { preamble: string[]; blocks: Block[]; trailing: string[] } {
  const preamble: string[] = [];
  const blocks: Block[] = [];
  const trailing: string[] = [];
  let current: Block | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (SEPARATOR_RE.test(line)) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    const m = marker(line);
    if (m) {
      if (current) blocks.push(current);
      current = { label: m.label, lines: m.rest ? [m.rest] : [], proposed: [] };
      continue;
    }

    const prop = PROPOSED_RE.exec(line);
    if (prop) {
      if (current) {
        current.proposed.push(prop[1]);
      } else if (blocks.length > 0) {
        trailing.push(line);
      } else {
        preamble.push(line);
      }
      continue;
    }

    if (current) {
      if (current.proposed.length > 0) current.proposed.push(line);
      else current.lines.push(line);
    } else if (blocks.length > 0) {
      trailing.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (current) blocks.push(current);
  return { preamble, blocks, trailing };
}

/**
 * Turn the first block's preamble into an implicit Q1 when the preamble
 * contains a ➡️ proposal line (DeepSeek decision-confirmation format:
 * context bullets, then the proposal, then "❓ Q2 ...").
 */
function implicitQ1(preambleLines: string[]): { preamble: string[]; q1?: Block } {
  const idx = preambleLines.findIndex((l) => PROPOSED_RE.test(l));
  if (idx === -1) return { preamble: preambleLines };
  const textLines = preambleLines.slice(0, idx);
  const proposed: string[] = [];
  for (const l of preambleLines.slice(idx)) {
    const m = PROPOSED_RE.exec(l);
    proposed.push(m ? m[1] : l);
  }
  return { preamble: [], q1: { label: "Q1", lines: textLines, proposed } };
}

// ---------------------------------------------------------------------------
// Question filtering
// ---------------------------------------------------------------------------

function cleanText(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(t);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  while (out.length && out[0] === "") out.shift();
  return out.join("\n");
}

function endsWithQuestion(text: string): boolean {
  return /[?？]$/.test(text.trim().replace(/[*)\]}>»"']+$/g, ""));
}

const NOISE = new Set([
  "anyquestions",
  "anyotherquestions",
  "anyquestionssofar",
  "doyouhaveanyquestions",
  "doyouhaveanyotherquestions",
  "doesthatmakesense",
  "doesthatansweryourquestion",
  "gotit",
  "gother",
  "understood",
  "anythingelse",
  "isthatclear",
  "makessense",
  "soundgood",
  "soundsgood",
  "anythoughts",
]);

function isNoise(text: string): boolean {
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return NOISE.has(norm);
}

function toQuestions(blocks: Block[], requireQuestionMark: boolean): Question[] {
  const questions: Question[] = [];
  for (const b of blocks) {
    const text = cleanText(b.lines);
    if (!text) continue;
    if (requireQuestionMark && !endsWithQuestion(text)) continue;
    if (isNoise(text)) continue;
    const last = questions[questions.length - 1];
    if (last && last.text === text && !last.proposed && b.proposed.length === 0) continue;
    questions.push({
      label: b.label,
      text,
      proposed: b.proposed.length > 0 ? b.proposed.join("\n").trim() : undefined,
    });
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Prose fallback
// ---------------------------------------------------------------------------

function splitProse(text: string): SplitResult {
  const parts = text.split(/([.!?])\s+/);
  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    const delim = parts[i + 1];
    sentences.push(delim ? seg + delim : seg);
  }

  const preamble: string[] = [];
  const questions: string[] = [];
  let cur: string[] | null = null;
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (endsWithQuestion(t)) {
      if (cur) questions.push(cur.join(" "));
      cur = [t];
    } else if (cur) {
      cur.push(t);
    } else {
      preamble.push(t);
    }
  }
  if (cur) questions.push(cur.join(" "));

  const qs: Question[] = [];
  for (const q of questions) {
    if (isNoise(q)) continue;
    qs.push({ label: "", text: q });
  }
  // Prose mode only splits when there is a clear batch of ≥ 2 questions;
  // a single trailing question in ordinary prose is just conversation.
  if (qs.length < 2) return { preamble: "", questions: [], trailing: "" };
  return { preamble: preamble.join(" "), questions: qs, trailing: "" };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function splitQuestions(text: string): SplitResult {
  const lines = text.split(/\r?\n/);

  // 1) Q-label mode (explicit `Q1: ...` / `❓ Q2 (D7) - ...` markers).
  const ql = collectBlocks(lines, qLabelMarker);
  if (ql.blocks.length >= 1) {
    let questions = toQuestions(ql.blocks, false);
    let preamble = ql.preamble.join("\n").trim();
    const firstLabel = ql.blocks[0].label;
    const firstIsQ1 = /^Q\s*1(\s|$)/.test(firstLabel);
    if (questions.length >= 1 && !firstIsQ1 && preamble) {
      const imp = implicitQ1(ql.preamble);
      if (imp.q1) {
        const q1s = toQuestions([imp.q1], false);
        if (q1s.length > 0) questions = [...q1s, ...questions];
        preamble = imp.preamble.join("\n").trim();
      }
    }
    if (questions.length >= 1) {
      return { preamble, questions, trailing: ql.trailing.join("\n").trim() };
    }
  }

  // 2) Numbered mode (`1. ...?`).
  const nm = collectBlocks(lines, numberedMarker);
  const nq = toQuestions(nm.blocks, true);
  if (nq.length >= 1) {
    return { preamble: nm.preamble.join("\n").trim(), questions: nq, trailing: nm.trailing.join("\n").trim() };
  }

  // 3) Bullet mode (`- ...?`).
  const bm = collectBlocks(lines, bulletMarker);
  const bq = toQuestions(bm.blocks, true);
  if (bq.length >= 1) {
    return { preamble: bm.preamble.join("\n").trim(), questions: bq, trailing: bm.trailing.join("\n").trim() };
  }

  // 4) Prose fallback.
  return splitProse(text);
}
