/**
 * pi-ask — one tool, ask_user_question.
 *
 * The model asks; the user answers in a tabbed dialog with authored options,
 * a "Type something." row, notes and an optional preview; the answers come
 * back as structured data. See guidance.ts for the model-facing contract and
 * ui/questionnaire.ts for the dialog.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { DESCRIPTION, PROMPT_GUIDELINES, PROMPT_SNIPPET, TOOL_NAME } from "./guidance.ts";
import { renderAskCall, renderAskResult } from "./render.ts";
import { runAskUserQuestion } from "./run.ts";
import { askUserQuestionParameters } from "./schema.ts";

/** A throwaway questionnaire for /ask, so the dialog can be seen without a model. */
const DEMO_PARAMS = {
	questions: [
		{
			question: "Which storage backend should the cache use?",
			header: "Storage",
			options: [
				{
					label: "In-process LRU (Recommended)",
					description: "No new service, evicts by count; dies with the process.",
					preview: [
						"cache = LruCache(max=1000)",
						"",
						"// one process, no network hop",
						"cache.get(key) ?? fetch(key)",
					].join("\n"),
				},
				{
					label: "Redis",
					description: "Shared across workers and survives restarts; adds a service to run.",
				},
				{ label: "Files on disk", description: "Trivially inspectable, slow under concurrency." },
			],
		},
		{
			question: "Which checks should run before a commit?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Typecheck", description: "tsc --noEmit; catches broken signatures." },
				{ label: "Unit tests", description: "The fast suite; about 4 seconds." },
				{ label: "Lint", description: "Formatting and import order." },
			],
		},
	],
};

export default function piAsk(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask user question",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: askUserQuestionParameters,
		// The dialog owns the keyboard, so two questionnaires must never overlap.
		executionMode: "sequential",
		async execute(
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return await runAskUserQuestion(params, ctx, signal);
		},
		renderCall(args: unknown, theme: Theme) {
			return renderAskCall(args as Parameters<typeof renderAskCall>[0], theme);
		},
		renderResult(result: unknown, _options: unknown, theme: Theme) {
			return renderAskResult(result as Parameters<typeof renderAskResult>[0], theme);
		},
	} as unknown as ToolDefinition);

	pi.registerCommand("ask", {
		description: "pi-ask: open a demo questionnaire to see the dialog without asking the model.",
		handler: async (_args, ctx) => {
			const result = await runAskUserQuestion(DEMO_PARAMS, ctx);
			if (result.details.error) {
				ctx.ui.notify(`pi-ask: ${result.content[0]?.text ?? "could not open the dialog"}`, "error");
				return;
			}
			if (result.details.cancelled) {
				ctx.ui.notify("pi-ask demo: cancelled.", "info");
				return;
			}
			const answers = result.details.answers
				.map((answer) => `${answer.header}=${answer.answer ?? "(blank)"}`)
				.join(" · ");
			ctx.ui.notify(`pi-ask demo: ${answers}`, "info");
		},
	});
}
