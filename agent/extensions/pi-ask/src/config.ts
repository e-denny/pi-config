/**
 * pi-ask — optional configuration.
 *
 * One setting is worth a file: the key that collapses the dialog. Everything
 * else about the tool is authored here in the extension. The file is read on
 * every questionnaire, never written, and a broken file falls back to the
 * defaults instead of failing the tool.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AskConfig {
	/** Key id (e.g. "ctrl+]", "alt+o") that collapses the dialog, or "off". */
	collapseKey: string;
}

export const DEFAULT_COLLAPSE_KEY = "ctrl+]";

export function configPath(): string {
	const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(base, "pi-ask", "config.json");
}

export function loadConfig(): AskConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { collapseKey?: unknown };
		const raw = typeof parsed.collapseKey === "string" ? parsed.collapseKey.trim() : "";
		if (raw === "off") return { collapseKey: "off" };
		if (raw && !/\s/.test(raw)) return { collapseKey: raw };
	} catch {
		// Missing, unreadable or malformed: defaults are always usable.
	}
	return { collapseKey: DEFAULT_COLLAPSE_KEY };
}
