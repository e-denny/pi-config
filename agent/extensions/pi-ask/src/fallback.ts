/**
 * pi-ask — the same questionnaire through the host's native dialogs.
 *
 * RPC and ACP hosts (the VS Code pendant, Zed) forward select and input
 * dialogs but cannot render a custom terminal component. Rather than failing
 * the call, walk the questions one at a time through those dialogs. Notes are
 * terminal-only and do not carry over; everything else does.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CUSTOM_LABEL,
	composeAnswer,
	type QuestionSpec,
	type QuestionnaireDetails,
} from "./spec.ts";

const DONE_LABEL = "Done";

function declined(): QuestionnaireDetails {
	return { answers: [], cancelled: true };
}

export async function runHostDialogQuestionnaire(
	questions: QuestionSpec[],
	ctx: ExtensionContext,
): Promise<QuestionnaireDetails> {
	const answers = [];

	for (let index = 0; index < questions.length; index++) {
		const question = questions[index];
		const title = `${question.header}: ${question.question}`;

		if (question.multiSelect) {
			const checked = new Set<number>();
			let custom = "";
			for (;;) {
				const labels = question.options.map(
					(option, optionIndex) => `${checked.has(optionIndex) ? "[x]" : "[ ]"} ${optionIndex + 1}. ${option.label}`,
				);
				const choices = [...labels, CUSTOM_LABEL, DONE_LABEL];
				const choice = await ctx.ui.select(title, choices);
				if (choice === undefined) return declined();
				if (choice === DONE_LABEL) break;
				if (choice === CUSTOM_LABEL) {
					const typed = await ctx.ui.input(question.header, "Your answer");
					if (typed === undefined) return declined();
					custom = typed.trim();
					continue;
				}
				const optionIndex = labels.indexOf(choice);
				if (optionIndex < 0) continue;
				if (checked.has(optionIndex)) checked.delete(optionIndex);
				else checked.add(optionIndex);
			}
			answers.push(composeAnswer(question, index, { checked, custom }));
			continue;
		}

		const choices = [...question.options.map((option) => option.label), CUSTOM_LABEL];
		const choice = await ctx.ui.select(title, choices);
		if (choice === undefined) return declined();
		if (choice === CUSTOM_LABEL) {
			const typed = await ctx.ui.input(question.header, "Your answer");
			if (typed === undefined) return declined();
			answers.push(composeAnswer(question, index, { checked: [], custom: typed, customCommitted: true }));
			continue;
		}
		const optionIndex = question.options.findIndex((option) => option.label === choice);
		answers.push(composeAnswer(question, index, { checked: optionIndex >= 0 ? [optionIndex] : [] }));
	}

	const unanswered = answers
		.map((answer, index) => (answer.kind === "none" ? index : -1))
		.filter((index) => index >= 0);
	return {
		answers,
		cancelled: false,
		...(unanswered.length > 0 ? { unanswered } : {}),
	};
}
