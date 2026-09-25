import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { HandoffDeferralChoice, HandoffDeferralResult, HandoffGoResult } from "./flow.ts";
import { HANDOFF_GO_TOOL, HANDOFF_GO_WITH_USER_DEFERRAL_TOOL } from "./readiness.ts";

export const SUBMIT_HANDOFF_TOOL = "submit_handoff";
export const SESSION_HANDOFF_TOOL = "session_handoff";

export interface HandoffSubmission {
	id: string;
	content: string;
}

export function validateSubmission(submission: HandoffSubmission, currentSubmissionId: string): string | undefined {
	if (submission.id !== currentSubmissionId) return "Submission ID does not match the current writer attempt";
	if (submission.content.length === 0) return "Session handoff content must not be empty";
	if (submission.content.includes("\0")) return "Session handoff content must not contain NUL";
	return undefined;
}

export interface ReadinessToolHandlers {
	accept(key: string, ctx: ExtensionContext): HandoffGoResult;
	beginUserDeferral(key: string, ctx: ExtensionContext): HandoffDeferralResult;
	resolveUserDeferral(key: string, choice: HandoffDeferralChoice, ctx: ExtensionContext): HandoffDeferralResult;
}

/**
 * The two correlated readiness tools. The model must pass the exact key from
 * the injected Call Template, which makes a stale or forged GO impossible.
 */
export function registerReadinessTools(pi: ExtensionAPI, handlers: ReadinessToolHandlers): void {
	pi.registerTool({
		name: HANDOFF_GO_TOOL,
		label: "Handoff GO",
		description:
			"Accept the active session handoff immediately using its exact correlation key. Call only when the Call Template says the transfer boundary is safe.",
		promptSnippet: "Accept the active session handoff at a safe boundary",
		promptGuidelines: [
			`Use ${HANDOFF_GO_TOOL} with the exact correlation key from the current session handoff instruction once the transfer boundary is safe.`,
		],
		parameters: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "Exact correlation key supplied by the current session handoff instruction",
				},
			},
			required: ["key"],
			additionalProperties: false,
		},
		async execute(
			_toolCallId: string,
			params: { key: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			requireAccepted(handlers.accept(params.key, ctx));
			return toolResult("Session handoff GO accepted.", "ready");
		},
	} as unknown as ToolDefinition);

	pi.registerTool({
		name: HANDOFF_GO_WITH_USER_DEFERRAL_TOOL,
		label: "Handoff GO With User Deferral",
		description:
			"Open an extension-owned Ready / Wait / Cancel choice only when a concrete active user interaction may still matter before replacement.",
		promptSnippet: "Ask the user whether to hand off now, wait, or cancel",
		parameters: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "Exact correlation key supplied by the current session handoff instruction",
				},
				reason: {
					type: "string",
					minLength: 1,
					description: "Short concrete explanation of the active collaboration or user interaction",
				},
			},
			required: ["key", "reason"],
			additionalProperties: false,
		},
		async execute(
			_toolCallId: string,
			params: { key: string; reason: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (!ctx.hasUI) throw new Error("Session handoff user deferral requires an interactive UI");
			requireAccepted(handlers.beginUserDeferral(params.key, ctx));

			let selected: string | undefined;
			try {
				selected = await ctx.ui.select(
					`Your LLM reports an active user interaction:\n${params.reason}`,
					["Ready", "Wait", "Cancel"],
					{ signal },
				);
			} catch (error) {
				handlers.resolveUserDeferral(params.key, "Cancel", ctx);
				throw error;
			}

			const choice: HandoffDeferralChoice = selected === "Ready" || selected === "Wait" ? selected : "Cancel";
			requireAccepted(handlers.resolveUserDeferral(params.key, choice, ctx));
			const message =
				choice === "Ready"
					? "Session handoff GO accepted."
					: choice === "Wait"
						? "Session handoff is awaiting user GO."
						: "Session handoff cancelled.";
			return toolResult(message, choice.toLowerCase());
		},
	} as unknown as ToolDefinition);
}

export type SubmissionHandler = (submission: HandoffSubmission) => void;

/** Registered always, activated only for the isolated writer turn. */
export function registerSubmissionTool(pi: ExtensionAPI, submit: SubmissionHandler): void {
	pi.registerTool({
		name: SUBMIT_HANDOFF_TOOL,
		label: "Submit Handoff",
		description: "Submit the complete session handoff for the exact current writer attempt.",
		promptSnippet: "Submit the complete session handoff exactly once",
		promptGuidelines: [`Use ${SUBMIT_HANDOFF_TOOL} exactly once with the current submission ID and the complete dossier.`],
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Exact submission ID supplied in the writer prompt" },
				content: { type: "string", description: "Complete handoff Markdown" },
			},
			required: ["id", "content"],
			additionalProperties: false,
		},
		async execute(_toolCallId: string, params: HandoffSubmission) {
			submit(params);
			return {
				content: [{ type: "text" as const, text: "Session handoff submitted." }],
				details: { id: params.id },
				terminate: true as const,
			};
		},
	} as unknown as ToolDefinition);
}

export interface ControlToolHandlers {
	status(ctx: ExtensionContext): string;
	start(ctx: ExtensionContext): string;
}

/** Model-callable control surface. `start` is strictly user-initiated. */
export function registerControlTool(pi: ExtensionAPI, handlers: ControlToolHandlers): void {
	pi.registerTool({
		name: SESSION_HANDOFF_TOOL,
		label: "Session Handoff",
		description:
			"Inspect or request a session handoff. Use action=status to report handoff state. Use action=start only when the user explicitly asked for a handoff in this turn; discussion, questions, or mentions of handoffs are not start requests.",
		promptSnippet: "Inspect or request a session handoff",
		promptGuidelines: [
			`Use ${SESSION_HANDOFF_TOOL} with action=status to report handoff state.`,
			`Use ${SESSION_HANDOFF_TOOL} with action=start only when the user explicitly requested a handoff in this turn.`,
		],
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["status", "start"], description: "Operation to perform" },
				focus: {
					type: "string",
					description: "Optional emphasis for the writer when action=start",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
		async execute(
			_toolCallId: string,
			params: { action: "status" | "start"; focus?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const text = params.action === "status" ? handlers.status(ctx) : handlers.start(ctx);
			return {
				content: [{ type: "text" as const, text }],
				details: { action: params.action },
				terminate: true as const,
			};
		},
	} as unknown as ToolDefinition);
}

function requireAccepted(result: HandoffGoResult | HandoffDeferralResult): void {
	if (result === "accepted") return;
	if (result === "not-started") throw new Error("No session handoff is waiting for GO");
	if (result === "selection-open") throw new Error("A session handoff user choice is already open");
	throw new Error("Session handoff GO key is stale, invalid, or used at the wrong entry point");
}

function toolResult(message: string, outcome: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { accepted: true as const, outcome },
		terminate: true as const,
	};
}
