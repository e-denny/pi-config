/**
 * pi-prompt-box
 *
 * Draws the prompt input area as a rounded-corner box and folds the footer
 * info (working directory, git branch, model, token usage, context size)
 * into the box's bottom line:
 *
 *   ╭──────────────────────────────────────────────────────╮
 *   │ type your prompt here                                 │
 *   ╰─ ~/D/llm-wiki (main) ── ↑1.2k ↓3.4k 12.3%/200k ── sonnet • thinking high ─╯
 *
 * The bottom line has three sections separated by horizontal (─) runs that
 * stretch to fill the width:
 *   - left:   abbreviated working directory + git branch
 *   - middle: token usage (↑ ↓ R W CH $), context %/window, session name
 *   - right:  model id + thinking level
 *
 * The corner glyphs (╰ ╯) frame the line with a single ─ right after / before
 * them, so the box keeps its rounded bottom corners. The built-in footer
 * below the prompt is hidden because its content now lives in the box.
 *
 * Folder paths are abbreviated to the first letter of every folder except
 * the last one (hidden folders keep their dot):
 *
 *   ~/Documents/llm-wiki/  →  ~/D/llm-wiki
 *   ~/Projects/.config/pi  →  ~/P/.c/pi
 *
 * The default pi editor draws only two horizontal lines (above and below
 * the input). This extension keeps those lines and additionally draws:
 *
 *   - vertical side bars (│) that grow as the prompt wraps onto more lines
 *   - quarter-circle corner glyphs (╭ ╮ ╰ ╯) from the terminal font,
 *     oriented to the top-left / top-right / bottom-left / bottom-right
 *
 * The corner, horizontal and vertical glyphs are taken from
 * ~/.config/pi-prompt-box.json when present (fields are optional):
 *
 *   {
 *     "topLeft": "╭", "topRight": "╮",
 *     "bottomLeft": "╰", "bottomRight": "╯",
 *     "horizontal": "─", "vertical": "│"
 *   }
 *
 * All glyphs must be single-width cells; invalid values fall back to the
 * defaults above. Box drawing glyphs like ╭╮╰╯ are present in the standard
 * box-drawing block of every Nerd Font (and most monospace fonts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CustomEditor,
	type ContextUsage,
	type ExtensionAPI,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

interface PromptBoxConfig {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}

const DEFAULT_CONFIG: PromptBoxConfig = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

const CONFIG_KEYS = [
	"topLeft",
	"topRight",
	"bottomLeft",
	"bottomRight",
	"horizontal",
	"vertical",
] as const;

/** A glyph is usable if it is a single terminal cell with no control chars. */
function isSingleCell(value: string): boolean {
	return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) && visibleWidth(value) === 1;
}

/** Load glyph overrides from ~/.config/pi-prompt-box.json (respects XDG). */
function loadConfig(): PromptBoxConfig {
	const config = { ...DEFAULT_CONFIG };
	const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	try {
		const raw = readFileSync(join(configDir, "pi-prompt-box.json"), "utf8");
		const parsed = JSON.parse(raw) as Partial<Record<(typeof CONFIG_KEYS)[number], unknown>>;
		for (const key of CONFIG_KEYS) {
			const value = parsed[key];
			if (typeof value === "string" && isSingleCell(value)) {
				config[key] = value;
			}
		}
	} catch {
		// No config file (or unreadable): fall back to defaults.
	}
	return config;
}

/** Matches the editor's built-in scroll indicators: `─── ↑ 3 more ────`. */
const SCROLL_INDICATOR = /^─── [↑↓] \d+ more/;

/**
 * The editor renders its top and bottom borders (plain `─` runs or scroll
 * indicators) and, when autocomplete is open, appends rows below the bottom
 * border. The real bottom border always sits below every content line, so
 * scanning from the end finds it first.
 */
function isBorderLine(stripped: string, horizontal: string): boolean {
	if (SCROLL_INDICATOR.test(stripped)) return true;
	if (stripped.length < 2) return false;
	return [...stripped].every((ch) => ch === horizontal || ch === "─");
}

/** Compact token formatting: 1.2k, 34k, 1.5M … */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Short provider names, applied to the provider prefix of model ids. */
const PROVIDER_SHORT: Record<string, string> = {
	deepseek: "ds",
	anthropic: "a",
	openai: "oai",
	google: "g",
	gemini: "gm",
	mistral: "m",
	groq: "gq",
	xai: "x",
	qwen: "q",
	kimi: "k",
	together: "tg",
};

/**
 * Abbreviate a model id by replacing a known provider prefix:
 * `deepseek-v4-flash` → `ds-v4-flash`. Unknown providers keep the id as-is.
 */
function abbreviateModelId(model: ModelLike | undefined): string {
	if (!model) return "no-model";
	const short = PROVIDER_SHORT[model.provider];
	if (!short) return model.id;
	if (model.id.startsWith(`${model.provider}-`) || model.id.startsWith(`${model.provider}/`)) {
		return short + model.id.slice(model.provider.length);
	}
	return model.id;
}

/** Truncate to a max visible width, appending an ellipsis when cut. */
function fitToWidth(text: string, maxWidth: number): string {
	if (maxWidth < 1) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	return truncateToWidth(text, maxWidth, "…");
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

/** Sum token/cost usage across all session entries (mirrors the built-in footer). */
function computeUsage(entries: readonly SessionEntry[]): {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
} {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of entries) {
		let usage: UsageLike | undefined;
		if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			usage = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			usage = entry.usage;
		}
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (latestPromptTokens > 0) {
				latestCacheHitRate = ((usage.cacheRead ?? 0) / latestPromptTokens) * 100;
			}
		}
	}
	return { totals, latestCacheHitRate };
}

/**
 * Abbreviate every path segment except the last to its first character.
 * Hidden folders keep their dot: `.config` → `.c`. Home is `~`.
 *
 *   ~/Documents/llm-wiki/  →  ~/D/llm-wiki
 *   /home/edgar/work/pi    →  /h/e/w/pi
 */
function abbreviatePath(path: string): string {
	if (path === "~" || path === "/" || path === "") return path;
	const parts = path.split(/[\\/]+/);
	while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	if (parts.length === 0) return "/";
	const last = parts.pop()!;
	const abbreviated = parts.map((segment) =>
		segment === "" ? "" : segment.startsWith(".") ? segment.slice(0, 2) : segment.charAt(0),
	);
	return [...abbreviated, last].join("/");
}

/** cwd → `~`-relative form, then abbreviated. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	let display = cwd;
	if (home) {
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const relativeToHome = relative(resolvedHome, resolvedCwd);
		const insideHome =
			relativeToHome === "" ||
			(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
		if (insideHome) {
			display = relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
		}
	}
	return abbreviatePath(display);
}

interface ModelLike {
	id: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
}

/** Live view of the data shown in the box's bottom line. */
interface PromptBoxData {
	cwd(): string;
	branch(): string | null;
	sessionName(): string | undefined;
	model(): ModelLike | undefined;
	thinkingLevel(): string | undefined;
	contextUsage(): ContextUsage | undefined;
	providerCount(): number;
	usage(): { totals: UsageTotals; latestCacheHitRate: number | undefined };
}

/** Run a live getter defensively: a stale ctx (mid session-switch) falls back. */
function safeGet<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

class PromptBoxEditor extends CustomEditor {
	private config: PromptBoxConfig;
	private uiTheme: Theme;
	private data: PromptBoxData;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		config: PromptBoxConfig,
		uiTheme: Theme,
		data: PromptBoxData,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.config = config;
		this.uiTheme = uiTheme;
		this.data = data;
	}

	private dim(text: string): string {
		return this.uiTheme.fg("dim", text);
	}

	/** Left section: abbreviated cwd + git branch. */
	private buildLeft(): string {
		let text = formatCwd(this.data.cwd());
		const branch = this.data.branch();
		if (branch) text += ` (${branch})`;
		return this.dim(text);
	}

	/** Middle section: token usage, context %/window, session name. */
	private buildMiddle(): string {
		const parts: string[] = [];
		const { totals, latestCacheHitRate } = this.data.usage();
		if (totals.input) parts.push(this.dim(`↑${formatTokens(totals.input)}`));
		if (totals.output) parts.push(this.dim(`↓${formatTokens(totals.output)}`));
		if (totals.cacheRead) parts.push(this.dim(`R${formatTokens(totals.cacheRead)}`));
		if (totals.cacheWrite) parts.push(this.dim(`W${formatTokens(totals.cacheWrite)}`));
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			parts.push(this.dim(`CH${latestCacheHitRate.toFixed(1)}%`));
		}
		if (totals.cost > 0) parts.push(this.dim(`$${totals.cost.toFixed(3)}`));

		// Context usage: color it by how full the window is.
		const context = this.data.contextUsage();
		const model = this.data.model();
		const contextWindow = context?.contextWindow ?? model?.contextWindow ?? 0;
		const percent = context?.percent ?? 0;
		const contextDisplay =
			context?.percent === null
				? `?/${formatTokens(contextWindow)}`
				: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
		parts.push(
			percent > 90
				? this.uiTheme.fg("error", contextDisplay)
				: percent > 70
					? this.uiTheme.fg("warning", contextDisplay)
					: this.dim(contextDisplay),
		);

		const name = this.data.sessionName();
		if (name) parts.push(this.dim(`• ${name}`));
		return parts.join(" ");
	}

	/** Right section: model + thinking level (provider prefix when multiple). */
	private buildRight(): string {
		const model = this.data.model();
		let text = abbreviateModelId(model);
		if (model?.reasoning) {
			const level = this.data.thinkingLevel() || "off";
			text = level === "off" ? `${text} thinking off` : `${text} ${level}`;
		}
		if (this.data.providerCount() > 1 && model) {
			text = `(${model.provider}) ${text}`;
		}
		return this.dim(text);
	}

	/**
	 * Build the box's bottom line(s): `╰─ <left> ── <middle> ── <right> ─╯`.
	 *
	 * When the middle (usage/session) cannot fit, it degrades in tiers:
	 *   1. padded three sections (`╰─ L ── M ── R ─╯`)
	 *   2. unpadded three sections (`╰─L────M────R─╯`)
	 *   3. left + right stay on the box line, the middle moves to a separate
	 *      footer line below the box (truncating right, then left, if needed).
	 * Returns the info line plus any footer line to render below the box.
	 */
	private buildBottomLines(
		width: number,
		border: (text: string) => string,
		bottomLeft: string,
		bottomRight: string,
		horizontal: string,
	): { info: string; footer: string } {
		const left = this.buildLeft();
		const middle = this.buildMiddle();
		const right = this.buildRight();

		const w = (text: string) => visibleWidth(text);
		const dash = (count: number) => (count > 0 ? border(horizontal.repeat(count)) : "");
		const frame = (inner: string) =>
			border(bottomLeft + horizontal) + inner + border(horizontal + bottomRight);

		if (middle !== "") {
			// Tier 1: padded three sections — `╰─ L ──── M ──── R ─╯`
			if (w(left) + w(middle) + w(right) + 12 <= width) {
				const dashTotal = width - 10 - w(left) - w(middle) - w(right);
				const d1 = Math.ceil(dashTotal / 2);
				return {
					info: frame(` ${left} ` + dash(d1) + ` ${middle} ` + dash(dashTotal - d1) + ` ${right} `),
					footer: "",
				};
			}
			// Tier 2: unpadded three sections — `╰─L────M────R─╯`
			if (w(left) + w(middle) + w(right) + 6 <= width) {
				const dashTotal = width - 4 - w(left) - w(middle) - w(right);
				const d1 = Math.ceil(dashTotal / 2);
				return {
					info: frame(left + dash(d1) + middle + dash(dashTotal - d1) + right),
					footer: "",
				};
			}
		}

		// Tier 3: usage/session moves to a footer line; the box keeps cwd + model.
		let L = left;
		let R = right;
		let dashTotal = width - 4 - w(L) - w(R);
		if (dashTotal < 1) {
			// Not enough room even unpadded: truncate the right section first,
			// then the left (the cwd is kept whole as long as possible).
			const budget = width - 5;
			L = fitToWidth(left, budget);
			R = fitToWidth(right, Math.max(0, budget - w(L)));
			if (w(R) === 0) {
				L = fitToWidth(left, width - 4);
			}
			dashTotal = Math.max(0, width - 4 - w(L) - w(R));
		}
		return { info: frame(L + dash(dashTotal) + R), footer: middle };
	}

	render(width: number): string[] {
		// Too narrow for a box: fall back to the plain editor.
		if (width < 4) return super.render(width);

		const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = this.config;
		const border = this.borderColor;
		const innerWidth = width - 2;

		// Let the base editor lay out text with 2 columns to spare for the
		// side bars; it already pads every rendered line to innerWidth.
		const lines = super.render(innerWidth);
		if (lines.length < 2) return lines;

		// Locate the bottom border from the end (autocomplete rows follow it).
		let bottomIdx = lines.length - 1;
		while (bottomIdx > 0 && !isBorderLine(stripTerminalSequences(lines[bottomIdx]!), horizontal)) {
			bottomIdx--;
		}
		if (bottomIdx <= 0) bottomIdx = lines.length - 1;

		// Pad a line back to innerWidth (repairs the cursor-overflow case
		// where the base editor emits a line one column short).
		const padToInner = (line: string): string => {
			const gap = innerWidth - visibleWidth(line);
			return gap > 0 ? line + " ".repeat(gap) : line;
		};
		const rail = (line: string): string => border(vertical) + padToInner(line) + border(vertical);

		// ── Top border: corners, or scroll indicator wrapped in corners. ──
		const topStripped = stripTerminalSequences(lines[0]!);
		lines[0] = SCROLL_INDICATOR.test(topStripped)
			? border(topLeft + topStripped + topRight)
			: border(topLeft + horizontal.repeat(width - 2) + topRight);

		// ── Content lines: vertical side bars that grow with the text. ──
		for (let i = 1; i < bottomIdx; i++) {
			lines[i] = rail(lines[i]!);
		}

		// ── Bottom line: the footer info folded into the box. ──
		let infoLine: string;
		let footerLine = "";
		try {
			const bottom = this.buildBottomLines(width, border, bottomLeft, bottomRight, horizontal);
			infoLine = bottom.info;
			footerLine = bottom.footer;
		} catch {
			infoLine = border(bottomLeft + horizontal.repeat(width - 2) + bottomRight);
		}
		lines[bottomIdx] = infoLine;

		// ── Tier-3 footer line (usage/session) below the box. ──
		let railStart = bottomIdx + 1;
		if (footerLine !== "") {
			lines.splice(bottomIdx + 1, 0, fitToWidth(footerLine, width));
			railStart = bottomIdx + 2;
		}

		// ── Autocomplete rows below the box keep the side bars. ──
		for (let i = railStart; i < lines.length; i++) {
			lines[i] = rail(lines[i]!);
		}

		return lines;
	}
}

/** Replaces the built-in footer (its content now lives inside the box). */
const HIDDEN_FOOTER = {
	render: () => [] as string[],
	invalidate: () => {},
	dispose: () => {},
};

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let currentEditor: PromptBoxEditor | undefined;

	// Keep the bottom line fresh when the data behind it changes.
	pi.on("message_end", () => currentEditor?.invalidate());
	pi.on("turn_end", () => currentEditor?.invalidate());
	pi.on("model_select", () => currentEditor?.invalidate());
	pi.on("thinking_level_select", () => currentEditor?.invalidate());
	pi.on("session_info_changed", () => currentEditor?.invalidate());
	pi.on("session_shutdown", () => {
		currentEditor = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		// Grab the footer data provider (git branch, provider count) and hide
		// the built-in footer: everything it rendered now lives in the box.
		let footerData: ReadonlyFooterDataProvider | undefined;
		ctx.ui.setFooter((_tui, _theme, data) => {
			footerData = data;
			return HIDDEN_FOOTER;
		});

		const getFooterData = () => footerData;
		const data: PromptBoxData = {
			cwd: () => safeGet(() => ctx.cwd, ""),
			branch: () => safeGet(() => getFooterData()?.getGitBranch() ?? null, null),
			sessionName: () => safeGet(() => ctx.sessionManager.getSessionName(), undefined),
			model: () =>
				safeGet(() => {
					const m = ctx.model;
					return m
						? {
								id: m.id,
								provider: m.provider,
								reasoning: m.reasoning,
								contextWindow: m.contextWindow,
							}
						: undefined;
				}, undefined),
			thinkingLevel: () => safeGet(() => ctx.thinkingLevel, undefined),
			contextUsage: () => safeGet(() => ctx.getContextUsage(), undefined),
			providerCount: () => safeGet(() => getFooterData()?.getAvailableProviderCount() ?? 1, 1),
			usage: () =>
				safeGet(
					() => computeUsage(ctx.sessionManager.getEntries()),
					{ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, latestCacheHitRate: undefined },
				),
		};

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new PromptBoxEditor(tui, theme, keybindings, config, ctx.ui.theme, data);
			currentEditor = editor;
			footerData?.onBranchChange(() => editor.invalidate());
			return editor;
		});
	});
}
