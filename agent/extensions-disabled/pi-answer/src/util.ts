/**
 * pi-answer — small shared utilities.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Extract plain text from a pi message `content` (string or block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n");
  }
  return "";
}

/** Text of the most recent assistant message that has any text content. */
export function lastAssistantText(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "message") continue;
    const msg = (e as { message?: { role?: unknown; content?: unknown } }).message;
    if (!msg || msg.role !== "assistant") continue;
    const t = extractText(msg.content).trim();
    if (t) return t;
  }
  return undefined;
}

export interface Args {
  text?: string;
  file?: string;
  agent?: boolean;
  verbose?: boolean;
  review?: boolean;
}

/**
 * Parse command args: `--key value`, `--key=value`, `--flag`, with
 * single/double-quoted values. Unknown flags are ignored.
 */
export function parseArgs(input: string): Args {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) tokens.push(m[1] ?? m[2] ?? m[3]);

  const out: Args = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--text") out.text = tokens[++i] ?? "";
    else if (t.startsWith("--text=")) out.text = t.slice("--text=".length);
    else if (t === "--file") out.file = tokens[++i] ?? "";
    else if (t.startsWith("--file=")) out.file = t.slice("--file=".length);
    else if (t === "--agent") out.agent = true;
    else if (t === "--verbose") out.verbose = true;
    else if (t === "--review") out.review = true;
  }
  return out;
}
