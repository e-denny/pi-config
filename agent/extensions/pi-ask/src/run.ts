/**
 * pi-ask — running one questionnaire.
 *
 * Validates what the model sent, picks the widest interaction the current host
 * supports (terminal dialog, then native host dialogs), and turns the outcome
 * into the tool result the model reads.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { buildEnvelope, buildErrorText } from "./envelope.ts";
import { runHostDialogQuestionnaire } from "./fallback.ts";
import {
	normalizeQuestions,
	type AskErrorCode,
	type QuestionnaireDetails,
	type QuestionSpec,
	validateQuestions,
} from "./spec.ts";
import { createQuestionnaire } from "./ui/questionnaire.ts";

export interface AskToolResult {
	content: { type: "text"; text: string }[];
	details: QuestionnaireDetails;
}

function failure(code: AskErrorCode, message: string): AskToolResult {
	return {
		content: [{ type: "text", text: buildErrorText(code, message) }],
		details: { answers: [], cancelled: true, error: code },
	};
}

function success(details: QuestionnaireDetails): AskToolResult {
	return { content: [{ type: "text", text: buildEnvelope(details) }], details };
}

/**
 * One BEL when the dialog starts waiting, so a user who looked away notices.
 * Only for a real terminal; redirected output stays untouched.
 */
function ringBell(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write("\x07");
	} catch {
		// A closed or redirected stdout is not worth failing a question over.
	}
}

/**
 * What pi reports to the terminal while the dialog waits for the user.
 *
 * `ctx.ui.custom()` hosts loaders and other non-blocking components, so pi
 * cannot assume a custom component needs an answer and reports nothing on its
 * own; passing `blocked` is what makes the terminal (and anything watching
 * OSC 7501, such as an agent dashboard) show "needs input" instead of
 * "working" for the whole questionnaire.
 */
function blockedStatus(questions: QuestionSpec[]): { kind: "question"; message: string } {
	const first = questions[0]?.question ?? "Question";
	const message = questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first;
	return { kind: "question", message: message.length > 120 ? `${message.slice(0, 119)}…` : message };
}

export async function runAskUserQuestion(
	params: unknown,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskToolResult> {
	const raw = (params ?? {}) as { questions?: unknown };
	const questions = normalizeQuestions(raw.questions);

	const invalid = validateQuestions(questions);
	if (invalid) return failure(invalid.code, invalid.message);

	if (!ctx.hasUI) {
		return failure(
			"no_ui",
			"This run has no user interface, so no one can answer. Continue without asking, or make the decision yourself and state your assumption.",
		);
	}

	if (ctx.mode !== "tui") {
		if (typeof ctx.ui.select !== "function" || typeof ctx.ui.input !== "function") {
			return failure("no_custom_ui", "This host has no dialogs available for questions. Continue without asking.");
		}
		try {
			return success(await runHostDialogQuestionnaire(questions, ctx));
		} catch (error) {
			return failure("internal_error", error instanceof Error ? error.message : String(error));
		}
	}

	ringBell();
	const { collapseKey } = loadConfig();
	try {
		const details = await ctx.ui.custom<QuestionnaireDetails>(
			(tui, theme, keybindings, done) =>
				createQuestionnaire({ tui, theme, keybindings, questions, collapseKey, signal, done }),
			{ blocked: blockedStatus(questions) },
		);
		return success(details);
	} catch (error) {
		return failure("internal_error", error instanceof Error ? error.message : String(error));
	}
}
