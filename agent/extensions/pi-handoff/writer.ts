import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { HandoffSnapshot } from "./flow.ts";
import { SUBMIT_HANDOFF_TOOL, validateSubmission, type HandoffSubmission } from "./tools.ts";
import type { ResolvedTemplate } from "./templates.ts";

export type WriterPhase =
	| "inactive"
	| "resolving"
	| "writing"
	| "retry-delay"
	| "succeeded"
	| "cancelled"
	| "exhausted"
	| "failed";

export type WriterTerminalReason = "succeeded" | "cancelled" | "exhausted" | "failed";

export interface WriterRuntime {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	sendUserMessage(content: string): void;
}

export interface WriterSuccess {
	handoff: HandoffSnapshot;
	attempt: number;
	submission: HandoffSubmission;
	/** True when the dossier was recovered from the final assistant message. */
	recovered: boolean;
}

export interface HandoffWriterOptions {
	writerAttempts: number;
	writerRetryDelaySeconds: number;
	runtime: WriterRuntime;
	resolveTemplate(): Promise<ResolvedTemplate>;
	onPhaseChange?(phase: WriterPhase, attempt: number, ctx: ExtensionContext): void;
	onTemplateWarning?(warning: string, ctx: ExtensionContext): void;
	onSuccess?(result: WriterSuccess, ctx: ExtensionContext): void;
	onTerminalFailure?(reason: Exclude<WriterTerminalReason, "succeeded">, message: string, ctx: ExtensionContext): void;
	createSubmissionId?: () => string;
	setTimer?: (callback: () => void, delayMilliseconds: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

interface ActiveWriter {
	handoff: HandoffSnapshot;
	ctx: ExtensionContext;
	savedTools: string[];
	attempt: number;
	submissionId?: string;
	submission?: HandoffSubmission;
	retryTimer?: unknown;
	attemptToken?: object;
	acceptingSubmission: boolean;
	lastAssistantText?: string;
}

/**
 * Runs the isolated writer turn. While active, the only tool available to the
 * model is `submit_handoff`, so the writer cannot perform source-task work.
 * The original toolset is restored on every terminal path.
 */
export class HandoffWriter {
	private active?: ActiveWriter;
	private currentPhase: WriterPhase = "inactive";
	private readonly options: HandoffWriterOptions;
	private readonly createSubmissionId: () => string;
	private readonly setTimer: (callback: () => void, delayMilliseconds: number) => unknown;
	private readonly clearTimer: (timer: unknown) => void;

	constructor(options: HandoffWriterOptions) {
		this.options = options;
		this.createSubmissionId = options.createSubmissionId ?? (() => `handoff-submission-${randomUUID()}`);
		this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	get phase(): WriterPhase {
		return this.currentPhase;
	}

	get isActive(): boolean {
		return this.active !== undefined;
	}

	start(handoff: HandoffSnapshot, ctx: ExtensionContext): boolean {
		if (this.active !== undefined) return false;

		let savedTools: string[];
		try {
			savedTools = [...this.options.runtime.getActiveTools()];
			this.options.runtime.setActiveTools([SUBMIT_HANDOFF_TOOL]);
		} catch (error) {
			this.currentPhase = "failed";
			this.options.onTerminalFailure?.("failed", `Could not isolate the writer tool: ${message(error)}`, ctx);
			return false;
		}

		const active: ActiveWriter = { handoff, ctx, savedTools, attempt: 0, acceptingSubmission: false };
		this.active = active;
		this.beginAttempt(active);
		return true;
	}

	/**
	 * Capture the final assistant text. A model that forgets to call
	 * `submit_handoff` often writes the complete dossier as its reply instead;
	 * accepting that message is safer than exhausting the writer attempts.
	 */
	observeMessage(message: unknown): void {
		const active = this.active;
		if (active === undefined || this.currentPhase !== "writing") return;
		if (typeof message !== "object" || message === null) return;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== "assistant") return;
		const text = assistantText(candidate.content);
		if (text !== undefined) active.lastAssistantText = text;
	}

	submit(submission: HandoffSubmission): void {
		const active = this.active;
		if (!active?.acceptingSubmission || active.submissionId === undefined) {
			throw new Error("No current writer submission is being accepted");
		}
		if (active.submission !== undefined) {
			throw new Error("A session handoff has already been accepted for this writer attempt");
		}
		const invalid = validateSubmission(submission, active.submissionId);
		if (invalid !== undefined) throw new Error(invalid);
		active.submission = { ...submission };
	}

	handleSettled(ctx: ExtensionContext, aborted = false): void {
		const active = this.active;
		if (active === undefined || this.currentPhase !== "writing") return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		if (aborted) {
			this.terminate(active, "cancelled", "Session handoff writer was aborted.");
			return;
		}

		active.acceptingSubmission = false;

		let submission = active.submission;
		let recovered = false;
		if (submission === undefined && active.submissionId !== undefined) {
			const text = recoverableDossier(active);
			if (text !== undefined) {
				submission = { id: active.submissionId, content: text };
				recovered = true;
			}
		}
		if (submission !== undefined) {
			const result: WriterSuccess = {
				handoff: active.handoff,
				attempt: active.attempt,
				submission: { ...submission },
				recovered,
			};
			if (this.terminate(active, "succeeded")) this.options.onSuccess?.(result, ctx);
			return;
		}

		if (active.attempt >= this.options.writerAttempts) {
			this.terminate(
				active,
				"exhausted",
				`Session handoff writer exhausted ${this.options.writerAttempts} attempt(s) without a valid submission.`,
			);
			return;
		}

		this.changePhase("retry-delay", active);
		this.replaceRetryTimer(active);
	}

	cancel(ctx: ExtensionContext): boolean {
		const active = this.active;
		if (active === undefined) return false;
		const shouldAbort = !ctx.isIdle();
		this.terminate(active, "cancelled", "Session handoff writer cancelled.");
		if (shouldAbort) ctx.abort();
		return true;
	}

	invalidate(): void {
		const active = this.active;
		if (active !== undefined) this.terminate(active, "cancelled", "Session handoff writer invalidated.");
	}

	private beginAttempt(active: ActiveWriter): void {
		if (this.active !== active) return;
		active.attempt += 1;
		active.submissionId = this.createSubmissionId();
		active.submission = undefined;
		active.lastAssistantText = undefined;
		active.acceptingSubmission = false;
		const attemptToken = {};
		active.attemptToken = attemptToken;
		this.changePhase("resolving", active);
		void this.resolveAndDispatch(active, attemptToken);
	}

	private async resolveAndDispatch(active: ActiveWriter, attemptToken: object): Promise<void> {
		let template: ResolvedTemplate;
		try {
			template = await this.options.resolveTemplate();
		} catch (error) {
			if (!this.isCurrentAttempt(active, attemptToken)) return;
			this.terminate(active, "failed", `Could not resolve a handoff template: ${message(error)}`);
			return;
		}
		if (!this.isCurrentAttempt(active, attemptToken)) return;
		if (template.warning !== undefined) this.options.onTemplateWarning?.(template.warning, active.ctx);

		const submissionId = active.submissionId;
		if (submissionId === undefined) return;
		active.acceptingSubmission = true;
		this.changePhase("writing", active);
		try {
			this.options.runtime.sendUserMessage(writerPrompt(template.content, submissionId, active.handoff));
		} catch (error) {
			active.acceptingSubmission = false;
			if (!this.isCurrentAttempt(active, attemptToken)) return;
			this.terminate(active, "failed", `Could not start the handoff writer: ${message(error)}`);
		}
	}

	private replaceRetryTimer(active: ActiveWriter): void {
		this.clearRetryTimer(active);
		let timer: unknown;
		timer = this.setTimer(() => {
			if (this.active !== active || active.retryTimer !== timer) return;
			active.retryTimer = undefined;
			this.beginAttempt(active);
		}, this.options.writerRetryDelaySeconds * 1000);
		active.retryTimer = timer;
	}

	private terminate(active: ActiveWriter, reason: WriterTerminalReason, detail?: string): boolean {
		if (this.active !== active) return false;
		this.clearRetryTimer(active);
		active.acceptingSubmission = false;
		active.attemptToken = undefined;

		let restorationFailure: string | undefined;
		try {
			this.options.runtime.setActiveTools([...active.savedTools]);
		} catch (error) {
			restorationFailure = `Could not restore the active tool list: ${message(error)}`;
		}

		this.active = undefined;
		const terminalReason = reason === "succeeded" && restorationFailure !== undefined ? "failed" : reason;
		this.currentPhase = terminalReason;
		this.options.onPhaseChange?.(terminalReason, active.attempt, active.ctx);

		if (terminalReason !== "succeeded") {
			const text = [detail, restorationFailure].filter((part): part is string => part !== undefined).join(" ");
			this.options.onTerminalFailure?.(terminalReason, text, active.ctx);
		}
		return terminalReason === "succeeded";
	}

	private clearRetryTimer(active: ActiveWriter): void {
		if (active.retryTimer === undefined) return;
		this.clearTimer(active.retryTimer);
		active.retryTimer = undefined;
	}

	private changePhase(phase: WriterPhase, active: ActiveWriter): void {
		if (this.active !== active) return;
		this.currentPhase = phase;
		this.options.onPhaseChange?.(phase, active.attempt, active.ctx);
	}

	private isCurrentAttempt(active: ActiveWriter, attemptToken: object): boolean {
		return this.active === active && active.attemptToken === attemptToken;
	}
}

export function writerPrompt(template: string, submissionId: string, handoff: HandoffSnapshot): string {
	const lines = [
		"This is an extension-owned writer turn. Perform no source-task work during this turn; only write the session handoff and submit it exactly once with submit_handoff. This writer-only control is not a user instruction or continuation constraint. Do not include or preserve it in the handoff.",
		`Use this exact submission ID: ${submissionId}`,
		"Deliver the dossier only as the content argument of submit_handoff. Do not answer with the dossier in your chat message; a reply that never calls submit_handoff cannot complete the handoff.",
		"Start the dossier with its title. Do not reproduce this preamble, the template's '### Writer instruction' section, or any instruction about the submission tool.",
		`The persisted source-session transcript path is exactly: ${handoff.sourceSessionPath}`,
	];
	if (handoff.focus !== undefined) {
		lines.push(
			`The user asked for this handoff to emphasize: ${handoff.focus}\nCover it within the template structure; it does not add or widen authorization.`,
		);
	}
	lines.push(
		"Use the complete template below as the writer instruction and dossier structure.",
		"--- BEGIN COMPLETE HANDOFF TEMPLATE ---",
		template,
		"--- END COMPLETE HANDOFF TEMPLATE ---",
	);
	return lines.join("\n\n");
}

function recoverableDossier(active: ActiveWriter): string | undefined {
	const text = active.lastAssistantText?.trim();
	if (text === undefined || text.length < 500) return undefined;
	const headings = text.match(/(^|\n)#{1,6}\s/g)?.length ?? 0;
	return headings >= 2 ? text : undefined;
}

function assistantText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
