/**
 * pi-ask — small rendering helpers shared by the dialog.
 *
 * Every function here measures terminal columns with pi-tui's helpers, so
 * wide characters, emoji and embedded ANSI styling keep the dialog's frame
 * aligned.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Collapse whitespace so a multiline draft fits on one preview row. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Wrap `text` at `width`, including the visible columns taken by `prefix`,
 * and repeat that prefix's width as indentation on continuation lines.
 */
export function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) return wrapTextWithAnsi(prefix + text, Math.max(1, width));
	const continuation = " ".repeat(prefixWidth);
	return wrapTextWithAnsi(text, Math.max(1, width - prefixWidth)).map(
		(line, index) => `${index === 0 ? prefix : continuation}${line}`,
	);
}

function padTo(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "…", false);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function clampStart(focus: number, span: number, length: number): number {
	return Math.max(0, Math.min(focus - Math.floor(span / 2), length - span));
}

/**
 * Cut `lines` down to `height` around `focus`, spending rows on an overflow
 * marker only when something is actually hidden. Returns at most `height`
 * lines, so the caller can budget the dialog frame exactly.
 */
export function windowedLines(lines: string[], focus: number, height: number, theme: Theme): string[] {
	if (height <= 0) return [];
	if (lines.length <= height) return lines;

	let span = height;
	for (let pass = 0; pass < 3; pass++) {
		const start = clampStart(focus, span, lines.length);
		const markers = (start > 0 ? 1 : 0) + (start + span < lines.length ? 1 : 0);
		const next = Math.max(1, height - markers);
		if (next === span) break;
		span = next;
	}

	const start = clampStart(focus, span, lines.length);
	const out: string[] = [];
	if (start > 0) out.push(theme.fg("dim", ` ↑ ${start} more above`));
	out.push(...lines.slice(start, start + span));
	const below = lines.length - (start + span);
	if (below > 0) out.push(theme.fg("dim", ` ↓ ${below} more below`));
	return out.slice(0, height);
}

/** A single-ruled box with an optional title in the top edge. */
export function borderBox(title: string | undefined, content: string[], width: number, theme: Theme): string[] {
	const outer = Math.max(4, width);
	const inner = outer - 2;
	const cap = title ? truncateToWidth(` ${title} `, inner, "…", false) : "";
	const head = `${theme.fg("accent", "┌")}${theme.fg("dim", cap)}${theme.fg("accent", "─".repeat(Math.max(0, inner - visibleWidth(cap))))}${theme.fg("accent", "┐")}`;
	const body = content.map(
		(line) => `${theme.fg("accent", "│")}${padTo(line, inner)}${theme.fg("accent", "│")}`,
	);
	const foot = theme.fg("accent", `└${"─".repeat(inner)}┘`);
	return [head, ...body, foot];
}

/** Zip a left and a right column into full-width rows. */
export function columns(left: string[], right: string[], leftWidth: number, gutter: number, width: number): string[] {
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	const gap = " ".repeat(Math.max(0, gutter));
	for (let index = 0; index < rows; index++) {
		const l = padTo(left[index] ?? "", leftWidth);
		const row = `${l}${gap}${right[index] ?? ""}`;
		out.push(truncateToWidth(row, width, "…", true));
	}
	return out;
}
