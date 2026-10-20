/**
 * pi-answer — consolidated reply builder.
 */

import type { Question } from "./split.ts";

/**
 * Build the single reply sent back to the LLM.
 *
 * Default (terse): one labeled answer per question, e.g.
 *   Q2 (D7): Accept ~108k, defence chapters leaner.
 * This matches the "terse answers fine" instruction common in these replies.
 *
 * `verbose` adds the full question text under each answer.
 */
export function buildReply(
  questions: Question[],
  answers: string[],
  opts: { verbose?: boolean } = {},
): string {
  const lines: string[] = ["Here are my answers:"];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const raw = (answers[i] ?? "").trim();
    const a = raw || "(no answer)";
    const label = q.label || String(i + 1);

    if (opts.verbose) {
      lines.push("");
      lines.push(`${label} — ${q.text.replace(/\s+/g, " ").trim()}`);
      lines.push(indent(a));
    } else {
      lines.push(`${formatLabel(label)} ${a.replace(/\s+/g, " ").trim()}`.trimEnd());
    }
  }
  return lines.join("\n").trimEnd();
}

/** "1." / "•" get a space, "Q2 (D7)" gets a colon, empty labels get an index. */
function formatLabel(label: string): string {
  if (!label) return "";
  if (/^\d+\.$/.test(label) || label === "•") return `${label}`;
  return `${label}:`;
}

function indent(a: string): string {
  const prefix = "   ";
  return prefix + a.split("\n").join("\n" + prefix);
}
