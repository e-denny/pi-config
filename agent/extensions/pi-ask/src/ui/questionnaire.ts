/**
 * pi-ask — the questionnaire dialog.
 *
 * One component, one interaction. It renders in pi's editor area beneath the
 * transcript and owns the keyboard until the user submits or declines.
 *
 * Layout
 *   ─ rule ─
 *   tab strip (multi-question only):  ✔ Storage  □ Scope  □ Tests  Submit
 *   header + question + saved note
 *   option list — left column, with the focused option's preview beside it
 *   row the dialog appends: "Type something." (every question), "Next" (multi-select)
 *   Submit tab: review list, then a Submit answers / Cancel picker
 *   ─ rule ─
 *
 * Keys are the ones pi already uses for selecting: ↑/↓ move, Enter confirms,
 * Space toggles a checkbox, Tab walks tabs, Esc declines. `n` attaches a note.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	type KeybindingsManager,
	type KeyId,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { CUSTOM_LABEL, NEXT_LABEL, type AnswerRecord, composeAnswer, type QuestionSpec, type QuestionnaireDetails } from "../spec.ts";
import { borderBox, columns, oneLine, windowedLines, wrapWithPrefix } from "./layout.ts";

type Row = { kind: "option"; index: number } | { kind: "custom" } | { kind: "next" };
type Mode = "list" | "custom" | "note" | "globalNote";

interface QuestionState {
	cursor: number;
	/** Chosen option indexes. Single-select keeps at most one. */
	checked: Set<number>;
	/** Text typed into the "Type something." row. */
	custom: string;
	/** True once typed text — not an option — is the single-select answer. */
	customCommitted: boolean;
	/** Note attached to this answer. */
	note: string;
}

export interface QuestionnaireOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	questions: QuestionSpec[];
	/** Key id that collapses the dialog, or "off". */
	collapseKey: string;
	/** Aborts the dialog when the tool call is cancelled. */
	signal?: AbortSignal;
	done: (result: QuestionnaireDetails) => void;
}

/** True when the question has an answer: a label, typed text, or both. */
function stateAnswered(question: QuestionSpec, state: QuestionState): boolean {
	if (question.multiSelect) return state.checked.size > 0 || state.custom.trim().length > 0;
	if (state.customCommitted && state.custom.trim()) return true;
	return state.checked.size > 0;
}

function buildAnswer(question: QuestionSpec, index: number, state: QuestionState): AnswerRecord {
	return composeAnswer(question, index, {
		checked: state.checked,
		custom: state.custom,
		customCommitted: state.customCommitted,
		note: state.note,
	});
}

export function createQuestionnaire(options: QuestionnaireOptions): Component & Focusable {
	const { tui, theme, keybindings, questions, collapseKey, done } = options;

	const count = questions.length;
	const submitTab = count;
	/** Multi-question dialogs get a tab strip and a Submit tab; one question submits on answer. */
	const tabbed = count > 1;
	const totalTabs = tabbed ? count + 1 : count;
	const canCollapse = collapseKey !== "off";

	const states: QuestionState[] = questions.map(() => ({
		cursor: 0,
		checked: new Set<number>(),
		custom: "",
		customCommitted: false,
		note: "",
	}));

	let tab = 0;
	let mode: Mode = "list";
	let submitCursor = 0;
	let globalNote = "";
	let collapsed = false;
	let focused = false;
	let settled = false;
	let cached: { width: number; lines: string[] } | undefined;

	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
	const editor = new Editor(tui, editorTheme);

	editor.onChange = (text) => {
		if (mode === "custom") states[tab].custom = text;
		else if (mode === "note") states[tab].note = text;
		else if (mode === "globalNote") globalNote = text;
	};
	editor.onSubmit = (text) => commitInput(text);

	function refresh(): void {
		cached = undefined;
		tui.requestRender();
	}

	function syncEditorFocus(): void {
		editor.focused = focused && mode !== "list";
	}

	function isSubmitTab(): boolean {
		return tabbed && tab === submitTab;
	}

	function leaveInput(): void {
		mode = "list";
		syncEditorFocus();
		refresh();
	}

	function openInput(next: Mode, initial: string): void {
		mode = next;
		editor.setText(initial);
		syncEditorFocus();
		refresh();
	}

	function rowsFor(question: QuestionSpec): Row[] {
		const rows: Row[] = question.options.map((_, index) => ({ kind: "option" as const, index }));
		rows.push({ kind: "custom" });
		if (question.multiSelect) rows.push({ kind: "next" });
		return rows;
	}

	function switchTab(delta: number): void {
		if (!tabbed) return;
		tab = ((tab + delta) % totalTabs + totalTabs) % totalTabs;
		mode = "list";
		submitCursor = 0;
		syncEditorFocus();
		refresh();
	}

	function advance(): void {
		if (!tabbed) {
			finish(false);
			return;
		}
		if (tab < count - 1) tab++;
		else {
			tab = submitTab;
			submitCursor = 0;
		}
		mode = "list";
		syncEditorFocus();
		refresh();
	}

	function finish(cancelled: boolean): void {
		// Abort, Escape and the Submit tab can all converge here; only the first wins.
		if (settled) return;
		settled = true;
		editor.focused = false;
		if (cancelled) {
			const note = globalNote.trim();
			done({ answers: [], cancelled: true, ...(note ? { globalNote: note } : {}) });
			return;
		}
		const answers = questions.map((question, index) => buildAnswer(question, index, states[index]));
		const unanswered = answers
			.map((answer, index) => (answer.kind === "none" ? index : -1))
			.filter((index) => index >= 0);
		const note = globalNote.trim();
		done({
			answers,
			cancelled: false,
			...(unanswered.length > 0 ? { unanswered } : {}),
			...(note ? { globalNote: note } : {}),
		});
	}

	function commitInput(value: string): void {
		if (mode === "custom") {
			const question = questions[tab];
			const state = states[tab];
			state.custom = value;
			const text = value.trim();
			if (question.multiSelect) {
				// Checked boxes and typed text submit together.
				leaveInput();
				advance();
				return;
			}
			if (!text) {
				// A blank custom answer is never recorded; stay put and let the user retry.
				state.custom = "";
				leaveInput();
				return;
			}
			state.customCommitted = true;
			leaveInput();
			advance();
			return;
		}
		if (mode === "note") {
			states[tab].note = value;
			leaveInput();
			return;
		}
		if (mode === "globalNote") {
			globalNote = value;
			leaveInput();
		}
	}

	function toggleOption(index: number): void {
		const state = states[tab];
		const question = questions[tab];
		if (question.multiSelect) {
			if (state.checked.has(index)) state.checked.delete(index);
			else state.checked.add(index);
			return;
		}
		state.checked = new Set([index]);
		state.customCommitted = false;
	}

	function activateRow(row: Row): void {
		const question = questions[tab];
		const state = states[tab];
		if (row.kind === "option") {
			if (question.multiSelect) {
				toggleOption(row.index);
				refresh();
				return;
			}
			toggleOption(row.index);
			advance();
			return;
		}
		if (row.kind === "custom") {
			openInput("custom", state.custom);
			return;
		}
		// "Next": commit the toggles and whatever text was typed.
		advance();
	}

	function isUp(data: string): boolean {
		return matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up");
	}
	function isDown(data: string): boolean {
		return matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down");
	}
	function isConfirm(data: string): boolean {
		return matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm");
	}
	function isCancel(data: string): boolean {
		return matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel");
	}
	function isNextTab(data: string): boolean {
		return matchesKey(data, Key.tab) || matchesKey(data, Key.right) || keybindings.matches(data, "tui.input.tab");
	}
	function isPrevTab(data: string): boolean {
		return matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
	}
	function isCollapse(data: string): boolean {
		return canCollapse && matchesKey(data, collapseKey as KeyId);
	}

	function handleListKey(data: string): void {
		if (isSubmitTab()) {
			if (isUp(data)) {
				submitCursor = (submitCursor - 1 + 2) % 2;
				refresh();
				return;
			}
			if (isDown(data)) {
				submitCursor = (submitCursor + 1) % 2;
				refresh();
				return;
			}
			if (isConfirm(data)) {
				if (submitCursor === 0) finish(false);
				else finish(true);
				return;
			}
			if (matchesKey(data, "n")) {
				openInput("globalNote", globalNote);
				return;
			}
			if (tabbed && isNextTab(data)) switchTab(1);
			else if (tabbed && isPrevTab(data)) switchTab(-1);
			else if (isCancel(data)) finish(true);
			return;
		}

		if (tabbed && isNextTab(data)) {
			switchTab(1);
			return;
		}
		if (tabbed && isPrevTab(data)) {
			switchTab(-1);
			return;
		}

		const question = questions[tab];
		const state = states[tab];
		const rows = rowsFor(question);

		if (isUp(data)) {
			state.cursor = (state.cursor - 1 + rows.length) % rows.length;
			refresh();
			return;
		}
		if (isDown(data)) {
			state.cursor = (state.cursor + 1) % rows.length;
			refresh();
			return;
		}
		if (matchesKey(data, "n")) {
			openInput("note", state.note);
			return;
		}
		if (matchesKey(data, Key.space)) {
			const row = rows[state.cursor];
			if (!row) return;
			if (row.kind === "option" && question.multiSelect) {
				toggleOption(row.index);
				refresh();
			} else if (row.kind === "custom") {
				openInput("custom", state.custom);
			}
			return;
		}
		if (isConfirm(data)) {
			const row = rows[state.cursor];
			if (row) activateRow(row);
			return;
		}
		if (isCancel(data)) finish(true);
	}

	function handleInput(data: string): void {
		if (collapsed) {
			if (isCollapse(data)) {
				collapsed = false;
				refresh();
				return;
			}
			// Nothing else reaches a collapsed dialog: no invisible state changes.
			if (isCancel(data)) finish(true);
			return;
		}
		if (isCollapse(data)) {
			collapsed = true;
			editor.focused = false;
			refresh();
			return;
		}
		if (mode !== "list") {
			if (isCancel(data) && !isConfirm(data)) {
				leaveInput();
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}
		handleListKey(data);
	}

	// ---------------------------------------------------------------- render

	function rows(): number {
		const rowsAvailable = tui.terminal?.rows ?? 0;
		if (!rowsAvailable) return 24;
		return Math.max(10, Math.min(Math.floor(rowsAvailable * 0.7), rowsAvailable - 3));
	}

	function renderTabBar(width: number): string[] {
		const chips: string[] = [];
		for (let index = 0; index < count; index++) {
			const active = index === tab;
			const answered = stateAnswered(questions[index], states[index]);
			const chip = ` ${answered ? "✔" : "□"} ${questions[index].header} `;
			chips.push(active ? theme.bg("selectedBg", theme.fg("text", chip)) : theme.fg(answered ? "success" : "muted", chip));
		}
		const submitChip = " Submit ";
		chips.push(
			isSubmitTab() ? theme.bg("selectedBg", theme.fg("text", submitChip)) : theme.fg("dim", submitChip),
		);
		return wrapWithPrefix(" ", chips.join(" "), width);
	}

	function renderHeader(width: number): string[] {
		const lines: string[] = [];
		if (isSubmitTab()) {
			lines.push(...wrapWithPrefix(" ", theme.fg("accent", theme.bold("Review your answers")), width));
			return lines;
		}
		const question = questions[tab];
		const counter = tabbed ? theme.fg("dim", `  ${tab + 1}/${count}`) : "";
		lines.push(...wrapWithPrefix(" ", `${theme.fg("accent", theme.bold(question.header))}${counter}`, width));
		lines.push(...wrapWithPrefix(" ", theme.fg("text", question.question), width));
		const note = states[tab].note.trim();
		if (note) lines.push(...wrapWithPrefix(" ", theme.fg("dim", `Note: ${oneLine(note)}`), width));
		lines.push("");
		return lines;
	}

	function renderOptionLines(width: number, showFocus: boolean): { lines: string[]; focusLine: number } {
		const question = questions[tab];
		const state = states[tab];
		const lines: string[] = [];
		let focusLine = 0;

		rowsFor(question).forEach((row, rowIndex) => {
			const active = showFocus && rowIndex === state.cursor;
			if (active) focusLine = lines.length;
			const pointer = active ? theme.fg("accent", "❯ ") : "  ";

			if (row.kind === "option") {
				const option = question.options[row.index];
				const checked = state.checked.has(row.index);
				const marker = question.multiSelect
					? checked
						? theme.fg("success", "[✔] ")
						: theme.fg("dim", "[  ] ")
					: checked
						? theme.fg("success", "✔ ")
						: "  ";
				const label = `${row.index + 1}. ${option.label}`;
				lines.push(
					...wrapWithPrefix(pointer + marker, active ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label), width),
				);
				if (option.preview) {
					const hint = active ? theme.fg("dim", "  ▸ preview") : "";
					if (hint) lines.push(...wrapWithPrefix(" ".repeat(visibleWidth(pointer + marker) + 3), hint, width));
				}
				if (option.description) {
					const indent = " ".repeat(visibleWidth(pointer + marker) + 3);
					lines.push(...wrapWithPrefix(indent, theme.fg("muted", option.description), width));
				}
				return;
			}

			if (row.kind === "custom") {
				const draft = state.custom.trim();
				const label = draft ? `${CUSTOM_LABEL} ${oneLine(draft)}` : CUSTOM_LABEL;
				lines.push(
					...wrapWithPrefix(pointer, active ? theme.fg("accent", theme.bold(label)) : theme.fg(draft ? "text" : "dim", label), width),
				);
				return;
			}

			const label = question.multiSelect ? `${NEXT_LABEL}  (commit this answer)` : NEXT_LABEL;
			lines.push(...wrapWithPrefix(pointer, active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label), width));
		});

		return { lines, focusLine };
	}

	function previewOfFocusedOption(): string | undefined {
		if (isSubmitTab()) return undefined;
		const question = questions[tab];
		const state = states[tab];
		const row = rowsFor(question)[state.cursor];
		if (!row || row.kind !== "option") return undefined;
		return question.options[row.index]?.preview;
	}

	function renderQuestionBody(width: number, height: number): string[] {
		const { lines: optionLines, focusLine } = renderOptionLines(width, true);
		const preview = previewOfFocusedOption();

		if (preview && width >= 100) {
			const leftWidth = Math.min(56, Math.max(32, Math.floor(width * 0.52)));
			const gutter = 2;
			const rightWidth = width - leftWidth - gutter;
			const left = windowedLines(optionLines, focusLine, Math.max(4, height), theme);
			const previewLines = borderBox("preview", wrapTextWithAnsi(preview, Math.max(8, rightWidth - 4)), rightWidth, theme);
			const right = previewLines.length > height ? previewLines.slice(0, Math.max(4, height)) : previewLines;
			return columns(left, right, leftWidth, gutter, width);
		}

		if (preview) {
			const previewLines = borderBox("preview", wrapTextWithAnsi(preview, Math.max(8, width - 4)).slice(0, 8), width, theme);
			const listHeight = Math.max(3, height - previewLines.length - 1);
			return [...windowedLines(optionLines, focusLine, listHeight, theme), "", ...previewLines].slice(0, Math.max(3, height));
		}

		return windowedLines(optionLines, focusLine, Math.max(3, height), theme);
	}

	function renderInputBody(width: number, height: number): string[] {
		const out: string[] = [];
		const label =
			mode === "custom"
				? "Your answer:"
				: mode === "note"
					? "Note for this answer:"
					: "Note for the whole questionnaire:";
		const question = questions[tab];

		if (mode === "custom" && height >= 12) {
			const { lines } = renderOptionLines(width, false);
			out.push(...lines.slice(0, Math.max(2, height - 9)));
			out.push("");
		} else if (mode === "note" && !isSubmitTab()) {
			out.push(...wrapWithPrefix(" ", theme.fg("dim", question.question), width));
			out.push("");
		}

		out.push(...wrapWithPrefix(" ", theme.fg("muted", label), width));
		for (const line of editor.render(Math.max(1, width - 2))) out.push(` ${line}`);
		if (out.length > height) return out.slice(out.length - height);
		return out;
	}

	function renderSubmitBody(width: number, height: number): string[] {
		const out: string[] = [];
		questions.forEach((question, index) => {
			const answer = buildAnswer(question, index, states[index]);
			const done = answer.kind !== "none";
			const mark = done ? theme.fg("success", "✔") : theme.fg("warning", "○");
			const value = done
				? theme.fg("text", oneLine(answer.answer ?? ""))
				: theme.fg("warning", "(left blank)");
			const note = answer.notes ? theme.fg("dim", "  + note") : "";
			out.push(...wrapWithPrefix(` ${mark} `, `${theme.fg("muted", `${question.header}: `)}${value}${note}`, width));
		});
		if (globalNote.trim()) {
			out.push(...wrapWithPrefix("   ", theme.fg("dim", `global note: ${oneLine(globalNote)}`), width));
		}
		out.push("");
		[
			{ label: "Submit answers", hint: "" },
			{ label: "Cancel", hint: "  decline without answering" },
		].forEach((item, index) => {
			const active = index === submitCursor;
			const text = `${item.label}${active ? "" : item.hint}`;
			out.push(
				...wrapWithPrefix(active ? theme.fg("accent", "❯ ") : "  ", active ? theme.fg("accent", theme.bold(text)) : theme.fg("text", text), width),
			);
		});

		const blank = questions.filter((question, index) => buildAnswer(question, index, states[index]).kind === "none");
		out.push("");
		if (blank.length > 0) {
			out.push(
				...wrapWithPrefix(
					" ",
					theme.fg(
						"warning",
						`${blank.length} left blank: ${blank.map((question) => question.header).join(", ")}. Enter still submits; blank answers are reported as blank.`,
					),
					width,
				),
			);
		} else {
			out.push(...wrapWithPrefix(" ", theme.fg("success", "Every question has an answer."), width));
		}
		return out.slice(0, Math.max(3, height));
	}

	function hints(): string {
		if (mode === "custom") return "Enter commit · Shift+Enter newline · Esc back";
		if (mode === "note" || mode === "globalNote") return "Enter save note · Shift+Enter newline · Esc back";
		if (isSubmitTab()) return "↑↓ choose · Enter confirm · n global note · Esc cancel";
		const question = questions[tab];
		if (question.multiSelect) {
			return `↑↓ move · Enter/Space toggle · ${NEXT_LABEL} to commit · n note · Esc cancel`;
		}
		return `${tabbed ? "↑↓ move · Enter select · n note · Tab next question · Esc cancel" : "↑↓ move · Enter select · n note · Esc cancel"}`;
	}

	function render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (cached && cached.width === renderWidth) return cached.lines;

		if (collapsed) {
			const hint = `ask_user_question — ${count} question${count === 1 ? "" : "s"} waiting · ${collapseKey} to expand · Esc to cancel`;
			cached = { width: renderWidth, lines: wrapWithPrefix(" ", theme.fg("dim", hint), renderWidth) };
			return cached.lines;
		}

		const head: string[] = [theme.fg("accent", "─".repeat(renderWidth))];
		if (tabbed) {
			head.push(...renderTabBar(renderWidth));
			head.push("");
		}
		head.push(...renderHeader(renderWidth));

		const foot: string[] = ["", ...wrapWithPrefix(" ", theme.fg("dim", hints()), renderWidth), theme.fg("accent", "─".repeat(renderWidth))];

		const budget = rows();
		const bodyHeight = Math.max(3, budget - head.length - foot.length);
		const body =
			mode !== "list" ? renderInputBody(renderWidth, bodyHeight) : isSubmitTab() ? renderSubmitBody(renderWidth, bodyHeight) : renderQuestionBody(renderWidth, bodyHeight);

		const lines = [...head, ...body, ...foot];
		cached = { width: renderWidth, lines };
		return lines;
	}

	const component: Component & Focusable = {
		get focused(): boolean {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			syncEditorFocus();
		},
		render,
		invalidate(): void {
			cached = undefined;
			editor.invalidate();
		},
		handleInput,
	};

	if (options.signal) {
		if (options.signal.aborted) finish(true);
		else options.signal.addEventListener("abort", () => finish(true), { once: true });
	}

	return component;
}
