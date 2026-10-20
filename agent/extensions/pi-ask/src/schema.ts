/**
 * pi-ask — the parameter schema.
 *
 * Written as plain JSON Schema rather than a TypeBox object so the extension
 * needs no build step and no dependency of its own; pi validates it exactly
 * like a TypeBox-authored one.
 *
 * Deliberately lenient about optional detail: a description and a preview are
 * requested by the description text and the guidelines, but a missing one
 * never fails the call. Only what the dialog cannot render is required.
 */

import { MAX_HEADER, MAX_LABEL, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./spec.ts";

const optionSchema = {
	type: "object",
	properties: {
		label: {
			type: "string",
			maxLength: MAX_LABEL,
			description: "The choice in 1-5 words, at most 60 characters, reading as an answer. Never 'Other', 'Type something.' or 'Next'.",
		},
		description: {
			type: "string",
			description: "One line: what this choice means, what it costs, or when it wins.",
		},
		preview: {
			type: "string",
			description:
				"Optional markdown artifact for this choice — an ASCII mockup, code snippet, config file or diagram, shown in a bordered box beside the options.",
		},
	},
	required: ["label", "description"],
} as const;

const questionSchema = {
	type: "object",
	properties: {
		question: {
			type: "string",
			description: "The full question the user reads, one sentence, ending in '?'.",
		},
		header: {
			type: "string",
			maxLength: MAX_HEADER,
			description: "One- or two-word chip naming the decision, at most 16 characters, e.g. 'Storage'. Defaults to Q1, Q2, …",
		},
		options: {
			type: "array",
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: `The ${MIN_OPTIONS}-${MAX_OPTIONS} authored choices for this question.`,
			items: optionSchema,
		},
		multiSelect: {
			type: "boolean",
			description: "True only when several options may be chosen together. Default false: one choice.",
		},
	},
	required: ["question", "options"],
} as const;

export const askUserQuestionParameters = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: MAX_QUESTIONS,
			description: `The questions to ask, ${1}-${MAX_QUESTIONS} of them, most consequential first. They arrive as one tabbed dialog.`,
			items: questionSchema,
		},
	},
	required: ["questions"],
} as const;
