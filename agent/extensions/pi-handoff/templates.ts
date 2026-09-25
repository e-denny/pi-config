import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface ResolvedTemplate {
	content: string;
	/** Where the content came from: a file path or the built-in name. */
	source: string;
	/** Present when an explicitly requested template could not be used. */
	warning?: string;
}

const CALL_TEMPLATE = `Prepare this session for transfer at the next genuinely safe boundary.

Finish only required model-owned work, tool execution, subagents, background work, and required output that is already in flight. While any of those are still in flight, call neither readiness tool. Unfinished future work and ordinary unanswered or resumable questions are not blockers.

When the transfer boundary is safe, use direct GO unless the current exchange shows that you and the user are actively working through a live interaction that could be disrupted by replacing the session now. Examples include the user currently running or observing an interactive test, or supplying input to an ongoing process. The mere existence of a conversation, a future approval, or an ordinary unanswered question is not enough. Prefer direct GO when uncertain rather than inventing user deferral. Do not perform extra task work merely to make the session look complete.`;

const HANDOFF_TEMPLATE = `### Writer instruction

Write a **Session Handoff** for a genuinely fresh Pi session. Begin immediately with a concise, task-specific Markdown title on the first line. Do not add a generic label or status prefix. This is not a short summary: preserve the source-session truth needed for correct continuation.

Call \`submit_handoff\` exactly once as soon as the dossier is ready. Do not explain your reasoning. Keep the dossier complete but compact. Any extension-owned writer control surrounding this template applies only to the current writer turn; it is not a user instruction or continuation constraint and must not appear in the dossier.

## Governing truth and authorization

Use only facts supported by the session context. Distinguish among:

- completed and verified work;
- completed but unverified work;
- partial, failed, or reverted work;
- authorized work executable now;
- authorized scope paused pending an exact, source-supported trigger;
- proposals or work requiring fresh approval;
- blockers and unresolved questions.

Do not perform, authorize, or list as executable any activity merely because it appears as a question, criticism, discussion, mention, or rejected proposal. Authorization applies per concrete action. Approval for an implementation direction does not authorize later state-changing validation, process or service startup, external effects, cleanup, deletion, publication, or scope expansion.

Never invent completion, permission, facts, paths, or uncertainty. Never reproduce passwords, private keys, API tokens, recovery codes, or other secrets; retain only safe references and handling requirements.

Before returning, check that every authorization label, next step, and task packet agrees with this classification. A paused action must name its exact resumption trigger; if the trigger is absent or ambiguous, classify it as requiring fresh approval. Preserve cumulative history and behavior indexes from incoming handoffs, updating them rather than replacing them with a shorter account. Account for every unresolved earlier user topic and classify it as active, superseded, deferred, resolved, or no longer material.

Preserve the complete cumulative inventory of loaded skills: retain every skill named in an incoming handoff's loaded-skills inventory and add every skill whose full instructions were loaded in the current session. Never remove a loaded skill because its task appears complete or seems irrelevant now. Record each skill's exact \`SKILL.md\` path and any explicit loading or routing constraint already attached to it. Do not add merely available skills that were never loaded and do not invent paths or constraints.

Omit a subsection only when genuinely irrelevant. Keep the final section exactly as specified. Make \`Resume At\` and \`Action\` precise enough that the next session does not stall. "Continue authorized autonomous work" may refer only to work already authorized before the handoff.

Require every replacement session to begin its first visible assistant response with a concise re-entry summary for the user, including during autonomous continuation. The summary must state the latest relevant activity or exchange, the current working state, and the next step or exact reason user input is needed. Include the latest material user question and answer when they determine the present state. After the summary, the replacement must treat any Deferred Prompts as sequential user inputs in their transferred order, then continue the task, answer or ask the user, or wait as required by the latest applicable instruction and authorization. When autonomous continuation is authorized, it must actually perform the next work in that same response rather than merely announce that it will continue. Deferred Prompts may update or supersede the recorded \`Action\`; without a superseding Deferred Prompt, follow \`Action\`.

## Goal and authorization

### Desired outcome
[The user's actual goal and desired end state.]

### Authorized and executable now
[Only work executable now, with exact scope and limits.]

### Authorized scope but currently paused
[Paused work and its exact source-supported resumption trigger. If no trigger exists, place it under fresh approval.]

### Not authorized or requiring fresh approval
[Proposals, undecided choices, external or destructive actions, publication, purchases, or other work lacking current permission.]

## Continuation map

### Read first
[Minimal ordered list of authoritative specifications, plans, indexes, or files, with what each governs. State precedence where sources disagree.]

### Safest next action
[The first concrete authorized action. If execution is paused or approval is ambiguous, ask the required question instead.]

### Current blockers
[Concrete blockers and what would resolve them.]

## Current truth

### Latest-session delta
[What changed in the source session, including "no implementation change" when material.]

### Completed and verified
[Completed results and evidence.]

### Completed but not verified
[Changes lacking sufficient validation.]

### Partial, failed, or reverted
[Incomplete work, defects, failed attempts, reverted approaches, and consequences.]

### Not started
[Important planned or authorized work not yet begun.]

### Working state
[Branch, commit/staging/dirty state, runtime/process state, temporary artifacts, and other continuation-relevant state.]

## History and decisions

### Session history index

| Session or period | Material change or decision | Current consequence/status | Exact reference |
|---|---|---|---|
| [date/label] | [what happened] | [why it matters now] | [path or durable anchor] |

Keep this cumulative and short. Mark earlier topics active, superseded, deferred, resolved, or no longer material when supported.

### Governing decisions and constraints
[Active technical/product decisions, user answers, non-goals, compatibility rules, and reasons. Distinguish current decisions from discarded or superseded ideas.]

### Negative knowledge
[Failed experiments, rejected alternatives, known traps, and evidence preventing repeated work.]

## Active behavioral instructions

[Still-applicable user corrections and preferences not already covered by system/project guidance. Record known supersession relationships and preserve exact wording where paraphrase could change scope or tone.]

## Operational runtime state

Record only session-specific runtime deviations or status, not ordinary project facts or the cumulative \`Loaded skills\` inventory. For each category, write \`None.\` when absent.

- **Skills whose current state matters:** [Only when their current operational state matters; name, exact \`SKILL.md\` path, and state. Otherwise \`None.\`]
- **Subagents:** [Each subagent's ID, mode, status, and result path. Otherwise \`None.\`]
- **Intentionally changed active toolset:** [Describe the change from the normal toolset. Otherwise \`None.\`]
- **Relevant live processes:** [Identify each relevant process and its status. Otherwise \`None.\`]
- **Session-specific behavioral deltas:** [Behavior changed for this session that is not already global. Otherwise \`None.\`]

## Loaded skills

[List the cumulative union of (a) every skill retained in the incoming handoff's loaded-skills inventory and (b) every skill whose full instructions were loaded in this session. For each skill, give its name and exact \`SKILL.md\` path, plus any explicit loading or routing constraint already attached to it. Do not filter by current relevance or task completion. Do not include merely available skills that were never loaded. Write \`None.\` only when no skill was loaded.]

## Working-set inventory

| Path or reference | Purpose | Status | Why needed |
|---|---|---|---|
| [exact path] | [role] | [modified/read/generated/planned/authoritative] | [continuation relevance] |

Include every materially relevant modified, created, deleted, read, generated, or planned file and external reference. Distinguish authoritative sources, temporary notes, and read-only context.

## Validation and evidence

| Check or evidence | Exact result | Scope | Remaining uncertainty |
|---|---|---|---|
| [test/inspection/review] | [pass/fail/not run] | [what it establishes] | [what it does not establish] |

Never convert a partial pass into full validation.

## Upcoming work

List remaining work in real execution order. Label each item:

- **Authorized continuation**
- **Authorized scope but paused — trigger: [exact event]**
- **Planned but approval required**
- **Blocked**

Do not create permission by listing an item here. State-changing validation, process/service startup, external effects, cleanup, deletion, publication, or scope expansion require their own authorization.

## Task packets

For each substantial upcoming task, provide:

### Task: [name]
- **Authorization:** [exact status, limits, and trigger or approval requirement]
- **Current state:** [where it stands]
- **Required outcome:** [observable end state and acceptance]
- **Inputs and constraints:** [read-first paths, dependencies, non-goals, and hazards]
- **Blockers:** [prerequisites or unresolved issues]

A precise link to a sufficient approved plan may replace duplicated detail, but state why it is sufficient.

## Open questions

[Only genuinely unresolved questions, with decision owner and consequence when known.]

## Context catalogue

[Index broader material that may become relevant later: project \`.pi\` documents, plans, audits, research, artifacts, installed documentation, earlier handoffs, and source sessions. For each entry state what it contains and when to consult it.]

## Precision anchors

[Exact user statements, error text, identifiers, paths, versions, or wording where paraphrase could alter meaning, permission, or diagnosis. Keep bounded.]

## Cold context

- **Source session:** \`[exact JSONL path supplied in the writer prompt]\`
- **Incoming handoff/source lineage:** \`[exact references or none]\`
- **When to consult:** [specific gaps that justify loading cold context; do not scan or read the transcript routinely]

Record the exact source-session transcript path supplied in the writer prompt.

## Integrity notes

[Known omissions, unavailable evidence, uncertain claims intentionally excluded, and unverified references. State limitations truthfully.]

## Post-Handoff Initial Action

Mode: Continue authorized questioning | Continue authorized autonomous work | Answer the user | Wait for the user
Resume At: [Exact question, plan step, task, or decision point.]
Action: [Tell the replacement session to begin with the concise user-facing re-entry summary specified above, then state exactly one concrete action to take after applying any Deferred Prompts. Use "None after the summary." only when genuinely no further action is required.]`;

export const BUILT_IN_TEMPLATES: Record<string, string> = {
	call_default: CALL_TEMPLATE,
	handoff_default: HANDOFF_TEMPLATE,
};

/**
 * Resolution order: explicit file path, `<templateDirectory>/<name>.cmpl`,
 * built-in template. A missing explicit request falls back to the built-in
 * default for its role with a warning rather than failing the handoff.
 */
export async function resolveTemplate(
	requested: string,
	templateDirectory: string | null,
	fallbackName: "call_default" | "handoff_default",
): Promise<ResolvedTemplate> {
	const name = expandHome(requested.trim()) || fallbackName;
	const directory = templateDirectory === null ? null : expandHome(templateDirectory);

	const candidates: string[] = [];
	if (isAbsolute(name) || name.includes("/") || name.endsWith(".cmpl")) {
		candidates.push(isAbsolute(name) ? name : resolve(process.cwd(), name));
	}
	if (directory !== null) {
		candidates.push(resolve(directory, `${name}.cmpl`), resolve(directory, name));
	}

	for (const candidate of candidates) {
		try {
			const content = await readFile(candidate, "utf8");
			if (content.trim() === "") {
				return {
					content: BUILT_IN_TEMPLATES[fallbackName],
					source: fallbackName,
					warning: `pi-handoff ignored the empty template file ${candidate}; using ${fallbackName}.`,
				};
			}
			return { content, source: candidate };
		} catch {
			// Try the next candidate.
		}
	}

	const builtIn = BUILT_IN_TEMPLATES[name];
	if (builtIn !== undefined) return { content: builtIn, source: name };

	return {
		content: BUILT_IN_TEMPLATES[fallbackName],
		source: fallbackName,
		warning: `pi-handoff could not find template "${name}"; using ${fallbackName}.`,
	};
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}
