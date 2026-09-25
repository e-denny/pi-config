import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadConfig, type HandoffConfig } from "./config.ts";
import { HandoffFlow, type HandoffSource } from "./flow.ts";
import { formatDeferredPrompts } from "./deferred.ts";
import { resolveTemplate } from "./templates.ts";
import {
	registerControlTool,
	registerReadinessTools,
	registerSubmissionTool,
	SUBMIT_HANDOFF_TOOL,
} from "./tools.ts";
import {
	NativeHandoffTransition,
	nativeTransitionCommand,
	registerNativeTransitionBridge,
} from "./transition.ts";
import { HandoffWriter, type WriterRuntime } from "./writer.ts";

const READINESS_MESSAGE_TYPE = "pi-handoff-readiness";
const CANCELLATION_MESSAGE_TYPE = "pi-handoff-cancellation";
const CANCELLATION_INSTRUCTION =
	"The user cancelled the session handoff. Stop preparing for transfer and continue the task normally. Do not call either readiness tool.";

/** Replacement sessions that must not be blocked by their own transfer guard. */
const protectedSessions = new Set<string>();

const HELP = [
	"pi-handoff commands:",
	"  /handoff [focus]   Start a handoff; focus is optional emphasis for the writer.",
	"  /handoff-cancel    Cancel the active handoff (or /handoff cancel).",
	"  /handoff-status    Report handoff and context state (or /handoff status).",
	"  /handoff-help      Show this help (or /handoff help).",
	"",
	"The model is told to call handoff_go (or handoff_go_with_user_deferral) at the next safe boundary.",
	"User prompts sent during the transfer are deferred and appended to the handoff dossier.",
].join("\n");

export default async function piHandoff(pi: ExtensionAPI): Promise<void> {
	const { config, warnings } = await loadConfig();
	const callTemplate = await resolveTemplate(config.callTemplate, config.templateDirectory, "call_default");
	if (callTemplate.warning !== undefined) warnings.push(callTemplate.warning);

	activate(pi, config, callTemplate.content, warnings);
}

export function activate(
	pi: ExtensionAPI,
	config: HandoffConfig,
	callTemplateContent: string,
	startupWarnings: readonly string[] = [],
): void {
	const writerRuntime = writerRuntimeFrom(pi);
	let pendingWarnings = [...startupWarnings];
	let flow: HandoffFlow;

	const transition = new NativeHandoffTransition({
		getDeferredSnapshot(handoffId) {
			return flow.snapshot?.id === handoffId ? flow.deferredSnapshot : undefined;
		},
		onReplacementStarted(_request, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile !== undefined) protectedSessions.add(sessionFile);
		},
		onFinished(request, ctx) {
			unprotect(ctx);
			flow.finish(ctx, request.handoffId);
			ctx.ui.notify("Session handoff complete. This is the linked replacement session.", "info");
		},
		onFailure(request, text, ctx) {
			const prompts = flow.deferredSnapshot?.prompts ?? [];
			unprotect(ctx);
			flow.finish(ctx, request.handoffId);
			ctx.ui.notify(text, "error");
			if (prompts.length > 0) {
				pi.sendUserMessage(
					`The session handoff failed before replacement. These prompts were held back and are returned to this session:\n\n${formatDeferredPrompts(prompts)}`,
				);
			}
		},
	});
	registerNativeTransitionBridge(pi, transition);

	const writer =
		writerRuntime === undefined
			? undefined
			: new HandoffWriter({
					writerAttempts: config.writerAttempts,
					writerRetryDelaySeconds: config.writerRetryDelaySeconds,
					runtime: writerRuntime,
					resolveTemplate: () =>
						resolveTemplate(config.handoffTemplate, config.templateDirectory, "handoff_default"),
					onTemplateWarning(warning, ctx) {
						ctx.ui.notify(warning, "warning");
					},
					onPhaseChange(phase, _attempt, ctx) {
						if (phase === "retry-delay") ctx.ui.notify("Retrying the session handoff writer.", "info");
					},
					onSuccess(result, ctx) {
						const token = transition.prepare({
							handoffId: result.handoff.id,
							sourceSessionPath: result.handoff.sourceSessionPath,
							dossier: result.submission.content,
						});
						if (token === undefined) {
							flow.finish(ctx, result.handoff.id);
							ctx.ui.notify("Could not start the correlated session handoff transition.", "error");
							return;
						}
						ctx.ui.notify(
							`Session handoff dossier accepted on writer attempt ${result.attempt}.`,
							"info",
						);
						try {
							pi.sendUserMessage(nativeTransitionCommand(token), {
								deliverAs: "followUp",
								expandPromptTemplates: true,
							});
						} catch (error) {
							transition.cancel();
							flow.finish(ctx, result.handoff.id);
							ctx.ui.notify(`Could not request native session replacement: ${message(error)}`, "error");
						}
					},
					onTerminalFailure(reason, text, ctx) {
						flow.finish(ctx);
						if (reason !== "cancelled") ctx.ui.notify(text, "error");
					},
				});

	if (writer !== undefined) registerSubmissionTool(pi, (submission) => writer.submit(submission));

	flow = new HandoffFlow({
		readinessRetrySeconds: config.readinessRetrySeconds,
		callTemplate: callTemplateContent,
		onReadinessPrompt(prompt, _handoff, ctx) {
			pi.sendMessage(
				{ customType: READINESS_MESSAGE_TYPE, content: prompt, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			updateStatus(ctx, flow, writer);
		},
		onReadinessReminder(prompt, _handoff, ctx) {
			pi.sendMessage(
				{ customType: READINESS_MESSAGE_TYPE, content: prompt, display: true },
				{ deliverAs: "steer", triggerTurn: true },
			);
			ctx.ui.notify("Session handoff is still waiting for the model to reach a safe boundary.", "warning");
		},
		onReady(handoff, ctx) {
			if (writer === undefined) {
				flow.finish(ctx, handoff.id);
				ctx.ui.notify("Session handoff writer is unavailable in this runtime.", "error");
				return;
			}
			if (!writer.start(handoff, ctx)) {
				flow.finish(ctx, handoff.id);
			}
			updateStatus(ctx, flow, writer);
		},
		onPhaseChange(_handoff, ctx) {
			updateStatus(ctx, flow, writer);
		},
	});

	registerReadinessTools(pi, {
		accept: (key, ctx) => flow.acceptGo(key, ctx),
		beginUserDeferral: (key, ctx) => flow.beginUserDeferral(key, ctx),
		resolveUserDeferral: (key, choice, ctx) => {
			const result = flow.resolveUserDeferral(key, choice, ctx);
			if (result === "accepted" && choice === "Wait") {
				ctx.ui.notify(
					"Session handoff is waiting for your GO. Tell the model to start when ready.",
					"info",
				);
			}
			return result;
		},
	});

	registerControlTool(pi, {
		status: (ctx) => statusText(ctx, flow, config),
		start: (ctx) => startHandoff(ctx, flow, "tool"),
	});

	const handleAction = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const trimmed = args.trim();
		if (trimmed === "help") {
			ctx.ui.notify(HELP, "info");
			return;
		}
		if (trimmed === "status") {
			ctx.ui.notify(statusText(ctx, flow, config), "info");
			return;
		}
		if (trimmed === "cancel") {
			cancelHandoff(pi, ctx, flow, writer);
			return;
		}
		const result = startHandoff(ctx, flow, "command", trimmed === "" ? undefined : trimmed);
		ctx.ui.notify(result, "info");
	};

	pi.registerCommand("handoff", {
		description: "Hand off this session to a fresh, natively linked session",
		handler: async (args, ctx) => {
			await handleAction(args, ctx);
		},
	});

	for (const [command, action, description] of [
		["handoff-cancel", "cancel", "Cancel the active session handoff"],
		["handoff-status", "status", "Report session handoff and context state"],
		["handoff-help", "help", "Show session handoff commands"],
	] as const) {
		pi.registerCommand(command, {
			description,
			handler: async (_args, ctx) => {
				await handleAction(action, ctx);
			},
		});
	}

	pi.on("agent_settled", (_event, ctx) => {
		if (writer?.isActive) {
			writer.handleSettled(ctx);
			return;
		}
		flow.handleSettled(ctx);
	});

	pi.on("input", (event, ctx) => {
		const result = flow.handleInput(event.text, event.source);
		if (result.action === "continue") return { action: "continue" };
		ctx.ui.notify("Prompt deferred until the session handoff completes.", "info");
		return { action: "handled" };
	});

	pi.on("session_before_switch", (event, ctx) => {
		if (!isTransferProtected(ctx, flow, transition)) return;
		if (transition.allowNativeNewSession(event.reason)) return;
		ctx.ui.notify("Session replacement is blocked while a session handoff transfer is active.", "warning");
		return { cancel: true };
	});

	pi.on("session_before_fork", (_event, ctx) => {
		if (!isTransferProtected(ctx, flow, transition)) return;
		ctx.ui.notify("Session fork is blocked while a session handoff transfer is active.", "warning");
		return { cancel: true };
	});

	pi.on("session_before_compact", (_event, ctx) => {
		if (!isTransferProtected(ctx, flow, transition)) return;
		ctx.ui.notify("Session compaction is blocked while a session handoff transfer is active.", "warning");
		return { cancel: true };
	});

	pi.on("session_start", (event, ctx) => {
		// A manual new/resume/fork while a handoff is still waiting abandons it.
		// (After GO the switch is blocked, and the extension's own replacement is
		// allowed through the transition guard.)
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			writer?.invalidate();
			flow.invalidate();
			transition.invalidate();
		}
		initializeWriterTools(writerRuntime, ctx);
		for (const warning of pendingWarnings) ctx.ui.notify(warning, "warning");
		pendingWarnings = [];
		updateStatus(ctx, flow, writer);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		writer?.invalidate();
		flow.invalidate();
		transition.invalidate();
		unprotect(ctx);
		try {
			ctx.ui.setStatus("pi-handoff", undefined);
		} catch {
			// Status is best-effort and unavailable in some modes.
		}
	});
}

function startHandoff(ctx: ExtensionContext, flow: HandoffFlow, source: HandoffSource, focus?: string): string {
	if (flow.phase !== "inactive") {
		return `A session handoff is already active. ${flow.describe()}`;
	}
	const result = flow.start(ctx, source, focus);
	if (!result.accepted) {
		if (result.reason === "active") return `A session handoff is already active. ${flow.describe()}`;
		return "This session is not persisted, so it cannot start a handoff. Remove --no-session and retry.";
	}
	return "Session handoff requested. The model will signal readiness at the next safe boundary.";
}

function cancelHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	flow: HandoffFlow,
	writer: HandoffWriter | undefined,
): void {
	const cancelledWriter = writer?.cancel(ctx) ?? false;
	const cancelledFlow = flow.cancel(ctx);
	if (!cancelledWriter && !cancelledFlow) {
		ctx.ui.notify("No active session handoff to cancel.", "info");
		return;
	}
	pi.sendMessage(
		{ customType: CANCELLATION_MESSAGE_TYPE, content: CANCELLATION_INSTRUCTION, display: true },
		{ deliverAs: "followUp", triggerTurn: true },
	);
	ctx.ui.notify("Session handoff cancelled.", "info");
}

function isTransferProtected(
	ctx: ExtensionContext,
	flow: HandoffFlow,
	transition: NativeHandoffTransition,
): boolean {
	if (flow.isTransferProtected || transition.isProtected) return true;
	const sessionFile = ctx.sessionManager.getSessionFile();
	return sessionFile !== undefined && protectedSessions.has(sessionFile);
}

function unprotect(ctx: ExtensionContext): void {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile !== undefined) protectedSessions.delete(sessionFile);
}

function initializeWriterTools(runtime: WriterRuntime | undefined, ctx: ExtensionContext): void {
	if (runtime === undefined) return;
	try {
		runtime.setActiveTools(runtime.getActiveTools().filter((name) => name !== SUBMIT_HANDOFF_TOOL));
	} catch (error) {
		ctx.ui.notify(`Could not initialize session handoff writer tools: ${message(error)}`, "error");
	}
}

function updateStatus(ctx: ExtensionContext, flow: HandoffFlow, writer: HandoffWriter | undefined): void {
	const active = flow.phase !== "inactive" || (writer?.isActive ?? false);
	const text = active ? `handoff: ${flow.phase}${writer?.isActive ? " (writing)" : ""}` : undefined;
	try {
		ctx.ui.setStatus("pi-handoff", text);
	} catch {
		// Status is best-effort and unavailable in some modes.
	}
}

function statusText(ctx: ExtensionContext, flow: HandoffFlow, config: HandoffConfig): string {
	const usage = ctx.getContextUsage();
	const percent = usage?.percent;
	return [
		flow.describe(),
		percent === null || percent === undefined ? undefined : `Context usage: ${percent.toFixed(1)}%`,
		`Readiness reminder: ${config.readinessRetrySeconds > 0 ? `${config.readinessRetrySeconds}s` : "disabled"} · writer attempts: ${config.writerAttempts}`,
		"Commands: /handoff [focus], /handoff-cancel, /handoff-status, /handoff-help",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function writerRuntimeFrom(pi: ExtensionAPI): WriterRuntime | undefined {
	if (
		typeof pi.getActiveTools !== "function" ||
		typeof pi.setActiveTools !== "function" ||
		typeof pi.sendUserMessage !== "function"
	) {
		return undefined;
	}
	return {
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
		sendUserMessage: (content) => pi.sendUserMessage(content),
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
