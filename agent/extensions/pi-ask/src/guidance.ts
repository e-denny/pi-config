/**
 * pi-ask — what the model reads.
 *
 * This file is the whole contract between the model and the dialog. The
 * description teaches the shape of a question (header, authored options, one
 * line of consequence per option, optional preview); the snippet and the
 * guidelines are what make the model reach for the tool every time it needs
 * something from the user instead of writing questions into the transcript.
 *
 * Edit this file to change how eagerly or how strictly the model asks.
 */

import { CUSTOM_LABEL, MAX_OPTIONS, MAX_QUESTIONS, NEXT_LABEL } from "./spec.ts";

export const TOOL_NAME = "ask_user_question";

export const PROMPT_SNIPPET =
	"Ask the user up to four questions with authored options; they answer in a dialog and you get structured answers back";

export const DESCRIPTION = [
	"Ask the user instead of guessing. This is how you ask a question: your options are presented in a dialog the user answers with arrow keys, and their choices come back to you as structured data.",
	"",
	"Reach for it whenever the next step depends on something only the user knows or decides: an ambiguous requirement, two approaches that both fit, a preference between conventions, a missing constraint (target OS, audience, budget, deadline), a choice whose cost lands on them, or a confirmation before something irreversible. Prefer one call that asks everything you need over a conversation of follow-ups.",
	"",
	"Do not use it to report progress, to ask permission for work already agreed, to request a value you could read from the repository, or to hand the user a decision you should make yourself.",
	"",
	"How to shape a question so it can be answered by moving a cursor:",
	"",
	"- question: the full sentence you are asking, ending in \"?\". One question, no preamble, no numbered sub-asks.",
	'- header: a one- or two-word chip naming the decision, at most 16 characters — "Storage", "Scope", "Target OS". It is how the user navigates between tabs.',
	"- options: 2-4 mutually exclusive choices. label names the choice in 1-5 words (at most 60 characters) and must read as an answer. description is one line saying what the choice means, what it costs, or when it wins — the user should not have to open another file to judge it. Put your recommendation first and say why in its description.",
	"- preview: optional markdown for an option that is easier to judge than to describe — an ASCII mockup, a code snippet, a config file, a small diagram. It renders beside the options; keep it under about 30 lines.",
	"- multiSelect: true only when the choices genuinely combine (files to include, checks to run). Otherwise the user must pick one and the dialog shows a single choice.",
	"",
	`Ask at most ${MAX_QUESTIONS} questions in one call; they arrive as one tabbed dialog with a Submit tab that reviews everything before it goes back. Every question also offers a "${CUSTOM_LABEL}" row, so never write an option called "${CUSTOM_LABEL}", "${NEXT_LABEL}" or "Other" — the dialog handles those itself.`,
	"",
	"The result tells you which label each question got, what the user typed if they answered in their own words, which questions they left blank, and any notes they attached. Treat those answers as decided: continue with the work, and do not re-ask what the user already answered.",
].join("\n");

export const PROMPT_GUIDELINES = [
	"When a question for the user is the next step, call ask_user_question instead of writing the question as chat text; never list numbered questions and wait for a prose reply.",
	"Ask every question you need in one ask_user_question call (up to 4), most consequential first, rather than interrupting once per question.",
	"Give every question 2-4 authored options, each with a one-line description of what it means or costs, and put the recommended option first with the reason in its description.",
	"Add an option preview (mockup, snippet, config, diagram) when the user can judge the choice faster by seeing the artifact than by reading a description.",
	"Ask at most once per turn, and never ask something you could answer by reading the repository, the docs, or the current diff.",
];
