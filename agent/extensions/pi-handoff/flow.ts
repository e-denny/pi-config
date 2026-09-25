import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DeferredPromptWindow, type DeferredPromptSnapshot } from "./deferred.ts";
import { createHandoffId, createReadinessKey, readinessPrompt, readinessReminder } from "./readiness.ts";

export type HandoffSource = "command" | "tool";
export type HandoffPhase = "inactive" | "waiting" | "user-input-required" | "ready";

export interface HandoffSnapshot {
	id: string;
	source: HandoffSource;
	sourceSessionPath: string;
	phase: Exclude<HandoffPhase, "inactive">;
	readinessKey: string;
	awaitingUserGo: boolean;
	/** User-supplied emphasis for the writer, if any. */
	focus?: string;
}

export type HandoffStartResult =
	| { accepted: true; handoff: HandoffSnapshot }
	| { accepted: false; reason: "active" | "unpersisted"; handoff?: HandoffSnapshot };

export type HandoffInputResult = { action: "continue" } | { action: "deferred"; snapshot: DeferredPromptSnapshot };

export type HandoffGoResult = "accepted" | "stale" | "not-started";
export type HandoffDeferralResult = HandoffGoResult | "selection-open";
export type HandoffDeferralChoice = "Ready" | "Wait" | "Cancel";

export interface HandoffFlowOptions {
	readinessRetrySeconds: number;
	callTemplate: string;
	onReadinessPrompt(prompt: string, handoff: HandoffSnapshot, ctx: ExtensionContext): void;
	onReadinessReminder(prompt: string, handoff: HandoffSnapshot, ctx: ExtensionContext): void;
	onReady(handoff: HandoffSnapshot, ctx: ExtensionContext): void;
	onPhaseChange?(handoff: HandoffSnapshot | undefined, ctx: ExtensionContext): void;
	createHandoffId?: () => string;
	createReadinessKey?: () => string;
	setTimer?: (callback: () => void, delayMilliseconds: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

interface ActiveHandoff {
	id: string;
	source: HandoffSource;
	sourceSessionPath: string;
	phase: Exclude<HandoffPhase, "inactive">;
	readinessKey: string;
	awaitingUserGo: boolean;
	callTemplate: string;
	focus?: string;
	instructionSent: boolean;
	writerDispatched: boolean;
	reminderTimer?: unknown;
	deferred?: DeferredPromptWindow;
}

/**
 * Readiness and deferral state machine. It decides when a handoff may proceed
 * to the writer; it never runs the writer or the native transition itself.
 */
export class HandoffFlow {
	private active?: ActiveHandoff;
	private readonly options: HandoffFlowOptions;
	private readonly makeHandoffId: () => string;
	private readonly makeReadinessKey: () => string;
	private readonly setTimer: (callback: () => void, delayMilliseconds: number) => unknown;
	private readonly clearTimer: (timer: unknown) => void;

	constructor(options: HandoffFlowOptions) {
		this.options = options;
		this.makeHandoffId = options.createHandoffId ?? createHandoffId;
		this.makeReadinessKey = options.createReadinessKey ?? createReadinessKey;
		this.setTimer =
			options.setTimer ??
			((callback, delay) => {
				const timer = setTimeout(callback, delay);
				timer.unref();
				return timer;
			});
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	get phase(): HandoffPhase {
		return this.active?.phase ?? "inactive";
	}

	get snapshot(): HandoffSnapshot | undefined {
		return this.active === undefined ? undefined : toSnapshot(this.active);
	}

	get deferredSnapshot(): DeferredPromptSnapshot | undefined {
		return this.active?.deferred?.snapshot;
	}

	get isTransferProtected(): boolean {
		return this.active?.phase === "ready";
	}

	start(ctx: ExtensionContext, source: HandoffSource, focus?: string): HandoffStartResult {
		if (this.active !== undefined) {
			return { accepted: false, reason: "active", handoff: toSnapshot(this.active) };
		}

		const sourceSessionPath = ctx.sessionManager.getSessionFile();
		if (sourceSessionPath === undefined) return { accepted: false, reason: "unpersisted" };

		this.active = {
			id: this.makeHandoffId(),
			source,
			sourceSessionPath,
			phase: "waiting",
			readinessKey: this.makeReadinessKey(),
			awaitingUserGo: false,
			callTemplate: this.options.callTemplate,
			focus: focus?.trim() || undefined,
			instructionSent: false,
			writerDispatched: false,
		};
		this.changed(ctx);

		const handoff = this.active;
		if (ctx.isIdle() && !ctx.hasPendingMessages()) this.dispatchReadiness(handoff, ctx);

		return { accepted: true, handoff: toSnapshot(handoff) };
	}

	acceptGo(key: string, ctx: ExtensionContext): HandoffGoResult {
		const active = this.correlated(key);
		if (active === undefined) return this.active === undefined ? "not-started" : "stale";
		if (!active.instructionSent || active.phase === "ready" || active.phase === "user-input-required") return "stale";
		this.accept(active, ctx);
		return "accepted";
	}

	beginUserDeferral(key: string, ctx: ExtensionContext): HandoffDeferralResult {
		const active = this.correlated(key);
		if (active === undefined) return this.active === undefined ? "not-started" : "stale";
		if (!active.instructionSent || active.phase === "ready" || active.awaitingUserGo) return "stale";
		if (active.phase === "user-input-required") return "selection-open";

		this.clearReminderTimer(active);
		active.phase = "user-input-required";
		this.changed(ctx);
		return "accepted";
	}

	resolveUserDeferral(key: string, choice: HandoffDeferralChoice, ctx: ExtensionContext): HandoffDeferralResult {
		const active = this.correlated(key);
		if (active === undefined) return this.active === undefined ? "not-started" : "stale";
		if (active.phase !== "user-input-required") return "stale";

		if (choice === "Ready") {
			this.accept(active, ctx);
		} else if (choice === "Wait") {
			active.phase = "waiting";
			active.awaitingUserGo = true;
			this.changed(ctx);
		} else {
			this.finish(ctx, active.id);
		}
		return "accepted";
	}

	/** Capture user input that arrives after GO while the writer or cutover is running. */
	handleInput(text: string, source: "interactive" | "rpc" | "extension"): HandoffInputResult {
		if (source === "extension" || this.active === undefined || this.active.phase !== "ready") {
			return { action: "continue" };
		}
		const deferred = this.active.deferred;
		if (deferred === undefined) throw new Error("Deferred-prompt window is unavailable after accepted GO");
		return { action: "deferred", snapshot: deferred.capture(text) };
	}

	handleSettled(ctx: ExtensionContext): void {
		const active = this.active;
		if (active === undefined || !ctx.isIdle() || ctx.hasPendingMessages()) return;

		if (!active.instructionSent) {
			this.dispatchReadiness(active, ctx);
		} else if (active.phase === "ready" && !active.writerDispatched) {
			active.writerDispatched = true;
			this.options.onReady(toSnapshot(active), ctx);
		}
	}

	cancel(ctx: ExtensionContext): boolean {
		return this.finish(ctx);
	}

	finish(ctx: ExtensionContext, handoffId?: string): boolean {
		if (this.active === undefined || (handoffId !== undefined && this.active.id !== handoffId)) return false;
		this.clearReminderTimer(this.active);
		this.active = undefined;
		this.options.onPhaseChange?.(undefined, ctx);
		return true;
	}

	invalidate(): void {
		if (this.active !== undefined) this.clearReminderTimer(this.active);
		this.active = undefined;
	}

	describe(): string {
		const active = this.active;
		if (active === undefined) return "No session handoff is active.";
		const deferred = active.deferred?.snapshot.prompts.length ?? 0;
		return [
			`Session handoff ${active.id} is ${active.phase}.`,
			`Source session: ${active.sourceSessionPath}`,
			active.awaitingUserGo ? "Waiting for user GO." : undefined,
			deferred > 0 ? `${deferred} deferred prompt(s) captured.` : undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join(" ");
	}

	private correlated(key: string): ActiveHandoff | undefined {
		return this.active?.readinessKey === key ? this.active : undefined;
	}

	private accept(active: ActiveHandoff, ctx: ExtensionContext): void {
		this.clearReminderTimer(active);
		active.deferred = new DeferredPromptWindow(active.id, active.sourceSessionPath);
		active.phase = "ready";
		active.awaitingUserGo = false;
		this.changed(ctx);
	}

	private dispatchReadiness(active: ActiveHandoff, ctx: ExtensionContext): void {
		if (this.active !== active || active.instructionSent) return;
		active.instructionSent = true;
		this.changed(ctx);
		this.options.onReadinessPrompt(
			readinessPrompt(active.callTemplate, active.readinessKey, true),
			toSnapshot(active),
			ctx,
		);
		this.scheduleReminder(active, ctx);
	}

	private scheduleReminder(active: ActiveHandoff, ctx: ExtensionContext): void {
		if (this.options.readinessRetrySeconds <= 0) return;
		const timer = this.setTimer(() => {
			if (this.active !== active || active.reminderTimer !== timer) return;
			active.reminderTimer = undefined;
			this.options.onReadinessReminder(
				readinessReminder(active.callTemplate, active.readinessKey, true),
				toSnapshot(active),
				ctx,
			);
		}, this.options.readinessRetrySeconds * 1000);
		active.reminderTimer = timer;
	}

	private clearReminderTimer(active: ActiveHandoff): void {
		if (active.reminderTimer === undefined) return;
		this.clearTimer(active.reminderTimer);
		active.reminderTimer = undefined;
	}

	private changed(ctx: ExtensionContext): void {
		this.options.onPhaseChange?.(this.snapshot, ctx);
	}
}

function toSnapshot(active: ActiveHandoff): HandoffSnapshot {
	return {
		id: active.id,
		source: active.source,
		sourceSessionPath: active.sourceSessionPath,
		phase: active.phase,
		readinessKey: active.readinessKey,
		awaitingUserGo: active.awaitingUserGo,
		focus: active.focus,
	};
}
