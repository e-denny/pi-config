// Runtime smoke test for pi-prompt-box. Uses the REAL pi packages (bun resolves
// them from its cache), with identity theme/borderColor so width math is plain.
// Run with: bun smoke-test.ts
import { stripTerminalSequences, visibleWidth } from "/home/edgar/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

const NOOP_THEME = { fg: (_color, text) => text };
const NOOP_BORDER = (s) => s;

const events = {};
const captured = {};
const pi = { on: (ev, fn) => { events[ev] = fn; } };

const mod = await import("file:///home/edgar/.pi/agent/extensions/pi-prompt-box/index.ts");
mod.default(pi);

function bootSession(overrides = {}) {
	events.session_start({ type: "session_start", reason: "startup" }, {
		mode: "tui",
		cwd: "/home/edgar/Documents/llm-wiki",
		sessionManager: {
			getCwd: () => "/home/edgar/Documents/llm-wiki",
			getSessionName: () => "deep-dive",
			getEntries: () => [
				{ type: "message", message: { role: "assistant", usage: { input: 1234, output: 3456, cacheRead: 5000, cacheWrite: 1000, cost: { total: 0.0123 } } } },
			],
		},
		model: { id: "deepseek-v4-flash", provider: "deepseek", reasoning: true, contextWindow: 200000 },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 24567, contextWindow: 200000, percent: 12.3 }),
		ui: {
			theme: NOOP_THEME,
			setFooter: (factory) => {
				captured.footer = factory({}, NOOP_THEME, {
					getGitBranch: () => "main",
					getAvailableProviderCount: () => 1,
					onBranchChange: (cb) => { captured.onBranch = cb; return () => {}; },
				});
			},
			setEditorComponent: (factory) => {
				captured.editor = factory({ terminal: { rows: 40 } }, { borderColor: NOOP_BORDER, selectList: {} }, {});
			},
		},
		...overrides,
	});
}

bootSession();
const editor = captured.editor;
if (!editor) throw new Error("editor not created");

const renderAt = (w) => editor.render(w).map((l) => stripTerminalSequences(l));

function check(label, cond, detail) {
	if (!cond) throw new Error(`FAIL ${label}: ${detail}`);
	console.log(`  ok: ${label}`);
}

// ── Tier 1: padded three sections (wide terminal) ──────────────────────────
const w140 = renderAt(140);
console.log("=== width 140 (tier 1: padded) ===");
w140.forEach((l) => console.log(`  ${JSON.stringify(l)}  vis=${visibleWidth(l)}`));
const info140 = w140[w140.length - 1];
check("info140 fills width", visibleWidth(info140) === 140, `vis=${visibleWidth(info140)}`);
check("tier1 left padded", info140.includes("(main) ─"), info140);
check("tier1 middle padded", info140.includes("─ ↑1.2k"), info140);
check("tier1 right padded", info140.includes("─ ds-v4-flash"), info140);
check("abbreviated model ds-v4-flash", info140.includes("ds-v4-flash"), info140);
check("no dot between model and thinking", info140.includes("ds-v4-flash high") && !info140.includes("• high"), info140);
check("full context 12.3%/200k", info140.includes("12.3%/200k"), info140);
check("full session name", info140.includes("• deep-dive"), info140);
check("cache hit CH69.1%", info140.includes("CH69.1%"), info140);
check("cost $0.012", info140.includes("$0.012"), info140);
check("corners", info140.startsWith("╰─") && info140.endsWith("─╯"), info140);
check("no footer line in tier1", w140.length === 3, `lines=${w140.length}`);

// ── Tier 2: unpadded three sections ────────────────────────────────────────
const w105 = renderAt(105);
console.log("=== width 105 (tier 2: unpadded) ===");
w105.forEach((l) => console.log(`  ${JSON.stringify(l)}  vis=${visibleWidth(l)}`));
const info110 = w105[w105.length - 1];
check("info110 fills width", visibleWidth(info110) === 105, `vis=${visibleWidth(info110)}`);
check("tier2 no padding around left", info110.includes("(main)─"), info110);
check("tier2 no padding around middle", info110.includes("─↑1.2k"), info110);
check("tier2 no padding around right", info110.includes("─ds-v4-flash"), info110);
check("tier2 still has middle", info110.includes("12.3%/200k"), info110);

// ── Tier 3: middle moves to a footer line ──────────────────────────────────
const w80 = renderAt(80);
console.log("=== width 80 (tier 3: middle on footer line) ===");
w80.forEach((l) => console.log(`  ${JSON.stringify(l)}  vis=${visibleWidth(l)}`));
check("tier3 renders 4 lines", w80.length === 4, `lines=${w80.length}`);
const box80 = w80[2];
const foot80 = w80[3];
check("tier3 box keeps cwd", box80.includes("~/D/llm-wiki (main)"), box80);
check("tier3 box keeps model", box80.includes("ds-v4-flash high"), box80);
check("tier3 box drops middle", !box80.includes("↑1.2k"), box80);
check("tier3 footer has usage", foot80.includes("↑1.2k ↓3.5k R5.0k W1.0k"), foot80);
check("tier3 footer has context", foot80.includes("12.3%/200k"), foot80);
check("tier3 footer no rails", !foot80.includes("│"), foot80);
check("tier3 box corners", box80.startsWith("╰─") && box80.endsWith("─╯"), box80);

// ── Tier 3 with truncation (very narrow) ───────────────────────────────────
const w35 = renderAt(35);
console.log("=== width 35 (tier 3 + truncation) ===");
w35.forEach((l) => console.log(`  ${JSON.stringify(l)}  vis=${visibleWidth(l)}`));
check("info40 fills width", visibleWidth(w35[2]) === 35, `vis=${visibleWidth(w35[2])}`);
check("info40 corners kept", w35[2].startsWith("╰─") && w35[2].endsWith("─╯"), w35[2]);
check("info40 cwd kept", w35[2].includes("~/D/llm-wiki"), w35[2]);
check("info40 footer line present", w35.length === 4, `lines=${w35.length}`);
check("info40 footer truncated to width", visibleWidth(w35[3]) <= 35, `vis=${visibleWidth(w35[3])}`);

const w10 = renderAt(10);
console.log("=== width 10 ===");
w10.forEach((l) => console.log(`  ${JSON.stringify(l)}  vis=${visibleWidth(l)}`));
check("no crash at width 10", w10.length >= 3, "lines=" + w10.length);

// ── Empty session: home dir, no model, no usage ────────────────────────────
bootSession({
	cwd: "/home/edgar",
	sessionManager: { getCwd: () => "/home/edgar", getSessionName: () => undefined, getEntries: () => [] },
	model: undefined,
	thinkingLevel: undefined,
	getContextUsage: () => undefined,
});
const e2 = captured.editor;
const w60 = e2.render(60).map((l) => stripTerminalSequences(l));
console.log("=== width 60, home dir, no model ===");
w60.forEach((l) => console.log(`  ${JSON.stringify(l)}  vis=${visibleWidth(l)}`));
const info2 = w60[w60.length - 1];
check("home shows as ~", info2.includes("~"), info2.slice(0, 16));
check("empty context shows 0.0%/0", info2.includes("0.0%/0"), info2);
check("no-model shown", info2.includes("no-model"), info2);
check("info2 fills width", visibleWidth(info2) === 60, `vis=${visibleWidth(info2)}`);

// ── Unknown provider keeps the id, multi-provider prefix ───────────────────
bootSession({
	cwd: "/x",
	sessionManager: { getCwd: () => "/x", getSessionName: () => undefined, getEntries: () => [] },
	model: { id: "custom-model-1", provider: "mycorp", reasoning: false, contextWindow: 200000 },
	thinkingLevel: undefined,
	getContextUsage: () => undefined,
});
// force provider count 2 by re-running the footer factory
events.session_start({ type: "session_start", reason: "startup" }, {
	mode: "tui", cwd: "/x", sessionManager: { getCwd: () => "/x", getSessionName: () => undefined, getEntries: () => [] },
	model: { id: "custom-model-1", provider: "mycorp", reasoning: false, contextWindow: 200000 },
	thinkingLevel: undefined, getContextUsage: () => undefined,
	ui: {
		theme: NOOP_THEME,
		setFooter: (factory) => { factory({}, NOOP_THEME, { getGitBranch: () => null, getAvailableProviderCount: () => 2, onBranchChange: () => () => {} }); },
		setEditorComponent: (factory) => { captured.editor = factory({ terminal: { rows: 40 } }, { borderColor: NOOP_BORDER, selectList: {} }, {}); },
	},
});
const wP = captured.editor.render(90).map((l) => stripTerminalSequences(l));
console.log("=== unknown provider, count 2, no reasoning ===");
console.log(`  ${JSON.stringify(wP[wP.length - 1])}`);
check("unknown provider id unchanged", wP[wP.length - 1].includes("custom-model-1"), wP[wP.length - 1]);
check("provider prefix (mycorp)", wP[wP.length - 1].includes("(mycorp) custom-model-1"), wP[wP.length - 1]);
check("no thinking suffix when not reasoning", !wP[wP.length - 1].includes("thinking"), wP[wP.length - 1]);

// branch-change callback fires safely
captured.onBranch();
console.log("  ok: onBranchChange callback safe");

console.log("\nALL SMOKE TESTS PASSED");
