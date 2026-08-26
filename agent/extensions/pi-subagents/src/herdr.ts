/**
 * Herdr tab integration — open a run's live working view in a new herdr tab.
 *
 * herdr (https://herdr.dev) is a terminal workspace manager for AI agent
 * panes. pi itself typically runs inside a herdr pane, so the extension talks
 * to the running herdr server over its CLI (spawned with shell:false via
 * pi.exec — no quoting hazards). Flow per run:
 *
 *   1. `herdr tab create --label <agent> --cwd <run cwd> --no-focus`
 *      → JSON response: { result: { root_pane: { pane_id }, tab: { tab_id } } }
 *      `--no-focus` keeps input in pi ("brings me back to the prompt"); the
 *      new tab appears in the tab bar ready to click.
 *   2. `herdr pane run <pane_id> node <viewer> <runDir>`
 *      → types the viewer command into the tab's shell; the viewer tails the
 *      run's output.log live with JSONL→readable rendering.
 *
 * Disabled implicitly when herdr is not installed: config `herdrCommand`
 * (default "herdr") can point at a different binary, and every call degrades
 * to a clear error surfaced as a notify.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "./config.ts";
import type { RunStatus } from "./types.ts";

export const HERDR_TAB_PREFIX = "subagent";

/** Resolve the herdr binary to use (config `herdrCommand`, default "herdr"). */
export function resolveHerdrCommand(config: ExtensionConfig): string {
  return config.herdrCommand ?? "herdr";
}

/** Absolute path to the live viewer script shipped with this extension. */
export function viewerScriptPath(): string {
  // src/herdr.ts -> project root -> scripts/subagent-view.mjs
  return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "scripts", "subagent-view.mjs");
}

export interface HerdrTabOpen {
  tabId: string;
  paneId: string;
  label: string;
}

/**
 * Open a new (unfocused) herdr tab running the live viewer for `status`.
 * Resolves with the created tab/pane ids; throws a descriptive Error on
 * any herdr failure so callers can surface it as a notification.
 */
export async function openRunInHerdrTab(
  pi: ExtensionAPI,
  status: RunStatus,
  config: ExtensionConfig,
): Promise<HerdrTabOpen> {
  const herdr = resolveHerdrCommand(config);
  const label = `${HERDR_TAB_PREFIX} · ${status.agent}`;

  const created = await pi.exec(
    herdr,
    ["tab", "create", "--label", label, "--cwd", status.cwd, "--no-focus"],
    { timeout: 15000 },
  );
  if (created.code !== 0) {
    throw new Error(`herdr tab create: ${trimmed(created.stderr) || trimmed(created.stdout) || `exit ${created.code}`}`);
  }

  let parsed: {
    result?: { root_pane?: { pane_id?: string }; tab?: { tab_id?: string } };
  } = {};
  try {
    parsed = JSON.parse(created.stdout) as typeof parsed;
  } catch {
    throw new Error(`herdr tab create: unexpected response: ${created.stdout.slice(0, 200)}`);
  }
  const paneId = parsed.result?.root_pane?.pane_id;
  const tabId = parsed.result?.tab?.tab_id;
  if (!paneId || !tabId) {
    throw new Error(`herdr tab create: missing pane/tab id in ${created.stdout.slice(0, 200)}`);
  }

  const viewer = viewerScriptPath();
  const ran = await pi.exec(
    herdr,
    ["pane", "run", paneId, "node", viewer, status.asyncDir],
    { timeout: 10000 },
  );
  if (ran.code !== 0) {
    throw new Error(`herdr pane run: ${trimmed(ran.stderr) || trimmed(ran.stdout) || `exit ${ran.code}`}`);
  }

  return { tabId, paneId, label };
}

function trimmed(text: string): string {
  return text.trim();
}
