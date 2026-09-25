import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HandoffConfig {
	/** Seconds before one reminder re-applies the Call Template. 0 disables the reminder. */
	readinessRetrySeconds: number;
	/** Maximum isolated writer attempts before the handoff is abandoned. */
	writerAttempts: number;
	/** Seconds between writer attempts. */
	writerRetryDelaySeconds: number;
	/** Built-in template name, bare filename, or path to the dossier template. */
	handoffTemplate: string;
	/** Built-in template name, bare filename, or path to the Call Template. */
	callTemplate: string;
	/** Extra directory searched first for `<name>.cmpl` overrides. */
	templateDirectory: string | null;
}

export const DEFAULT_HANDOFF_CONFIG: HandoffConfig = {
	readinessRetrySeconds: 180,
	writerAttempts: 2,
	writerRetryDelaySeconds: 2,
	handoffTemplate: "handoff_default",
	callTemplate: "call_default",
	templateDirectory: null,
};

export function agentDirectory(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configFilePath(directory = agentDirectory()): string {
	return join(directory, "pi-handoff.json");
}

export interface LoadedConfig {
	config: HandoffConfig;
	warnings: string[];
}

export async function loadConfig(directory = agentDirectory()): Promise<LoadedConfig> {
	const path = configFilePath(directory);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return { config: { ...DEFAULT_HANDOFF_CONFIG }, warnings: [] };
		return {
			config: { ...DEFAULT_HANDOFF_CONFIG },
			warnings: [`pi-handoff could not read ${path}: ${message(error)}. Using built-in defaults.`],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			config: { ...DEFAULT_HANDOFF_CONFIG },
			warnings: [`pi-handoff ignored invalid JSON in ${path}: ${message(error)}. Using built-in defaults.`],
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			config: { ...DEFAULT_HANDOFF_CONFIG },
			warnings: [`pi-handoff ignored ${path}: the top-level value must be a JSON object.`],
		};
	}

	const source = parsed as Record<string, unknown>;
	const warnings: string[] = [];
	const config: HandoffConfig = {
		readinessRetrySeconds: positiveNumber(
			source.readinessRetrySeconds,
			DEFAULT_HANDOFF_CONFIG.readinessRetrySeconds,
			"readinessRetrySeconds",
			warnings,
			true,
		),
		writerAttempts: positiveNumber(
			source.writerAttempts,
			DEFAULT_HANDOFF_CONFIG.writerAttempts,
			"writerAttempts",
			warnings,
		),
		writerRetryDelaySeconds: positiveNumber(
			source.writerRetryDelaySeconds,
			DEFAULT_HANDOFF_CONFIG.writerRetryDelaySeconds,
			"writerRetryDelaySeconds",
			warnings,
			true,
		),
		handoffTemplate: nonEmptyString(
			source.handoffTemplate,
			DEFAULT_HANDOFF_CONFIG.handoffTemplate,
			"handoffTemplate",
			warnings,
		),
		callTemplate: nonEmptyString(source.callTemplate, DEFAULT_HANDOFF_CONFIG.callTemplate, "callTemplate", warnings),
		templateDirectory:
			source.templateDirectory === undefined || source.templateDirectory === null
				? null
				: nonEmptyString(source.templateDirectory, "", "templateDirectory", warnings) || null,
	};
	return { config, warnings };
}

function positiveNumber(
	value: unknown,
	fallback: number,
	name: string,
	warnings: string[],
	allowZero = false,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value < 1)) {
		warnings.push(`pi-handoff ignored invalid ${name}; using ${fallback}.`);
		return fallback;
	}
	return Math.floor(value);
}

function nonEmptyString(value: unknown, fallback: string, name: string, warnings: string[]): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.trim() === "") {
		warnings.push(`pi-handoff ignored invalid ${name}; using ${fallback}.`);
		return fallback;
	}
	return value.trim();
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
