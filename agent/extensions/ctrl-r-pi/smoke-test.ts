/**
 * Headless smoke test for ctrl-r-pi.
 * Run with: bun smoke-test.ts
 *
 * Covers prompt capture, de-duplication, the 400-entry cap, slash/extension
 * skipping, and restoring a fuzzy-filtered selection through the shortcut.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "ctrl-r-pi-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const extension = await import("./index.ts");

type Handler = (event: unknown, ctx?: unknown) => unknown;

function createFakePi() {
	const handlers: Record<string, Handler> = {};
	let shortcut: { description?: string; handler: (ctx: unknown) => Promise<void> | void } | undefined;
	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
			return () => {};
		},
		registerShortcut(_key: string, options: typeof shortcut) {
			shortcut = options;
		},
	};
	return {
		pi: pi as never,
		handlers,
		getShortcut: () => shortcut,
	};
}

function readPrompts(): string[] {
	const raw = readFileSync(join(agentDir, "ctrl-r-pi-history.json"), "utf-8");
	return JSON.parse(raw).prompts as string[];
}

const { pi, handlers, getShortcut } = createFakePi();
extension.default(pi);

// --- capture, de-duplication, skips ---------------------------------------
handlers.session_start?.({ type: "session_start" });
handlers.input?.({ type: "input", text: "first prompt", source: "interactive" });
handlers.input?.({ type: "input", text: "second prompt", source: "interactive" });
handlers.input?.({ type: "input", text: "first prompt", source: "interactive" });
handlers.input?.({ type: "input", text: "/model", source: "interactive" });
handlers.input?.({ type: "input", text: "from another extension", source: "extension" });

assert.deepEqual(readPrompts(), ["first prompt", "second prompt"], "dedupe, most-recent-first, and skips");

// --- 400-entry cap ---------------------------------------------------------
for (let i = 0; i < 405; i++) {
	handlers.input?.({ type: "input", text: `prompt ${i}`, source: "interactive" });
}
const capped = readPrompts();
assert.equal(capped.length, 400, "history is capped at 400 entries");
assert.equal(capped[0], "prompt 404", "newest prompt is first");
assert.equal(capped.includes("prompt 404") && capped.includes("prompt 5"), true);
assert.equal(capped.includes("prompt 4"), false, "oldest entries are dropped");

// --- shortcut restores a fuzzy-filtered selection --------------------------
const shortcut = getShortcut();
assert.ok(shortcut, "shortcut was registered");

handlers.session_start?.({ type: "session_start" });
handlers.input?.({ type: "input", text: "deploy the widget service", source: "interactive" });
handlers.input?.({ type: "input", text: "review the widget tests", source: "interactive" });

let component: { handleInput(data: string): void } | undefined;
let restored: string | undefined;
let notified: string | undefined;

const fakeCtx = {
	mode: "tui",
	ui: {
		notify: (message: string) => {
			notified = message;
		},
		setEditorText: (text: string) => {
			restored = text;
		},
		custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: string | null) => void) => unknown) =>
			new Promise<string | null>((resolve) => {
				const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
				const tui = { requestRender: () => {} };
				component = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), resolve) as typeof component;
			}),
	},
};

const handlerPromise = Promise.resolve(shortcut!.handler(fakeCtx));
assert.ok(component, "overlay component was created");

// Empty query + Down + Enter -> second-newest prompt.
component!.handleInput("\x1b[B");
component!.handleInput("\r");
await handlerPromise;
assert.equal(restored, "deploy the widget service", "Down moves to the second entry");
assert.equal(notified, undefined);

// Fuzzy filter: type "tests" then Enter -> matching prompt restored.
component = undefined;
restored = undefined;
const handlerPromise2 = Promise.resolve(shortcut!.handler(fakeCtx));
for (const char of "tests") component!.handleInput(char);
component!.handleInput("\r");
await handlerPromise2;
assert.equal(restored, "review the widget tests", "fuzzy filter narrows the list");

// Escape closes the overlay without touching the editor.
component = undefined;
restored = undefined;
const handlerPromise3 = Promise.resolve(shortcut!.handler(fakeCtx));
component!.handleInput("\x1b");
await handlerPromise3;
assert.equal(restored, undefined, "Escape cancels without restoring");

rmSync(agentDir, { recursive: true, force: true });
console.log("ctrl-r-pi smoke test: OK");
