import { randomUUID } from "node:crypto";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { assembleHandoffMarkdown, type DeferredPromptSnapshot } from "./deferred.ts";

type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacedSessionContext = NonNullable<NewSessionOptions["withSession"]> extends (
	ctx: infer T,
) => Promise<void>
	? T
	: never;

export const PRIVATE_TRANSITION_COMMAND = "__pi_handoff_transition";

export function nativeTransitionCommand(token: string): string {
	return `/${PRIVATE_TRANSITION_COMMAND} ${token}`;
}

export type NativeTransitionPhase = "inactive" | "pending" | "replacing";

export interface TransitionRequest {
	handoffId: string;
	sourceSessionPath: string;
	dossier: string;
}

export interface NativeTransitionOptions {
	getDeferredSnapshot(handoffId: string): DeferredPromptSnapshot | undefined;
	onReplacementStarted?(request: TransitionRequest, ctx: ReplacedSessionContext): void;
	onFinished?(request: TransitionRequest, ctx: ReplacedSessionContext): void;
	onFailure?(request: TransitionRequest, message: string, ctx: ExtensionContext): void;
	createToken?: () => string;
}

interface ActiveTransition extends TransitionRequest {
	token: string;
	phase: Exclude<NativeTransitionPhase, "inactive">;
	allowOwnSwitch: boolean;
}

/**
 * Deterministic cutover. `ctx.newSession` is command-only, so readiness is
 * handed here through a private command carrying a one-time correlation token;
 * the command then performs the native linked replacement.
 */
export class NativeHandoffTransition {
	private active?: ActiveTransition;
	private readonly options: NativeTransitionOptions;
	private readonly createToken: () => string;

	constructor(options: NativeTransitionOptions) {
		this.options = options;
		this.createToken = options.createToken ?? (() => randomUUID());
	}

	get phase(): NativeTransitionPhase {
		return this.active?.phase ?? "inactive";
	}

	get isProtected(): boolean {
		return this.active !== undefined;
	}

	/** Returns the one-time token, or undefined when a transition already exists. */
	prepare(request: TransitionRequest): string | undefined {
		if (this.active !== undefined) return undefined;
		const token = this.createToken();
		this.active = { ...request, token, phase: "pending", allowOwnSwitch: false };
		return token;
	}

	cancel(): "inactive" | "cancelled" | "committed" {
		if (this.active === undefined) return "inactive";
		if (this.active.phase === "replacing") return "committed";
		this.active = undefined;
		return "cancelled";
	}

	invalidate(): void {
		if (this.active?.phase !== "replacing") this.active = undefined;
	}

	/** Lets the extension's own `newSession` pass the session-switch guard once. */
	allowNativeNewSession(reason: "new" | "resume"): boolean {
		const active = this.active;
		if (active === undefined || active.phase !== "replacing" || !active.allowOwnSwitch || reason !== "new") {
			return false;
		}
		active.allowOwnSwitch = false;
		return true;
	}

	async execute(argumentsText: string, ctx: ExtensionCommandContext): Promise<boolean> {
		const active = this.active;
		if (active === undefined || active.phase !== "pending" || argumentsText.trim() !== active.token) {
			ctx.ui.notify("Ignored a stale or uncorrelated session handoff transition request.", "warning");
			return false;
		}

		const prompts = this.options.getDeferredSnapshot(active.handoffId)?.prompts ?? [];
		const markdown = assembleHandoffMarkdown(active.dossier, prompts);

		active.phase = "replacing";
		active.allowOwnSwitch = true;
		let replacementContext: ReplacedSessionContext | undefined;

		try {
			const result = await ctx.newSession({
				parentSession: active.sourceSessionPath,
				withSession: async (freshCtx) => {
					replacementContext = freshCtx;
					this.options.onReplacementStarted?.(active, freshCtx);
					await freshCtx.sendUserMessage(markdown);
				},
			});

			if (result.cancelled) {
				this.fail(active, "Session handoff replacement was cancelled by a session guard.", replacementContext ?? ctx);
				return false;
			}
			if (replacementContext === undefined) {
				this.fail(
					active,
					"Session handoff replacement failed: the replacement session context was unavailable.",
					ctx,
				);
				return false;
			}

			if (this.active === active) this.active = undefined;
			this.options.onFinished?.(active, replacementContext);
			return true;
		} catch (error) {
			this.fail(active, `Session handoff replacement failed: ${message(error)}`, replacementContext ?? ctx);
			return false;
		}
	}

	private fail(active: ActiveTransition, text: string, ctx: ExtensionContext): void {
		if (this.active === active) this.active = undefined;
		this.options.onFailure?.(active, text, ctx);
	}
}

export function registerNativeTransitionBridge(
	pi: Pick<ExtensionAPI, "registerCommand">,
	transition: NativeHandoffTransition,
): void {
	pi.registerCommand(PRIVATE_TRANSITION_COMMAND, {
		description: "Internal: perform the correlated native session handoff cutover.",
		handler: async (args, ctx) => {
			await transition.execute(args, ctx);
		},
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
