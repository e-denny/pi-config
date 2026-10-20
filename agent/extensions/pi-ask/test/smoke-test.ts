/**
 * pi-ask smoke test — pure logic and the dialog, no pi runtime.
 *
 * Run with test/run.sh, which symlinks pi's packages next to this file so the
 * same imports the extension uses resolve outside pi.
 */

import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, type KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";

import { buildEnvelope, DECLINE_TEXT } from "../src/envelope.ts";
import piAsk from "../src/index.ts";
import { renderAskCall, renderAskResult } from "../src/render.ts";
import {
	composeAnswer,
	CUSTOM_LABEL,
	NEXT_LABEL,
	normalizeQuestions,
	type QuestionSpec,
	type QuestionnaireDetails,
	validateQuestions,
} from "../src/spec.ts";
import { createQuestionnaire } from "../src/ui/questionnaire.ts";

// ----------------------------------------------------------------- mocks

const tui = {
	terminal: { rows: 40, columns: 120 },
	requestRender() {},
	setFocus() {},
} as unknown as TUI;

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
} as unknown as Theme;

const keybindings = { matches: () => false } as unknown as KeybindingsManager;

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	space: " ",
};

function spec(overrides: Partial<QuestionSpec> = {}, optionCount = 2): QuestionSpec {
	return {
		question: "Which storage backend should the cache use?",
		header: "Storage",
		options: Array.from({ length: optionCount }, (_, index) => ({
			label: `Option ${index + 1}`,
			description: `What option ${index + 1} costs.`,
		})),
		multiSelect: false,
		...overrides,
	};
}

interface Harness {
	component: Component & Focusable;
	keys: (...sequence: string[]) => void;
	result: () => QuestionnaireDetails | undefined;
	render: (width: number) => string[];
	text: (width?: number) => string;
}

function open(
	questions: QuestionSpec[],
	options: { collapseKey?: string; signal?: AbortSignal } = {},
): Harness {
	let result: QuestionnaireDetails | undefined;
	const component = createQuestionnaire({
		tui,
		theme,
		keybindings,
		questions,
		collapseKey: options.collapseKey ?? "ctrl+]",
		signal: options.signal,
		done: (value) => {
			result = value;
		},
	});
	component.focused = true;
	const render = (width: number) => component.render(width);
	return {
		component,
		keys: (...sequence: string[]) => {
			for (const key of sequence) component.handleInput?.(key);
		},
		result: () => result,
		render,
		text: (width = 120) => render(width).join("\n"),
	};
}

const checks: Array<[string, () => void]> = [];
function test(name: string, run: () => void): void {
	checks.push([name, run]);
}

// --------------------------------------------------------------- validation

test("rejects an empty questionnaire", () => {
	const questions = normalizeQuestions([]);
	assert.equal(validateQuestions(questions)?.code, "no_questions");
});

test("rejects more than four questions", () => {
	const questions = normalizeQuestions(Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, options: [] })));
	assert.equal(validateQuestions(questions)?.code, "too_many_questions");
});

test("rejects fewer than two options", () => {
	const questions = normalizeQuestions([{ question: "Pick one?", options: [{ label: "Only", description: "" }] }]);
	assert.equal(validateQuestions(questions)?.code, "empty_options");
});

test("rejects reserved labels, case and period insensitive", () => {
	for (const label of ["Other", "other.", "Type something.", NEXT_LABEL]) {
		const questions = normalizeQuestions([
			{ question: "Pick one?", options: [{ label }, { label: "Mine", description: "" }] },
		]);
		assert.equal(validateQuestions(questions)?.code, "reserved_label", label);
	}
});

test("rejects duplicate labels and duplicate questions", () => {
	const duplicateLabel = normalizeQuestions([
		{ question: "Pick one?", options: [{ label: "Same" }, { label: "same" }] },
	]);
	assert.equal(validateQuestions(duplicateLabel)?.code, "duplicate_option_label");

	const duplicateQuestion = normalizeQuestions([
		{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] },
		{ question: "pick  one?", options: [{ label: "A" }, { label: "B" }] },
	]);
	assert.equal(validateQuestions(duplicateQuestion)?.code, "duplicate_question");
});

test("normalizes defaults and cuts over-long fields", () => {
	const [question] = normalizeQuestions([
		{
			question: "  Pick   one?  ",
			header: "a header far longer than sixteen characters",
			options: [{ label: "L".repeat(80) }, { label: "B" }],
		},
	]);
	assert.equal(question.question, "Pick one?");
	assert.equal(question.header.length, 16);
	assert.equal(question.options[0].label.length, 60);
	assert.equal(validateQuestions([question]), undefined);
});

// ----------------------------------------------------------------- envelope

test("envelope lists answers, notes, blanks and the global note", () => {
	const details: QuestionnaireDetails = {
		cancelled: false,
		answers: [
			{
				questionIndex: 0,
				question: "Which storage?",
				header: "Storage",
				kind: "option",
				answer: "Redis",
				preview: "cache = redis()",
				notes: "prod parity",
			},
			{ questionIndex: 1, question: "Which tests?", header: "Tests", kind: "none", answer: null },
		],
		globalNote: "ship it Friday",
	};
	const text = buildEnvelope(details);
	assert.match(text, /^User has answered your questions: "Which storage\?"="Redis"\./);
	assert.match(text, /selected preview: cache = redis\(\)/);
	assert.match(text, /user notes: prod parity/);
	assert.match(text, /unanswered: "Which tests\?"/);
	assert.match(text, /global note: ship it Friday/);
	assert.match(text, /continue with the user's answers in mind/);
});

test("a decline and an empty submission both read as the decline", () => {
	assert.equal(buildEnvelope({ answers: [], cancelled: true }), DECLINE_TEXT);
	assert.equal(
		buildEnvelope({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Q?", header: "Q", kind: "none", answer: null }],
		}),
		DECLINE_TEXT,
	);
});

test("a global note alone counts as an answer", () => {
	const text = buildEnvelope({
		cancelled: false,
		answers: [],
		globalNote: "ask me tomorrow",
	});
	assert.match(text, /global note: ask me tomorrow/);
});

// ------------------------------------------------------------- answer shapes

test("composeAnswer covers option, custom, multi and blank", () => {
	const question = spec();
	assert.deepEqual(composeAnswer(question, 0, { checked: [1] }), {
		questionIndex: 0,
		question: question.question,
		header: "Storage",
		kind: "option",
		answer: "Option 2",
	});
	assert.equal(composeAnswer(question, 0, { checked: [0], custom: "mine", customCommitted: true }).kind, "custom");
	assert.equal(composeAnswer(question, 0, { checked: [], custom: "mine" }).kind, "custom");

	const multi = spec({ multiSelect: true }, 3);
	const answer = composeAnswer(multi, 0, { checked: [2, 0], custom: "and this" });
	assert.equal(answer.kind, "multi");
	assert.deepEqual(answer.selected, ["Option 1", "Option 3"]);
	assert.equal(answer.answer, "Option 1, Option 3, and this");
	assert.equal(composeAnswer(multi, 0, { checked: [] }).kind, "none");
});

// -------------------------------------------------------------------- dialog

test("single question submits on selecting an option", () => {
	const harness = open([spec()]);
	harness.keys(KEY.down, KEY.enter);
	const result = harness.result();
	assert.ok(result);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0].kind, "option");
	assert.equal(result.answers[0].answer, "Option 2");
});

test("typing a custom answer records kind custom", () => {
	const harness = open([spec()]);
	harness.keys(KEY.down, KEY.down, KEY.enter, "m", "y", " ", "w", "a", "y", KEY.enter);
	const result = harness.result();
	assert.ok(result);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "my way");
});

test("a blank custom answer is never recorded and keeps the dialog open", () => {
	const harness = open([spec()]);
	harness.keys(KEY.down, KEY.down, KEY.enter, KEY.enter);
	assert.equal(harness.result(), undefined);
	assert.match(harness.text(), /Type something\./);
});

test("notes attach to the answer without marking the question answered", () => {
	const harness = open([spec()], {});
	harness.keys("n", "k", "e", "e", "p", KEY.enter);
	assert.match(harness.text(), /Note: keep/);
	harness.keys(KEY.enter);
	const result = harness.result();
	assert.ok(result);
	assert.equal(result.answers[0].answer, "Option 1");
	assert.equal(result.answers[0].notes, "keep");
});

test("escape declines the whole questionnaire", () => {
	const harness = open([spec()]);
	harness.keys(KEY.escape);
	assert.deepEqual(harness.result(), { answers: [], cancelled: true });
});

test("multi-select toggles boxes and commits through Next", () => {
	const multi = spec({ header: "Checks", multiSelect: true }, 3);
	const harness = open([multi]);
	harness.keys(KEY.enter); // toggle Option 1
	harness.keys(KEY.down, KEY.down, KEY.enter); // toggle Option 3
	harness.keys(KEY.down, KEY.down); // Options (3) -> custom -> Next
	harness.keys(KEY.enter); // commit
	const result = harness.result();
	assert.ok(result);
	assert.equal(result.answers[0].kind, "multi");
	assert.deepEqual(result.answers[0].selected, ["Option 1", "Option 3"]);
});

test("space toggles boxes, enter on a box does not submit", () => {
	const multi = spec({ header: "Checks", multiSelect: true }, 2);
	const harness = open([multi]);
	harness.keys(KEY.space);
	assert.equal(harness.result(), undefined);
	assert.match(harness.text(), /\[✔\] 1\. Option 1/);
});

test("two questions arrive as tabs; blanks are reported on submit", () => {
	const first = spec({ header: "Storage" });
	const second = spec({ header: "Tests", question: "Which tests run first?" });
	const harness = open([first, second]);
	assert.match(harness.text(), /Storage/);
	assert.match(harness.text(), /Submit/);

	harness.keys(KEY.enter); // answer question 1 -> advances to question 2
	assert.match(harness.text(), /Which tests run first\?/);
	harness.keys(KEY.tab); // skip ahead to the Submit tab
	assert.match(harness.text(), /Review your answers/);
	assert.match(harness.text(), /left blank/);
	harness.keys(KEY.enter); // submit with a blank
	const result = harness.result();
	assert.ok(result);
	assert.equal(result.answers[0].answer, "Option 1");
	assert.equal(result.answers[1].kind, "none");
	assert.deepEqual(result.unanswered, [1]);
});

test("tab navigation wraps both ways", () => {
	const harness = open([spec({ header: "A" }), spec({ header: "B", question: "Second?" })]);
	harness.keys(KEY.shiftTab); // wraps back from A to Submit
	assert.match(harness.text(), /Review your answers/);
	harness.keys(KEY.tab); // and forward again to A
	assert.match(harness.text(), /storage backend/i);
});

test("the submit picker cancels without answering", () => {
	const harness = open([spec({ header: "A" }), spec({ header: "B", question: "Second?" })]);
	harness.keys(KEY.tab, KEY.tab); // A -> B -> Submit
	harness.keys(KEY.down); // Cancel
	harness.keys(KEY.enter);
	assert.deepEqual(harness.result(), { answers: [], cancelled: true });
});

test("a global note survives a cancel", () => {
	const harness = open([spec({ header: "A" }), spec({ header: "B", question: "Second?" })]);
	harness.keys(KEY.tab, KEY.tab); // A -> B -> Submit
	harness.keys("n", "l", "a", "t", "e", "r", KEY.enter, KEY.escape);
	assert.deepEqual(harness.result(), { answers: [], cancelled: true, globalNote: "later" });
});

test("the preview renders beside the options on a wide terminal", () => {
	const withPreview = spec({}, 2);
	withPreview.options[0].preview = "cache = LruCache()\ncache.get(key)";
	const harness = open([withPreview]);
	const wide = harness.render(120);
	assert.ok(wide.some((line) => line.includes("preview")));
	assert.ok(wide.some((line) => line.includes("LruCache()")));
	// Narrow terminals stack the preview under the options instead.
	const narrow = harness.render(70);
	assert.ok(narrow.some((line) => line.includes("preview")));
});

test("collapse shrinks the dialog to one row and restores the answers", () => {
	const harness = open([spec({ header: "A" }), spec({ header: "B", question: "Second?" })]);
	harness.keys(KEY.enter); // answer question 1
	const before = harness.text();
	harness.keys("\x1d"); // ctrl+]
	const collapsed = harness.render(120);
	assert.equal(collapsed.length, 1);
	assert.match(collapsed[0], /question/);
	harness.keys("\x1d");
	assert.equal(harness.text(120), before);
});

test("collapse can be turned off", () => {
	const harness = open([spec()], { collapseKey: "off" });
	harness.keys("\x1d");
	assert.ok(harness.render(120).length > 1);
});

test("aborting the signal declines the questionnaire", () => {
	const controller = new AbortController();
	const harness = open([spec()], { signal: controller.signal });
	controller.abort();
	assert.deepEqual(harness.result(), { answers: [], cancelled: true });
});

test("every rendered line fits the width", () => {
	const withPreview = spec({ header: "Note" }, 4);
	withPreview.options[0].preview = "x".repeat(300);
	withPreview.options[1].description = "A description long enough to wrap more than once in a narrow pane.";
	const states: Array<[string, QuestionSpec[]]> = [
		["single", [withPreview]],
		["tabbed", [withPreview, spec({ header: "B", multiSelect: true }, 4)]],
	];
	for (const [, questions] of states) {
		for (const width of [16, 24, 40, 80, 99, 100, 140]) {
			const harness = open(questions);
			for (const line of harness.render(width)) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}"`);
			}
			// Note editor, custom editor and the Submit tab all obey the width too.
			harness.keys("n", "x");
			for (const line of harness.render(width)) assert.ok(visibleWidth(line) <= width);
			harness.keys(KEY.escape, KEY.down, KEY.down, KEY.enter, "z");
			for (const line of harness.render(width)) assert.ok(visibleWidth(line) <= width);
		}
	}
});

// --------------------------------------------------------------------- wiring

test("the factory registers one model-facing tool and the demo command", () => {
	const tools: Array<Record<string, unknown>> = [];
	const commands: string[] = [];
	const pi = {
		registerTool: (tool: Record<string, unknown>) => tools.push(tool),
		registerCommand: (name: string) => commands.push(name),
	} as unknown as Parameters<typeof piAsk>[0];

	piAsk(pi);

	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, "ask_user_question");
	assert.equal(tool.executionMode, "sequential", "parallel dialogs would fight over the keyboard");
	assert.ok(typeof tool.description === "string" && tool.description.length > 200);

	// The description has to teach the shape, or the model writes prose questions.
	for (const phrase of ["header", "options", "description", "preview", "multiSelect", CUSTOM_LABEL]) {
		assert.match(String(tool.description), new RegExp(phrase));
	}
	assert.ok(Array.isArray(tool.promptGuidelines) && (tool.promptGuidelines as string[]).length >= 3);
	assert.match(String(tool.promptSnippet), /question/i);
	assert.deepEqual(commands, ["ask"]);

	// The schema must describe what the dialog can render.
	const parameters = tool.parameters as {
		properties: { questions: { minItems: number; maxItems: number; items: { properties: { options: { minItems: number; maxItems: number } } } } };
	};
	const questions = parameters.properties.questions;
	assert.equal(questions.minItems, 1);
	assert.equal(questions.maxItems, 4);
	assert.equal(questions.items.properties.options.minItems, 2);
	assert.equal(questions.items.properties.options.maxItems, 4);
});

test("transcript renderers name the questions and echo the answers", () => {
	const call = renderAskCall(
		{ questions: [{ header: "Storage" }, { header: "Checks", multiSelect: true }] },
		theme,
	) as unknown as { render: (width: number) => string[] };
	const callLine = call.render(120).join("\n");
	assert.match(callLine, /ask_user_question/);
	assert.match(callLine, /2 questions/);
	assert.match(callLine, /Storage, Checks \(multi\)/);

	const result = renderAskResult(
		{
			details: {
				cancelled: false,
				answers: [
					{ questionIndex: 0, question: "Which storage?", header: "Storage", kind: "option", answer: "Redis" },
					{ questionIndex: 1, question: "Which tests?", header: "Tests", kind: "none", answer: null },
				],
			},
		},
		theme,
	) as unknown as { render: (width: number) => string[] };
	const resultText = result.render(120).join("\n");
	assert.match(resultText, /Storage: Redis/);
	assert.match(resultText, /\(left blank\)/);

	const declined = renderAskResult({ details: { answers: [], cancelled: true } }, theme) as unknown as {
		render: (width: number) => string[];
	};
	assert.match(declined.render(120).join("\n"), /declined/);
});

// ---------------------------------------------------------------------- run

let failures = 0;
for (const [name, run] of checks) {
	try {
		run();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures++;
		console.error(`  FAIL ${name}`);
		console.error(String(error instanceof Error ? error.stack ?? error.message : error).replace(/^/gm, "       "));
	}
}
console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
if (failures > 0) process.exitCode = 1;
