/**
 * pi-answer — split an LLM's batch of questions, answer them one at a time,
 * and consolidate the answers into a single reply sent back to the LLM.
 *
 * Commands:
 *   /answer            Split the last assistant reply (or --text/--file) into
 *                      questions, answer them one at a time in a TUI flow, and
 *                      send one consolidated reply back to the LLM.
 *   /answer-agent      Same, but each question is answered by a fresh pi
 *                      subprocess (full tool access) instead of the user.
 *
 * Flags (on /answer and /answer-agent):
 *   --text "..."       Questions from the given text instead of the last reply.
 *   --file path        Questions from a file.
 *   --agent            Force subagent answering (also /answer-agent).
 *   --verbose          Include the full question text in the consolidated reply.
 *   --review           Put the consolidated reply in the editor instead of
 *                      sending it automatically, so you can review/edit first.
 *
 * CLI flag:
 *   --answer-auto      Automatically start the flow when an assistant reply
 *                      contains 2+ questions (TUI mode only).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerSequentially } from "./agent-answer.ts";
import { runAnswerFlow } from "./answer-flow.ts";
import { buildReply } from "./consolidate.ts";
import { splitQuestions } from "./split.ts";
import { lastAssistantText, parseArgs, type Args } from "./util.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("answer-auto", {
    type: "boolean",
    default: false,
    description:
      "pi-answer: when the assistant's reply contains multiple questions, automatically split them and answer one at a time.",
  });

  pi.registerCommand("answer", {
    description:
      "Split the last assistant reply (or --text/--file) into questions, answer them one at a time, and send one consolidated reply back. Flags: --text, --file, --agent, --verbose, --review.",
    handler: async (args, ctx) => {
      await handle(pi, ctx, parseArgs(args), false);
    },
  });

  pi.registerCommand("answer-agent", {
    description:
      "Like /answer but each question is answered by a fresh pi subprocess, then consolidated and sent back. Flags: --text, --file, --verbose, --review.",
    handler: async (args, ctx) => {
      await handle(pi, ctx, parseArgs(args), true);
    },
  });

  // Optional fully-automatic mode: detect 2+ questions in an assistant reply
  // and start the interactive answering flow right away.
  let autoRunning = false;
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      if (!pi.getFlag("answer-auto")) return;
      if (autoRunning || ctx.mode !== "tui" || !ctx.hasUI) return;
      if (ctx.hasPendingMessages?.()) return; // user already steered/followed up
      const text = lastAssistantText(ctx);
      if (!text) return;
      const split = splitQuestions(text);
      if (split.questions.length < 2) return;

      autoRunning = true;
      try {
        ctx.ui.notify(
          `pi-answer: detected ${split.questions.length} questions in the last reply — answering one at a time.`,
          "info",
        );
        await handle(pi, ctx, {}, false);
      } finally {
        autoRunning = false;
      }
    } catch {
      // The session may already be tearing down (e.g. single-shot print
      // mode), in which case the runtime is stale — nothing to do.
    }
  });
}

async function handle(pi: ExtensionAPI, ctx: ExtensionContext, args: Args, forceAgent: boolean): Promise<void> {
  try {
    const useAgent = forceAgent || args.agent;

    // --- Source text -----------------------------------------------------
    let source: string | undefined;
    if (args.text !== undefined) {
      source = args.text;
    } else if (args.file) {
      try {
        source = readFileSync(resolve(ctx.cwd, args.file), "utf8");
      } catch (err) {
        ctx.ui.notify(`pi-answer: cannot read ${args.file}: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
    } else {
      source = lastAssistantText(ctx);
    }
    if (!source?.trim()) {
      ctx.ui.notify(
        'pi-answer: no text to split. Pass --text "..." or --file path, or run right after an assistant reply.',
        "error",
      );
      return;
    }

    // --- Split -----------------------------------------------------------
    const split = splitQuestions(source);
    if (split.questions.length === 0) {
      ctx.ui.notify(
        "pi-answer: no questions detected in that text. Use --text/--file, or check the message format.",
        "error",
      );
      return;
    }

    // --- Answer one at a time --------------------------------------------
    let answers: string[];
    if (useAgent) {
      ctx.ui.setStatus("pi-answer", `pi-answer: answering ${split.questions.length} questions via subagents…`);
      try {
        answers = await answerSequentially(split.questions, {
          preamble: split.preamble,
          cwd: ctx.cwd,
          model: ctx.model?.id,
          thinking: ctx.thinkingLevel,
          onProgress: (i, n) => ctx.ui.setStatus("pi-answer", `pi-answer: answering question ${i}/${n} via subagent…`),
        });
      } finally {
        ctx.ui.setStatus("pi-answer", undefined);
      }
    } else {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("pi-answer: interactive answering requires TUI mode. Use /answer-agent for headless answering.", "error");
        return;
      }
      const result = await runAnswerFlow(ctx, split.questions, split.trailing || undefined);
      if (result.cancelled) {
        ctx.ui.notify("pi-answer: cancelled — nothing sent.", "info");
        return;
      }
      answers = result.answers;
    }

    // --- Consolidate and deliver ----------------------------------------
    const reply = buildReply(split.questions, answers, { verbose: args.verbose });

    if (args.review) {
      ctx.ui.setEditorText(reply);
      ctx.ui.notify(
        `pi-answer: consolidated reply (${split.questions.length} answers) is in the editor — review, edit, then send.`,
        "info",
      );
      return;
    }

    try {
      pi.sendUserMessage(reply);
    } catch {
      // Streaming edge case: deliver after the current turn's tools finish.
      pi.sendUserMessage(reply, { deliverAs: "followUp" });
    }
    ctx.ui.notify(`pi-answer: sent consolidated reply (${split.questions.length} answers).`, "success");
  } catch (err) {
    ctx.ui.setStatus("pi-answer", undefined);
    ctx.ui.notify(`pi-answer: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
