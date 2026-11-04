/**
 * /annotate — mark up a file in the user's running Emacs and hand the notes
 * back to pi.
 *
 * `/annotate notes.md` (or notes.org) opens the reviewed file on the left and
 * its review sidecar (`notes.comments.md` / `notes.comments.org`) on the right,
 * in the Emacs instance pi itself is running in (ghostel/vterm terminals
 * included). Regions marked there are recorded in the sidecar as blocks; the
 * Emacs package draws each one as a rounded box beside the text it belongs to.
 * When the review ends, the sidecar is sent to the agent as a user message so
 * it can apply the feedback. Aborting instead tells the agent the review was
 * cancelled, so it applies nothing.
 *
 * Transport: `emacsclient --eval` against the existing Emacs server — the same
 * rendezvous pi-subagents uses. Extensions only get the documented `ctx.ui`
 * requests, with no extension→client "open a buffer" method, so Emacs' own
 * server bridge is the mechanism.
 *
 * The Emacs half is `pi-annotate.el`, which lives in the user's Emacs
 * configuration (`~/.emacs.d/lisp`) and is loaded from init.el — not in this
 * extension. This file only builds the call, waits for the result file the
 * package writes, and turns the sidecar into the agent's message.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_WAIT_MS = 12 * 60 * 60 * 1000; // the review may stay open for hours
const POLL_MS = 400;
const EMACS_TIMEOUT_MS = 20_000;

/** `<!-- annotate:#1 3:1-4:69 comment -->` or `# annotate:#1 3:1-4:69 comment` */
const MARKER =
  /^\s*(?:<!--\s*annotate:#(\d+)\s+(\d+):(\d+)-(\d+):(\d+)\s+(\w+)\s*-->|#\s*annotate:#(\d+)\s+(\d+):(\d+)-(\d+):(\d+)\s+(\w+))\s*$/;
const SOURCE_LINE = /^\s*(?:<!--\s*annotate:source\b|#\s*annotate:source\b)/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Sidecar path for a reviewed file: notes.md → notes.comments.md. */
export function commentsPathFor(file: string): string {
  if (/\.comments\.(md|org)$/i.test(file)) return file;
  const ext = /\.org$/i.test(file) ? "org" : "md";
  return `${file.replace(/\.(md|org)$/i, "")}.comments.${ext}`;
}

/** Strip the padding blank lines and the source header before the model sees it. */
export function compactComments(text: string): string {
  const out: string[] = [];
  let sawBlank = false;
  for (const line of text.split(/\r?\n/)) {
    if (SOURCE_LINE.test(line)) continue;
    if (line.trim() === "") {
      sawBlank = true;
      continue;
    }
    if (sawBlank && out.length > 0) out.push("");
    sawBlank = false;
    out.push(line);
  }
  return out.join("\n");
}

export function parseAnnotations(text: string): Array<{ kind: string; range: string }> {
  const found: Array<{ kind: string; range: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(MARKER);
    if (!m) continue;
    // group 1-6 is the HTML-comment form, group 7-12 the Org one
    const [, , sl, sc, el, ec, kind1, , , , , , kind2] = m;
    const comment = m[1] !== undefined;
    found.push({
      kind: comment ? kind1 : kind2,
      range: `${comment ? sl : m[8]}:${comment ? sc : m[9]}-${comment ? el : m[10]}:${comment ? ec : m[11]}`,
    });
  }
  return found;
}

/** Quote a JavaScript string as an Emacs Lisp string literal. */
function elispString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The form `emacsclient --eval` runs. `pi-annotate-open` opens the review and
 * returns at once; the outcome arrives through the result file it is given,
 * which this extension polls.
 */
export function buildOpenForm(options: {
  mainPath: string;
  resultFile: string;
}): string {
  const missing =
    "pi-annotate: pi-annotate.el is not loaded; put it in ~/.emacs.d/lisp " +
    "(already on load-path) and add (require 'pi-annotate) to init.el";
  return `(progn
  (unless (fboundp 'pi-annotate-open)
    (require 'pi-annotate nil t))
  (unless (fboundp 'pi-annotate-open)
    (error ${elispString(missing)}))
  (pi-annotate-open ${elispString(options.mainPath)} ${elispString(options.resultFile)}))`;
}

function describeFailure(client: string, stderr: string, stdout: string, code: number): string {
  const combined = [stderr, stdout].filter((text) => text.trim()).join("\n");
  if (/can't find socket|No socket or alternate editor|Connection refused/i.test(combined)) {
    const inside = process.env.INSIDE_EMACS ? ` (pi is inside Emacs: INSIDE_EMACS=${process.env.INSIDE_EMACS})` : "";
    return (
      `no Emacs server reachable${inside}. Start it with M-x server-start — ` +
      `and add (require 'server) (unless (server-running-p) (server-start)) to init.el`
    );
  }
  const detail = combined
    .split("\n")
    .map((line) => line.replace(/^emacsclient:\s*/, "").trim())
    .filter((line) => line && !line.startsWith("--") && !/^Please use:?$/.test(line))
    .slice(0, 4)
    .join(" ")
    .trim();
  return detail || `${client} exited ${code}`;
}

type OpenResult = { stdout: string; stderr: string; code: number };

export default function annotateExtension(pi: ExtensionAPI) {
  const emacsclient = () => process.env.PI_ANNOTATE_EMACSCLIENT || "emacsclient";

  async function openInEmacs(mainPath: string, resultFile: string): Promise<OpenResult> {
    const client = emacsclient();
    try {
      const result = await pi.exec(client, ["--eval", buildOpenForm({ mainPath, resultFile })], {
        timeout: EMACS_TIMEOUT_MS,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    } catch (error) {
      throw new Error(`${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Wait for the Emacs package to report an outcome; undefined means timeout. */
  async function waitForResult(resultFile: string, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return fs.readFileSync(resultFile, "utf8").trim();
      } catch {
        // not written yet
      }
      await sleep(POLL_MS);
    }
    return undefined;
  }

  pi.registerCommand("annotate", {
    description: "Review a Markdown/Org file in Emacs and apply the annotations",
    getArgumentCompletions: (prefix) => {
      const base = prefix.startsWith("~") ? expandHome(prefix) : prefix;
      const dir = base.endsWith("/") ? base : path.dirname(base) + "/";
      const stem = base.endsWith("/") ? "" : path.basename(base);
      const abs = path.resolve(process.cwd(), dir === "./" ? "." : dir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return null;
      }
      const items = entries
        .filter((e) => !e.name.startsWith(".") || stem.startsWith("."))
        .filter((e) => e.isDirectory() || /\.(md|org)$/i.test(e.name))
        .filter((e) => e.name.toLowerCase().startsWith(stem.toLowerCase()))
        .slice(0, 50)
        .map((e) => ({
          value: dir + e.name + (e.isDirectory() ? "/" : ""),
          label: e.name + (e.isDirectory() ? "/" : ""),
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        ctx.ui.notify("Usage: /annotate path/to/file.md", "warning");
        return;
      }

      const target = path.resolve(ctx.cwd, expandHome(raw));
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        ctx.ui.notify(`annotate: no such file: ${raw}`, "error");
        return;
      }
      if (stat.isDirectory()) {
        ctx.ui.notify(`annotate: ${raw} is a directory`, "error");
        return;
      }
      if (!/\.(md|org)$/i.test(target)) {
        ctx.ui.notify("annotate: only Markdown and Org files are supported", "warning");
        return;
      }

      const commentsPath = commentsPathFor(target);
      const name = path.basename(target);
      const resultFile = path.join(os.tmpdir(), `annotate-result-${process.pid}-${Date.now()}`);

      ctx.ui.setStatus("annotate", `annotate: opening ${name} in Emacs…`);
      try {
        const opened = await openInEmacs(target, resultFile);
        if (opened.code !== 0) {
          ctx.ui.setStatus("annotate", undefined);
          ctx.ui.notify(
            `annotate: could not open ${name} — ${describeFailure(emacsclient(), opened.stderr, opened.stdout, opened.code)}`,
            "error",
          );
          return;
        }
      } catch (error) {
        ctx.ui.setStatus("annotate", undefined);
        ctx.ui.notify(
          `annotate: could not open ${name} — ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus(
        "annotate",
        `annotate: ${name} open in Emacs — C-c C c comment, C-c C d delete, C-c C q to finish`,
      );

      const outcome = await waitForResult(resultFile, DEFAULT_WAIT_MS);
      try {
        fs.rmSync(resultFile);
      } catch {
        // ignore
      }

      if (outcome === undefined) {
        // Emacs still has the review open; leave it alone so it is not lost.
        ctx.ui.setStatus("annotate", undefined);
        ctx.ui.notify(
          `annotate: gave up waiting on Emacs for ${name} — the review is still open there; finish it and run /annotate ${raw} again to apply the notes`,
          "warning",
        );
        return;
      }

      ctx.ui.setStatus("annotate", undefined);

      const rel = (p: string) => (p.startsWith(ctx.cwd + path.sep) ? path.relative(ctx.cwd, p) : p);
      const deliver = (message: string) => {
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
        } else {
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        }
      };

      if (outcome === "aborted") {
        ctx.ui.notify(`annotate: ${name} review aborted — the agent was told to stand down`, "info");
        deliver(
          [
            `Annotation aborted: I cancelled the review of ${rel(target)} in Emacs, so there is no feedback to apply.`,
            "",
            `Take no action: leave ${rel(target)} unchanged, and ignore ${rel(commentsPath)} if it exists — it belongs to an unfinished review.`,
          ].join("\n"),
        );
        return;
      }

      if (outcome !== "finished") {
        ctx.ui.notify(
          `annotate: the Emacs review of ${name} ended unexpectedly — ${outcome.slice(0, 300)}`,
          "error",
        );
        return;
      }

      let content = "";
      try {
        content = fs.readFileSync(commentsPath, "utf8");
      } catch {
        content = "";
      }
      const annotations = parseAnnotations(content);
      if (annotations.length === 0) {
        // nothing was annotated: drop the scaffold so the next run starts clean
        if (!compactComments(content).trim()) {
          try {
            fs.rmSync(commentsPath);
          } catch {
            // ignore
          }
        }
        ctx.ui.notify(`annotate: no annotations in ${name}`, "info");
        return;
      }

      const summary = annotations.map((a) => `${a.range} ${a.kind}`).join(", ");
      const message = [
        `I reviewed ${rel(target)} in Emacs. Feedback from ${rel(commentsPath)} (${annotations.length} annotation${annotations.length === 1 ? "" : "s"}):`,
        "",
        compactComments(content),
        "",
        "---",
        `Apply this feedback to ${rel(target)}.`,
        "- Ranges are 1-based `line:column` spans into that file (`start-end`, end column inclusive), as it was when I made the notes; verify the text still matches before editing.",
        "- `comment` blocks are what I want changed or explained for that span — do what the note says.",
        "- `delete` blocks mark text to remove; the quoted text shows what was selected.",
        "- Keep the rest of the document intact and its style consistent.",
        `- When the feedback has been applied, delete ${rel(commentsPath)}.`,
        `- Annotations: ${summary}`,
      ].join("\n");

      deliver(message);
    },
  });
}
