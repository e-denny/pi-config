/**
 * /annotate — review a Markdown file in Neovim and hand the annotations back
 * to Pi.
 *
 * `/annotate notes.md` opens a new window in the current tmux session running
 * Neovim with the reviewed file on the left and its `<name>.comments.md` review
 * sidecar on the right. Selections in the reviewed file are recorded in the
 * sidecar (see README.md) and drawn as rounded boxes next to the text they
 * belong to.
 * When Neovim exits, the window is closed and the sidecar is sent to the agent
 * as a user message so it can apply the feedback. Leaving Neovim with the abort
 * key instead tells the agent the review was cancelled, so it applies nothing.
 *
 * The Neovim half is `e-denny/annotate.nvim`, installed by lazy.nvim, and is
 * loaded with `-c 'set rtp^=…'` from that checkout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_WAIT_MS = 12 * 60 * 60 * 1000; // Neovim may stay open for hours
const POLL_MS = 1500;
const MARKER = /<!--\s*annotate:#(\d+)\s+(\d+):(\d+)-(\d+):(\d+)\s+(\w+)\s*-->/;
const SOURCE_LINE = /^<!--\s*annotate:source\b/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The lazy.nvim checkout of e-denny/annotate.nvim. This is the canonical copy
 * of the Neovim plugin; the extension does not bundle its own.
 */
function nvimPluginDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "nvim", "lazy", "annotate.nvim");
}

function nvimPluginMissing(dir: string): boolean {
  return !fs.existsSync(path.join(dir, "lua", "annotate", "init.lua"));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Registered as the first `-c` command: at exit, Neovim writes its `:messages`
 * history to `$ANNOTATE_LOG`, which is how a failed start gets reported without
 * touching the process's file descriptors (see takeMessages).
 */
const DUMP_MESSAGES = [
  "lua local function dump()",
  "local ok, m = pcall(vim.api.nvim_exec2, 'messages', { output = true })",
  "if not ok then return end",
  "pcall(vim.fn.writefile, vim.split(m.output, '\\n', { plain = true }), vim.env.ANNOTATE_LOG)",
  "end",
  "vim.api.nvim_create_autocmd('VimLeavePre', { callback = dump })",
].join(" ");

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function commentsPathFor(file: string): string {
  if (/\.comments\.md$/i.test(file)) return file;
  return file.replace(/\.md$/i, "") + ".comments.md";
}

/** Turn the padded sidecar into something compact for the model. */
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
    if (m) {
      found.push({ kind: m[6], range: `${m[2]}:${m[3]}-${m[4]}:${m[5]}` });
    }
  }
  return found;
}

type TmuxResult = { stdout: string; code: number; stderr: string };

type PaneState = "running" | "exited" | "gone";

export default function annotateExtension(pi: ExtensionAPI) {
  const tmuxBin = () => process.env.TMUX_BIN_PATH || "tmux";

  async function tmux(args: string[], timeoutMs?: number): Promise<TmuxResult> {
    const result = await pi.exec(tmuxBin(), args, { timeout: timeoutMs });
    return { stdout: result.stdout, code: result.code, stderr: result.stderr };
  }

  /**
   * State of one pane. `list-panes` reports an error once the pane (or its
   * window) is gone; `display-message` quietly prints nothing for a missing
   * pane, which is indistinguishable from an empty format, so it is no use here.
   */
  async function paneState(paneId: string): Promise<PaneState> {
    const { stdout, code } = await tmux([
      "list-panes",
      "-t",
      paneId,
      "-F",
      "#{pane_id}\t#{pane_dead}",
    ]);
    if (code !== 0) return "gone";
    for (const line of stdout.split(/\r?\n/)) {
      const [id, dead] = line.split("\t");
      if (id !== paneId) continue;
      return dead === "1" ? "exited" : "running";
    }
    return "gone";
  }

  /**
   * Wait for the Neovim pane to disappear. Neovim runs as the pane's own
   * command, so leaving it — by any means — destroys the pane. The window may
   * outlive it (a sidebar pane can keep it open), hence panes, not windows.
   */
  async function waitForPaneClose(paneId: string, timeoutMs: number): Promise<"closed" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await paneState(paneId)) !== "running") return "closed";
      await sleep(POLL_MS);
    }
    return "timeout";
  }

  /**
   * Neovim's diagnostics, kept so a failed start can be reported instead of
   * guessed.
   *
   * They come from Neovim's own `:messages` history, written to a temporary file
   * at exit (see DUMP_MESSAGES), rather than from a redirected stderr. Since
   * 0.11 the TUI is a client that starts the real editor as a child with
   * `--embed`, and that child — the process the plugins run in — dup2()s its
   * stdin and stdout onto stderr (`channel_from_stdio` in Neovim's
   * `channel.c`). Redirecting stderr therefore leaves the plugin process with a
   * regular file on fd 1, and everything that opens the terminal from there
   * fails: Kitty-graphics images, image previews and math overlays all break
   * with "failed to open stdout". The message history avoids the problem
   * entirely, and unlike the pane's screen it survives the alternate screen
   * being torn down when Neovim exits.
   */
  function takeMessages(logPath: string): string {
    let text: string;
    try {
      text = fs.readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
    try {
      fs.rmSync(logPath);
    } catch {
      // ignore
    }
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Neovim reports startup failures as its own messages; everything else in
      // the history (annotate's notices, file-open messages) is noise.
      .filter((line) => /^(?:E\d+:|Error\b|Failed to run|vim\.schedule|stack\s|\s+- \/)/i.test(line))
      // Closing the window hangs Neovim up; that is expected, not a failure.
      .filter((line) => !/caught deadly signal/i.test(line))
      .slice(0, 3)
      .join(" / ")
      .slice(0, 400);
  }

  pi.registerCommand("annotate", {
    description: "Review a Markdown file in Neovim and apply the annotations",
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
        .filter((e) => e.isDirectory() || /\.md$/i.test(e.name))
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

      const tmuxPane = process.env.TMUX_PANE;
      if (!process.env.TMUX || !tmuxPane) {
        ctx.ui.notify("annotate: this command needs to run inside tmux", "error");
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
      if (!/\.md$/i.test(target)) {
        ctx.ui.notify("annotate: only Markdown files are supported for now", "warning");
        return;
      }

      const nvimDir = nvimPluginDir();
      if (nvimPluginMissing(nvimDir)) {
        ctx.ui.notify(
          "annotate: annotate.nvim is not installed — add 'e-denny/annotate.nvim' to your lazy.nvim config and run :Lazy install",
          "error",
        );
        return;
      }

      const origin = await tmux([
        "display-message",
        "-p",
        "-t",
        tmuxPane,
        "#{session_id}\t#{window_id}",
      ]);
      const [sessionId, originWindow] = origin.stdout.trim().split("\t");
      if (origin.code !== 0 || !sessionId || !originWindow) {
        ctx.ui.notify("annotate: could not resolve the current tmux session", "error");
        return;
      }

      const commentsPath = commentsPathFor(target);
      const dir = path.dirname(target);
      const name = path.basename(target);
      const messagesLog = path.join(os.tmpdir(), `annotate-${process.pid}-${Date.now()}.log`);
      // The Neovim plugin creates this file when the review is aborted (see
      // annotate.nvim's M.abort). Its absence is what makes a normal finish a
      // normal finish, so it is checked before the sidecar is read.
      const abortMarker = path.join(
        os.tmpdir(),
        `annotate-abort-${process.pid}-${Date.now()}`,
      );

      const command = [
        "nvim",
        "-c",
        shellQuote(DUMP_MESSAGES),
        "-c",
        shellQuote(`set rtp^=${nvimDir}`),
        "-c",
        shellQuote('lua require("annotate").setup()'),
        shellQuote(target),
      ].join(" ");

      ctx.ui.setStatus("annotate", `annotate: opening ${name} in Neovim…`);
      const created = await tmux(
        [
          "new-window",
          "-t",
          sessionId,
          "-c",
          dir,
          "-n",
          `annotate: ${name}`,
          "-P",
          "-F",
          "#{window_id}\t#{pane_id}",
          "-e",
          `ANNOTATE_FILE=${target}`,
          "-e",
          `ANNOTATE_LOG=${messagesLog}`,
          "-e",
          `ANNOTATE_ABORT_FILE=${abortMarker}`,
          command,
        ],
        15_000,
      );
      const [windowId, paneId] = created.stdout.trim().split("\t");
      if (created.code !== 0 || !windowId || !paneId) {
        ctx.ui.setStatus("annotate", undefined);
        const detail = created.stderr.trim() || created.stdout.trim();
        ctx.ui.notify(
          `annotate: could not open a tmux window${detail ? ` — ${detail}` : ""}`,
          "error",
        );
        return;
      }
      // Otherwise tmux renames the window to "nvim" once the editor is up.
      await tmux(["set-option", "-w", "-t", windowId, "automatic-rename", "off"]);

      ctx.ui.setStatus(
        "annotate",
        `annotate: ${name} open — <Space>C comment, <Space>D delete, <Space>Q to finish`,
      );

      const outcome = await waitForPaneClose(paneId, DEFAULT_WAIT_MS);

      if (outcome === "timeout") {
        // Neovim is still open; leave it alone so the review is not lost.
        ctx.ui.setStatus("annotate", undefined);
        ctx.ui.notify(
          `annotate: gave up waiting on Neovim for ${name} — the window is still open; finish the review and run /annotate again to apply the notes`,
          "warning",
        );
        return;
      }

      // Back to the window Pi runs in before dropping the review window.
      await tmux(["select-window", "-t", originWindow]);
      await tmux(["kill-window", "-t", windowId]);
      ctx.ui.setStatus("annotate", undefined);

      const aborted = fs.existsSync(abortMarker);
      if (aborted) {
        try {
          fs.rmSync(abortMarker);
        } catch {
          // ignore
        }
      }

      const rel = (p: string) => (p.startsWith(ctx.cwd + path.sep) ? path.relative(ctx.cwd, p) : p);
      const deliver = (message: string) => {
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
        } else {
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        }
      };

      if (aborted) {
        ctx.ui.notify(`annotate: ${name} review aborted — the agent was told to stand down`, "info");
        deliver(
          [
            `Annotation aborted: I cancelled the review of ${rel(target)} in Neovim, so there is no feedback to apply.`,
            "",
            `Take no action: leave ${rel(target)} unchanged, and ignore ${rel(commentsPath)} if it exists — it belongs to an unfinished review.`,
          ].join("\n"),
        );
        return;
      }

      const nvimOutput = takeMessages(messagesLog);

      let content = "";
      try {
        content = fs.readFileSync(commentsPath, "utf8");
      } catch {
        content = "";
      }
      const annotations = parseAnnotations(content);
      if (annotations.length === 0) {
        // nothing was annotated: drop the scaffold so the next run starts clean
        const leftover = compactComments(content).trim();
        if (!leftover) {
          try {
            fs.rmSync(commentsPath);
          } catch {
            // ignore
          }
        }
        ctx.ui.notify(
          `annotate: no annotations in ${name}` +
            (nvimOutput ? ` — Neovim reported: ${nvimOutput}` : ""),
          nvimOutput ? "warning" : "info",
        );
        return;
      }

      const summary = annotations.map((a) => `${a.range} ${a.kind}`).join(", ");
      const message = [
        `I reviewed ${rel(target)} in Neovim. Feedback from ${rel(commentsPath)} (${annotations.length} annotation${annotations.length === 1 ? "" : "s"}):`,
        "",
        compactComments(content),
        "",
        "---",
        `Apply this feedback to ${rel(target)}.`,
        "- Ranges are 1-based `line:column` spans into that file (`start-end`), as it was when I made the notes; verify the text still matches before editing.",
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
