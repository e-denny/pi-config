/**
 * pi-ask — the answer the model reads.
 *
 * The envelope is one sentence of prose plus the segments a model can act on:
 * the answer per question, the preview it chose, any note the user wrote, the
 * questions left blank, and the questionnaire-wide note. A decline collapses to
 * one canonical string so the model cannot misread an abandoned dialog as an
 * answer.
 */

import { isAnswered, type AnswerRecord, type QuestionnaireDetails } from "./spec.ts";

export const DECLINE_TEXT = "User declined to answer questions";

/** The answer as prose: checked labels and typed text, comma-joined. */
export function answerText(answer: AnswerRecord): string {
	const parts: string[] = [];
	if (answer.selected && answer.selected.length > 0) parts.push(answer.selected.join(", "));
	const custom = answer.custom?.trim();
	if (custom) parts.push(custom);
	if (parts.length > 0) return parts.join(", ");
	return answer.answer?.trim() ?? "";
}

function segment(answer: AnswerRecord): string {
	let text = `"${answer.question}"="${answerText(answer)}"`;
	if (answer.preview) text += `. selected preview: ${answer.preview}`;
	if (answer.notes) text += `. user notes: ${answer.notes}`;
	return text;
}

/**
 * Build the model-facing text for a finished questionnaire. Cancelling, and any
 * result with neither an answer nor a global note, collapse to the decline.
 */
export function buildEnvelope(details: QuestionnaireDetails): string {
	if (details.cancelled) return DECLINE_TEXT;

	const answered = details.answers.filter(isAnswered);
	const globalNote = details.globalNote?.trim() || undefined;
	if (answered.length === 0 && !globalNote) return DECLINE_TEXT;

	let text =
		answered.length > 0
			? `User has answered your questions: ${answered.map(segment).join(". ")}.`
			: "User submitted the questionnaire without answering any question.";

	const blanks = details.answers.filter((answer) => !isAnswered(answer));
	if (blanks.length > 0) {
		text += ` unanswered: ${blanks.map((answer) => `"${answer.question}"`).join(", ")}.`;
	}
	if (globalNote) text += ` global note: ${globalNote}.`;
	text += " You can now continue with the user's answers in mind.";
	return text;
}

/** Failures are model-facing too: say what to fix, not what broke. */
export function buildErrorText(code: string, message: string): string {
	return `ask_user_question could not show the questionnaire (${code}): ${message}`;
}
