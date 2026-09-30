/**
 * ctrl-r-pi
 *
 * An fzf-style reverse prompt search for pi. It remembers the last 400 unique
 * prompts submitted to pi and opens them in a searchable popup on Ctrl-R
 * (capital R, i.e. Ctrl-Shift-R).
 *
 * Behavior:
 * - Every user prompt (interactive or RPC, not extension-originated) is stored.
 * - Prompts are de-duplicated: resubmitting one moves it to the top.
 * - History is persisted to <agent dir>/ctrl-r-pi-history.json and survives
 *   across sessions.
 * - Ctrl-R (capital R) opens a popup with a search field and a one-line-per-prompt list.
 * - Typing fuzzy-filters the list (best matches first). Up/Down move the
 *   selection, Enter inserts the highlighted prompt back into the editor,
 *   Escape (or Ctrl-C) cancels.
 *
 * The selected prompt is restored in full (all lines) via ctx.ui.setEditorText.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	type KeybindingsManager,
	CURSOR_MARKER,
	type OverlayOptions,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_HISTORY = 400;
/** Candidates shown at once. The popup never grows past this many list rows. */
const MAX_VISIBLE = 10;
/** List row reserved for the "(n/m)" scroll indicator. */
const SCROLL_INDICATOR_ROWS = 1;
/** Non-candidate rows: top border, title, search field, hint, bottom border. */
const BOX_CHROME_ROWS = 5;
/** How far below the prompt box to look for extra chrome (built-in footer, status). */
const MAX_ROWS_BELOW_EDITOR = 4;
/** Assumed prompt-box height when the editor cannot be measured. */
const FALLBACK_EDITOR_ROWS = 3;
const HISTORY_FILE = "ctrl-r-pi-history.json";

/** Box-drawing glyphs, matching the prompt box's rounded edges and vertical rails. */
const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
} as const;

function historyPath(): string {
	return join(getAgentDir(), HISTORY_FILE);
}

function loadHistory(): string[] {
	try {
		const raw = readFileSync(historyPath(), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const list = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { prompts?: unknown }).prompts)
				? (parsed as { prompts: unknown[] }).prompts
				: [];
		return list
			.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			.slice(0, MAX_HISTORY);
	} catch {
		return [];
	}
}

function saveHistory(prompts: string[]): void {
	try {
		const file = historyPath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ version: 1, prompts }, null, 2)}\n`, "utf-8");
	} catch {
		// History is best-effort; a failed write must never break a submission.
	}
}

function toSingleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function buildItems(prompts: string[]): SelectItem[] {
	return prompts.map((prompt) => ({ value: prompt, label: toSingleLine(prompt) }));
}

/** The prompt box, as far as this extension needs to know it. */
type EditorLike = Component & { borderColor?: (text: string) => string };

/** Where the prompt box sits, measured from the last rendered frame. */
interface PromptBoxGeometry {
	/** Outer width of the prompt box in columns. */
	width: number;
	/** Height of the prompt box in rows. */
	rows: number;
	/** Screen rows between the terminal bottom and the prompt box's top edge. */
	marginBottom: number;
}

/**
 * The prompt box is the focused component while the shortcut runs; the overlay only
 * takes focus once it is shown. `focusedComponent` is private in pi-tui's public types,
 * so read it defensively and fall back to geometry-neutral defaults on failure.
 */
function focusedEditor(tui: TUI): EditorLike | undefined {
	const focused = (tui as unknown as { focusedComponent?: EditorLike }).focusedComponent;
	return typeof focused?.render === "function" ? focused : undefined;
}

/** Line content without styling, cursor markers or trailing padding. */
function plainLine(line: string): string {
	return stripTerminalSequences(line).split(CURSOR_MARKER).join("").trimEnd();
}

/** The frame pi drew last, as reported by the renderer's public render-state capture. */
function readFrameLines(tui: TUI): string[] | undefined {
	const source = tui as unknown as { captureRenderState?: () => { previousLines?: string[] } };
	if (typeof source.captureRenderState !== "function") return undefined;
	try {
		const lines = source.captureRenderState()?.previousLines;
		return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
	} catch {
		return undefined;
	}
}

/** Rows of frame chrome below the prompt box's rendered lines (built-in footer, status). */
function rowsBelowEditor(
	frame: string[],
	frameRows: number,
	editorPlain: string[],
	editorRows: number,
): number {
	for (let below = 0; below <= MAX_ROWS_BELOW_EDITOR; below++) {
		const start = frameRows - below - editorRows;
		if (start < 0) break;
		if (editorPlain.every((line, i) => plainLine(frame[start + i] ?? "") === line)) return below;
	}
	return 0;
}

/**
 * Measure the prompt box so the popup can sit directly on top of it.
 *
 * Overlay positions are relative to the visible viewport, but pi's frame is anchored to
 * the top of the frame buffer: in a session with little transcript the prompt box sits
 * well above the bottom of the terminal, and anchoring to the screen bottom would leave
 * the popup in the empty rows below it. So locate the box in the last rendered frame,
 * then convert that row into a distance from the screen bottom. Falls back to "the box is
 * at the bottom" when the render state is unavailable.
 */
function measurePromptBox(tui: TUI, editor: EditorLike | undefined): PromptBoxGeometry {
	// `terminal` is always present in interactive mode; guard anyway so headless callers
	// (tests, other UI modes) get sane geometry instead of an exception.
	const terminal = tui.terminal as { columns?: number; rows?: number } | undefined;
	const termWidth = Math.max(20, terminal?.columns ?? 80);
	const termHeight = Math.max(5, terminal?.rows ?? 24);

	let lines: string[] | undefined;
	try {
		lines = editor?.render(termWidth);
	} catch {
		lines = undefined;
	}

	const rows = lines && lines.length > 0 ? lines.length : FALLBACK_EDITOR_ROWS;
	const measuredWidth = lines?.[0] ? visibleWidth(lines[0]) : 0;
	const width = Math.max(20, Math.min(termWidth, measuredWidth || termWidth));

	const frame = readFrameLines(tui);
	if (!frame) return { width, rows, marginBottom: rows };

	// The frame can carry blank padding rows from a previous overlay render.
	let frameRows = frame.length;
	while (frameRows > 0 && plainLine(frame[frameRows - 1] ?? "") === "") frameRows--;
	if (frameRows < rows) return { width, rows, marginBottom: rows };

	const editorPlain = (lines ?? []).map(plainLine);
	const below = rowsBelowEditor(frame, frameRows, editorPlain, rows);
	const editorTop = Math.max(0, frameRows - below - rows);
	// The visible viewport is the last `termHeight` frame rows.
	const viewportTop = Math.max(0, frameRows - termHeight);
	return { width, rows, marginBottom: Math.max(1, termHeight - editorTop + viewportTop) };
}

/**
 * Draws its children inside the same rounded-corner, vertical-edge frame as the prompt
 * box, so the popup reads as an extension of the input box.
 */
class RoundedBox extends Container {
	private readonly border: (text: string) => string;

	constructor(border: (text: string) => string) {
		super();
		this.border = border;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const rail = this.border(BOX.vertical);
		const lines = [this.border(BOX.topLeft + BOX.horizontal.repeat(inner) + BOX.topRight)];
		for (const child of this.children) {
			for (const raw of child.render(inner)) {
				const line = visibleWidth(raw) > inner ? truncateToWidth(raw, inner, "…") : raw;
				lines.push(rail + line + " ".repeat(Math.max(0, inner - visibleWidth(line))) + rail);
			}
		}
		lines.push(this.border(BOX.bottomLeft + BOX.horizontal.repeat(inner) + BOX.bottomRight));
		return lines;
	}
}

class PromptHistoryOverlay extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly prompts: string[];
	private readonly done: (value: string | null) => void;
	private readonly search: Input;
	private readonly listSlot: Container;
	private readonly listTheme: SelectListTheme;
	private readonly maxVisible: number;
	private list: SelectList;
	private finished = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		prompts: string[],
		done: (value: string | null) => void,
		maxVisible: number,
		border?: (text: string) => string,
	) {
		super();
		this.tui = tui;
		this.keybindings = keybindings;
		this.prompts = prompts;
		this.done = done;
		this.maxVisible = Math.max(1, Math.floor(maxVisible));
		this.listTheme = {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("muted", text),
			noMatch: () => theme.fg("dim", "  No matching prompts"),
		};

		this.search = new Input({
			// Leading space aligns the search field with the padded title and hint.
			prompt: theme.fg("accent", " ❯ "),
			placeholder: "fuzzy search prompt history…",
			placeholderStyle: (text) => theme.fg("dim", text),
		});

		this.list = this.createList(buildItems(prompts));
		this.listSlot = new Container();
		this.listSlot.addChild(this.list);

		// Same frame as the prompt box, in the prompt box's own border colour when the
		// editor exposes one, so the two boxes line up as a single unit.
		const box = new RoundedBox(border ?? ((text) => theme.fg("accent", text)));
		box.addChild(
			new Text(`${theme.fg("accent", theme.bold("Prompt history"))} ${theme.fg("dim", "(Ctrl-R)")}`, 1, 0),
		);
		box.addChild(this.search);
		box.addChild(this.listSlot);
		box.addChild(
			new Text(theme.fg("dim", "type to filter • ↑/↓ select • enter insert • esc cancel"), 1, 0),
		);
		this.addChild(box);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	handleInput(data: string): void {
		const kb = this.keybindings;

		if (kb.matches(data, "tui.select.cancel")) {
			this.finish(null);
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.list.getSelectedItem();
			if (selected) this.finish(selected.value);
			return;
		}

		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.list.handleInput(data);
			this.tui.requestRender();
			return;
		}

		this.search.handleInput(data);
		this.refilter();
	}

	private createList(items: SelectItem[]): SelectList {
		const list = new SelectList(items, this.maxVisible, this.listTheme, {
			truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
		});
		list.onSelect = (item) => this.finish(item.value);
		list.onCancel = () => this.finish(null);
		return list;
	}

	private refilter(): void {
		const query = this.search.getValue().trim();
		const items = buildItems(this.prompts);
		const matched = query ? fuzzyFilter(items, query, (item) => item.value) : items;
		this.listSlot.clear();
		this.list = this.createList(matched);
		this.listSlot.addChild(this.list);
		this.tui.requestRender();
	}

	private finish(value: string | null): void {
		if (this.finished) return;
		this.finished = true;
		this.done(value);
	}
}

async function showPromptHistory(
	ctx: ExtensionContext,
	prompts: string[],
	onTui?: (tui: TUI) => void,
): Promise<string | null> {
	// The factory below runs before `overlayOptions` is resolved, so measuring the prompt
	// box there gives us both the popup layout and the frame colour it should match.
	let options: OverlayOptions | undefined;

	return ctx.ui.custom<string | null>(
		(tui, theme, keybindings, done) => {
			// The prompt box is still focused here: the shortcut is handled by the editor
			// and the overlay only takes focus once this component exists.
			const editor = focusedEditor(tui);
			const box = measurePromptBox(tui, editor);
			// Rows available above the prompt box, which bound the popup's height.
			const terminal = tui.terminal as { rows?: number } | undefined;
			const spaceAbove = Math.max(1, (terminal?.rows ?? 24) - box.marginBottom);
			const maxListRows = Math.max(
				1,
				Math.min(MAX_VISIBLE, spaceAbove - BOX_CHROME_ROWS - SCROLL_INDICATOR_ROWS),
			);
			options = {
				anchor: "bottom-left",
				width: box.width,
				maxHeight: spaceAbove,
				margin: { bottom: box.marginBottom },
			};
			onTui?.(tui);
			return new PromptHistoryOverlay(
				tui,
				theme,
				keybindings,
				prompts,
				done,
				maxListRows,
				editor?.borderColor,
			);
		},
		{
			overlay: true,
			overlayOptions: () => options ?? { anchor: "bottom-left", width: "100%" },
		},
	);
}

export default function ctrlRPiExtension(pi: ExtensionAPI) {
	let history: string[] = [];

	function rememberPrompt(text: string): void {
		const prompt = text.trim();
		if (!prompt) return;
		// Slash commands are commands, not prompts; they cannot be re-inserted as one.
		if (prompt.startsWith("/")) return;

		const existing = history.indexOf(prompt);
		if (existing !== -1) history.splice(existing, 1);
		history.unshift(prompt);
		if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

		saveHistory(history);
	}

	pi.on("session_start", () => {
		history = loadHistory();
	});

	pi.on("input", (event) => {
		// Prompts sent by extensions are not user history.
		if (event.source === "extension") return;
		rememberPrompt(event.text);
	});

	pi.registerShortcut(Key.ctrlShift("r"), {
		description: "Search and restore a previous prompt",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Prompt history search requires interactive mode", "warning");
				return;
			}
			if (history.length === 0) {
				ctx.ui.notify("No prompt history yet", "info");
				return;
			}

			let tui: TUI | undefined;
			const selected = await showPromptHistory(ctx, history, (t) => {
				tui = t;
			});
			if (typeof selected === "string" && selected.length > 0) {
				ctx.ui.setEditorText(selected);
				// `setEditorText()` writes the text without requesting a redraw, and the
				// frame that removes the overlay is already queued ahead of this
				// continuation (overlay close uses process.nextTick, which drains before
				// promise continuations). Without this render the restored prompt stays
				// invisible until the next keystroke. Mirrors what the editor's own
				// programmatic mutations do (`this.tui.requestRender()`).
				tui?.requestRender();
			}
		},
	});
}
