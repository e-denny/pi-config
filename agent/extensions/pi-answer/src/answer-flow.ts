/**
 * pi-answer — one-at-a-time answering flow (TUI).
 *
 * A custom component modeled on the questionnaire example: the user answers
 * each question in pi's own Editor (Enter submits the answer and advances,
 * Shift+Enter inserts a newline), Tab/Shift+Tab navigate between questions,
 * and a final submit tab summarizes everything before the consolidated reply
 * is sent. Esc twice cancels.
 *
 * When the LLM included a ➡️ proposal for a question, the editor is prefilled
 * with it so the user can adopt (Enter), edit, or replace it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Question } from "./split.ts";

export interface FlowResult {
  cancelled: boolean;
  answers: string[];
}

export async function runAnswerFlow(
  ctx: ExtensionContext,
  questions: Question[],
  note?: string,
): Promise<FlowResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    throw new Error("Interactive answering requires TUI mode (use /answer-agent for headless answering)");
  }
  const count = questions.length;

  const result = await ctx.ui.custom<FlowResult>((tui, theme, _kb, done) => {
    // Draft answers per question; prefilled with the LLM's proposals.
    const answers: string[] = questions.map((q) => q.proposed ?? "");
    let current = 0; // 0..count-1 = questions, count = submit tab
    let loading = false;
    let escArmed = false;
    let cachedLines: string[] | undefined;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    editor.onChange = (text) => {
      if (!loading) answers[current] = text;
    };
    editor.onSubmit = (value) => {
      answers[current] = value;
      advance();
    };

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function loadEditor() {
      loading = true;
      editor.setText(answers[current] ?? "");
      loading = false;
    }

    function advance() {
      if (current < count - 1) {
        current++;
        loadEditor();
      } else {
        current = count; // submit tab
      }
      refresh();
    }

    function finish(cancelled: boolean) {
      done({ cancelled, answers: answers.map((a) => a.trim()) });
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) {
        if (escArmed) {
          finish(true);
          return;
        }
        escArmed = true;
        refresh();
        return;
      }
      escArmed = false;

      if (current === count) {
        // Submit tab — no editor; arrow keys are free for navigation.
        if (matchesKey(data, Key.enter)) {
          finish(false);
          return;
        }
        if (
          matchesKey(data, Key.tab) ||
          matchesKey(data, Key.shift("tab")) ||
          matchesKey(data, Key.left) ||
          matchesKey(data, Key.right)
        ) {
          current = Math.max(0, count - 1);
          loadEditor();
          refresh();
        }
        return;
      }

      // Question tab — Tab/Shift+Tab navigate; everything else goes to the editor.
      if (matchesKey(data, Key.tab)) {
        current = Math.min(count, current + 1);
        loadEditor();
        refresh();
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        current = Math.max(0, current - 1);
        loadEditor();
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const renderWidth = Math.max(1, width);
      const lines: string[] = [];

      function addWrapped(text: string) {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
      }

      function addWrappedWithPrefix(prefix: string, text: string) {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
        const continuationPrefix = " ".repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
        }
      }

      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      // Header
      const answeredCount = answers.filter((a) => a.trim()).length;
      const header = theme.fg("accent", theme.bold(" pi-answer "));
      const sub = theme.fg(
        "muted",
        `— ${count} question${count !== 1 ? "s" : ""}, one at a time (${answeredCount}/${count} answered)`,
      );
      addWrappedWithPrefix("", header + sub);
      if (note) {
        addWrappedWithPrefix(" ", theme.fg("dim", `Note from the LLM: ${note.replace(/\s+/g, " ")}`));
      }
      lines.push("");

      if (current === count) {
        // Submit tab
        addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to send")));
        lines.push("");
        for (let i = 0; i < count; i++) {
          const label = questions[i].label || String(i + 1);
          const a = answers[i].trim() || theme.fg("warning", "(no answer)");
          addWrappedWithPrefix(" ", `${theme.fg("muted", `${label}: `)}${a.replace(/\n/g, " ")}`);
        }
        lines.push("");
        addWrappedWithPrefix(
          " ",
          theme.fg("dim", "Enter to send the consolidated reply • Tab/← → to edit an answer • Esc to cancel"),
        );
      } else {
        // Question tab
        const q = questions[current];
        const label = q.label || String(current + 1);
        addWrappedWithPrefix(" ", theme.fg("accent", theme.bold(`${label}  (${current + 1}/${count})`)));
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("text", q.text));
        lines.push("");
        if (q.proposed) {
          addWrappedWithPrefix(" ", theme.fg("dim", `Proposal: ${q.proposed.replace(/\s+/g, " ")}`));
          addWrappedWithPrefix(" ", theme.fg("dim", "Prefilled — edit it or press Enter to adopt."));
          lines.push("");
        }
        addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, renderWidth - 2))) {
          lines.push(` ${line}`);
        }
        lines.push("");
        const hint = escArmed
          ? theme.fg("warning", "Press Esc again to cancel")
          : theme.fg("dim", "Enter = done (next) • Tab = next • Shift+Tab = back • Esc = cancel");
        addWrappedWithPrefix(" ", hint);
      }

      lines.push(theme.fg("accent", "─".repeat(renderWidth)));
      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });

  return result;
}
