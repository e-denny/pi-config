/**
 * pi-ask — how a question and its answer look in the transcript.
 *
 * The call row names the questions being asked; the result row echoes each
 * answer so the transcript still says what the user decided after the dialog
 * is long gone.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { answerText } from "./envelope.ts";
import { isAnswered, type QuestionnaireDetails } from "./spec.ts";

interface CallArgs {
	questions?: Array<{ header?: unknown; multiSelect?: unknown }>;
}

export function renderAskCall(args: CallArgs | undefined, theme: Theme): Text {
	const questions = Array.isArray(args?.questions) ? args.questions : [];
	const count = questions.length;
	const headers = questions
		.map((question, index) => {
			const header = typeof question?.header === "string" && question.header.trim() ? question.header.trim() : `Q${index + 1}`;
			return question?.multiSelect === true ? `${header} (multi)` : header;
		})
		.join(", ");

	let line = `${theme.fg("toolTitle", theme.bold("ask_user_question"))} `;
	line += theme.fg("muted", count === 1 ? "1 question" : `${count} questions`);
	if (headers) line += theme.fg("dim", ` (${headers})`);
	return new Text(line, 0, 0);
}

export function renderAskResult(result: { details?: QuestionnaireDetails }, theme: Theme): Text {
	const details = result.details;
	if (!details) return new Text(theme.fg("dim", "asked the user"), 0, 0);

	if (details.error) {
		return new Text(theme.fg("warning", `could not ask the user (${details.error})`), 0, 0);
	}
	if (details.cancelled) {
		return new Text(theme.fg("warning", "User declined to answer"), 0, 0);
	}

	const lines = details.answers.map((answer) => {
		const mark = isAnswered(answer) ? theme.fg("success", "✓") : theme.fg("warning", "○");
		const header = theme.fg("accent", answer.header);
		const value = isAnswered(answer)
			? theme.fg("text", answerText(answer).replace(/\s+/g, " "))
			: theme.fg("dim", "(left blank)");
		const note = answer.notes ? theme.fg("dim", " + note") : "";
		return `${mark} ${header}: ${value}${note}`;
	});
	if (details.globalNote) lines.push(theme.fg("dim", `note: ${details.globalNote.replace(/\s+/g, " ")}`));
	return new Text(lines.length > 0 ? lines.join("\n") : theme.fg("dim", "no answers"), 0, 0);
}
