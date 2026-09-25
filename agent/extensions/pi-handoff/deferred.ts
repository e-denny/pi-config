/**
 * In-memory capture of user prompts that arrive after GO but before the
 * replacement session exists. They are appended to the dossier so no user
 * turn is lost across the cutover.
 */

export interface DeferredPromptSnapshot {
	handoffId: string;
	sourceSessionPath: string;
	prompts: readonly string[];
}

export class DeferredPromptWindow {
	private readonly values: string[] = [];
	readonly handoffId: string;
	readonly sourceSessionPath: string;

	constructor(handoffId: string, sourceSessionPath: string) {
		this.handoffId = handoffId;
		this.sourceSessionPath = sourceSessionPath;
	}

	capture(text: string): DeferredPromptSnapshot {
		this.values.push(text);
		return this.snapshot;
	}

	get snapshot(): DeferredPromptSnapshot {
		return {
			handoffId: this.handoffId,
			sourceSessionPath: this.sourceSessionPath,
			prompts: [...this.values],
		};
	}
}

export function formatDeferredPrompts(prompts: readonly string[]): string {
	return prompts
		.map((prompt, index) => `--- Deferred Prompt ${index + 1} of ${prompts.length} ---\n${prompt}`)
		.join("\n");
}

export function assembleHandoffMarkdown(dossier: string, prompts: readonly string[]): string {
	if (prompts.length === 0) return dossier;
	return [
		dossier,
		"## Deferred Prompts",
		"Treat the entries below as separate sequential user inputs after this dossier. Later entries may update or supersede earlier entries.",
		formatDeferredPrompts(prompts),
	].join("\n\n");
}
