/**
 * pi-ask — the questionnaire contract.
 *
 * One place that says what the model may send, what gets rejected, and the
 * shape of what comes back. Everything here is pure: no terminal, no pi
 * runtime. The UI and the tool wrapper both sit on top of it.
 */

/** Hard limits. Kept small on purpose: one interruption, not five. */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 16;
export const MAX_LABEL = 60;

/** The two rows the dialog appends itself, plus the one models reach for. */
export const CUSTOM_LABEL = "Type something.";
export const NEXT_LABEL = "Next";
export const RESERVED_LABELS: readonly string[] = ["Other", CUSTOM_LABEL, NEXT_LABEL];

export interface OptionSpec {
	/** 1-5 words naming the choice. */
	label: string;
	/** One line: what the choice means, or what it costs. */
	description: string;
	/** Optional markdown artifact rendered beside the option list. */
	preview?: string;
}

export interface QuestionSpec {
	/** The full question, one sentence, ending in "?". */
	question: string;
	/** Two-word chip naming the decision, e.g. "Storage". */
	header: string;
	options: OptionSpec[];
	multiSelect: boolean;
}

export type AskErrorCode =
	| "no_questions"
	| "too_many_questions"
	| "empty_question"
	| "duplicate_question"
	| "empty_options"
	| "too_many_options"
	| "empty_option_label"
	| "reserved_label"
	| "duplicate_option_label"
	| "no_ui"
	| "no_custom_ui"
	| "internal_error";

export interface AskError {
	code: AskErrorCode;
	/** Written for the model, not for a log. */
	message: string;
}

/**
 * One question's outcome.
 *
 * - `option`: a single-select question confirmed an authored label.
 * - `custom`: the user typed the answer (single-select).
 * - `multi`: a multi-select question; `selected` holds checked labels and
 *   `custom` holds typed text, either or both.
 * - `none`: left blank. Reported, never invented.
 */
export interface AnswerRecord {
	questionIndex: number;
	question: string;
	header: string;
	kind: "option" | "custom" | "multi" | "none";
	/** Human-readable answer, or null when nothing was chosen. */
	answer: string | null;
	/** Checked labels, multi-select only. */
	selected?: string[];
	/** Typed answer text, when the user wrote one. */
	custom?: string;
	/** Free-text note attached to this answer. */
	notes?: string;
	/** Echoed back when the chosen option carried a preview. */
	preview?: string;
}

export interface QuestionnaireDetails {
	answers: AnswerRecord[];
	cancelled: boolean;
	/** Submit-tab note covering the whole questionnaire. */
	globalNote?: string;
	/** Indexes of questions left blank. */
	unanswered?: number[];
	error?: AskErrorCode;
}

const RESERVED = new Set(RESERVED_LABELS.map((label) => normalizeLabel(label)));

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Labels are compared without case or a trailing period so that "Other",
 * "other" and "Other." all count as the same reserved row.
 */
export function normalizeLabel(label: string): string {
	return label.trim().replace(/\.+$/, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizeOption(raw: unknown): OptionSpec {
	const option = (raw ?? {}) as Record<string, unknown>;
	const preview = asText(option.preview);
	const spec: OptionSpec = {
		label: asText(option.label).slice(0, MAX_LABEL),
		description: asText(option.description),
	};
	if (preview) spec.preview = preview;
	return spec;
}

/**
 * Coerce whatever the model sent into well-formed specs. Deliberately
 * forgiving: a missing header becomes Q1, a missing description stays empty,
 * an over-long header or label is cut. Validation then only rejects what the
 * dialog genuinely cannot render.
 */
export function normalizeQuestions(input: unknown): QuestionSpec[] {
	if (!Array.isArray(input)) return [];
	return input.map((raw, index) => {
		const question = (raw ?? {}) as Record<string, unknown>;
		const header = asText(question.header).slice(0, MAX_HEADER);
		return {
			question: asText(question.question).replace(/\s+/g, " "),
			header: header || `Q${index + 1}`,
			options: Array.isArray(question.options) ? question.options.map(normalizeOption) : [],
			multiSelect: question.multiSelect === true || question.multiSelect === "true",
		};
	});
}

function fail(code: AskErrorCode, message: string): AskError {
	return { code, message };
}

/** Reject only what cannot be shown. First failure wins. */
export function validateQuestions(questions: QuestionSpec[]): AskError | undefined {
	if (questions.length === 0) {
		return fail("no_questions", 'No questions were sent. Pass 1-4 entries in "questions".');
	}
	if (questions.length > MAX_QUESTIONS) {
		return fail(
			"too_many_questions",
			`${questions.length} questions is more than one dialog can hold. Ask at most ${MAX_QUESTIONS}, most important first.`,
		);
	}

	const seenQuestions = new Set<string>();
	for (let index = 0; index < questions.length; index++) {
		const question = questions[index];
		const where = `questions[${index}]`;

		if (!question.question) {
			return fail("empty_question", `${where}.question is empty. Write the full question the user should read.`);
		}
		const key = normalizeLabel(question.question);
		if (seenQuestions.has(key)) {
			return fail(
				"duplicate_question",
				`${where}.question repeats an earlier question. Ask it once, with the options that distinguish the answers.`,
			);
		}
		seenQuestions.add(key);

		if (question.options.length < MIN_OPTIONS) {
			return fail(
				"empty_options",
				`${where} has ${question.options.length} option(s). Every question needs ${MIN_OPTIONS}-${MAX_OPTIONS} authored options with descriptions; the dialog appends its own "Type something." row.`,
			);
		}
		if (question.options.length > MAX_OPTIONS) {
			return fail(
				"too_many_options",
				`${where} has ${question.options.length} options; the limit is ${MAX_OPTIONS}. Merge the closest ones or move the rest into a second question.`,
			);
		}

		const seenLabels = new Set<string>();
		for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
			const label = question.options[optionIndex].label;
			if (!label) {
				return fail("empty_option_label", `${where}.options[${optionIndex}].label is empty. Name the choice in 1-5 words.`);
			}
			if (RESERVED.has(normalizeLabel(label))) {
				return fail(
					"reserved_label",
					`${where}.options[${optionIndex}] uses the reserved label "${label}". The dialog appends "${CUSTOM_LABEL}" and "${NEXT_LABEL}" itself, and "Other" invites a non-answer; name the actual choice instead.`,
				);
			}
			if (seenLabels.has(normalizeLabel(label))) {
				return fail(
					"duplicate_option_label",
					`${where} has two options labelled "${label}". Labels must be distinct so the answer is unambiguous.`,
				);
			}
			seenLabels.add(normalizeLabel(label));
		}
	}
	return undefined;
}

/** A question counts as answered once a label or typed text exists. */
export function isAnswered(answer: AnswerRecord): boolean {
	if (answer.kind === "none") return false;
	if (answer.selected && answer.selected.length > 0) return true;
	return Boolean(answer.answer && answer.answer.trim());
}

export interface AnswerParts {
	/** Chosen option indexes. Single-select keeps at most one. */
	checked: Iterable<number>;
	/** Text typed into the "Type something." row. */
	custom?: string;
	/** True once typed text, not an option, is the single-select answer. */
	customCommitted?: boolean;
	/** Note attached to this answer. */
	note?: string;
}

/**
 * Turn one question's state into an {@link AnswerRecord}. Shared by the TUI
 * dialog and the host-dialog fallback so both report answers identically.
 */
export function composeAnswer(question: QuestionSpec, questionIndex: number, parts: AnswerParts): AnswerRecord {
	const base = { questionIndex, question: question.question, header: question.header };
	const note = parts.note?.trim();
	const custom = parts.custom?.trim() ?? "";
	const notes = note ? { notes: note } : {};
	const checked = [...parts.checked].sort((a, b) => a - b);

	if (question.multiSelect) {
		const selected = checked
			.map((index) => question.options[index]?.label)
			.filter((label): label is string => Boolean(label));
		if (selected.length === 0 && !custom) return { ...base, kind: "none", answer: null, ...notes };
		return {
			...base,
			kind: "multi",
			answer: [...selected, ...(custom ? [custom] : [])].join(", "),
			...(selected.length > 0 ? { selected } : {}),
			...(custom ? { custom } : {}),
			...notes,
		};
	}

	if (parts.customCommitted && custom) return { ...base, kind: "custom", answer: custom, custom, ...notes };

	const chosen = checked[0];
	const option = chosen === undefined ? undefined : question.options[chosen];
	if (option) {
		return {
			...base,
			kind: "option",
			answer: option.label,
			...(option.preview ? { preview: option.preview } : {}),
			...notes,
		};
	}
	if (custom) return { ...base, kind: "custom", answer: custom, custom, ...notes };
	return { ...base, kind: "none", answer: null, ...notes };
}
