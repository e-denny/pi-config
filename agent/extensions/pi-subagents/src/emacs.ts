/**
 * Emacs integration — open a run's live working view in the user's running
 * Emacs instance.
 *
 * pi's RPC channel (the one pilish speaks) is a fixed client<->pi protocol:
 * extensions only get the documented `ctx.ui` requests (`notify`, `setStatus`,
 * `setWidget`, ...), and there is no extension->client "open a buffer"
 * method. So this uses Emacs' own server bridge instead, exactly like an
 * editor integration would: `emacsclient --eval`, spawned with shell:false
 * through `pi.exec`, so paths and agent names are passed as Elisp string
 * literals rather than shell words.
 *
 * The evaluated form calls `pi-subagents-open-run` from the companion Emacs
 * package shipped at `emacs/pi-subagents.el`. That package starts the run's
 * viewer (`scripts/subagent-view.mjs`) in a `term` buffer and displays it in
 * a new window (default) or frame of the existing Emacs instance.
 *
 * Requires a running Emacs server (`M-x server-start`). When pi itself runs
 * inside an Emacs terminal (ghostel sets `INSIDE_EMACS=ghostel`), the server
 * is what lets the view appear in that same instance instead of a separate
 * Emacs; the error message says exactly that.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "./config.ts";
import type { RunStatus } from "./types.ts";

export const EMACS_BUFFER_PREFIX = "subagent";

/** Resolve the emacsclient binary (config `emacsclientCommand`, default "emacsclient"). */
export function resolveEmacsclientCommand(config: ExtensionConfig): string {
  return config.emacsclientCommand ?? "emacsclient";
}

function extensionRoot(): string {
  // src/emacs.ts -> project root
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** Absolute path to the live viewer script shipped with this extension. */
export function viewerScriptPath(): string {
  return path.join(extensionRoot(), "scripts", "subagent-view.mjs");
}

/** Absolute path to the companion Emacs package directory. */
export function emacsPackageDir(): string {
  return path.join(extensionRoot(), "emacs");
}

/** Human-facing base name for the run's Emacs buffer (make-term adds the stars). */
export function runBufferName(status: RunStatus): string {
  return `${EMACS_BUFFER_PREFIX}: ${status.agent} (${status.runId.slice(0, 8)})`;
}

export interface EmacsViewOpen {
  bufferName: string;
  /** Explicit display override from config, if any. */
  display?: "window" | "frame";
}

/** Quote a JavaScript string as an Emacs Lisp string literal. */
function elispString(value: string): string {
  return JSON.stringify(value);
}

function buildOpenForm(options: {
  bufferName: string;
  node: string;
  viewer: string;
  runDir: string;
  packageDir: string;
  display?: "window" | "frame";
}): string {
  const display =
    options.display === "window"
      ? "'window"
      : options.display === "frame"
        ? "'frame"
        : "nil";
  const missingMessage =
    `pi-subagents: Emacs package not found; add ${options.packageDir} ` +
    `to load-path and (require 'pi-subagents) in init.el`;
  return `(progn
  (unless (fboundp 'pi-subagents-open-run)
    (add-to-list 'load-path ${elispString(options.packageDir)})
    (require 'pi-subagents nil t))
  (unless (fboundp 'pi-subagents-open-run)
    (error ${elispString(missingMessage)}))
  (pi-subagents-open-run ${elispString(options.bufferName)} ${elispString(options.node)} ${elispString(options.viewer)} ${elispString(options.runDir)} ${display}))`;
}

/**
 * Open (or focus) the live viewer for `status` in the running Emacs instance.
 * Resolves with the buffer name; throws a descriptive Error on any failure
 * so callers can surface it as a notification.
 */
export async function openRunInEmacs(
  pi: ExtensionAPI,
  status: RunStatus,
  config: ExtensionConfig,
): Promise<EmacsViewOpen> {
  const client = resolveEmacsclientCommand(config);
  if (!client) {
    throw new Error("Emacs integration disabled (emacsclientCommand is empty)");
  }

  const bufferName = runBufferName(status);
  const form = buildOpenForm({
    bufferName,
    node: process.execPath,
    viewer: viewerScriptPath(),
    runDir: status.asyncDir,
    packageDir: emacsPackageDir(),
    display: config.emacsDisplay,
  });
  const args = [...(config.emacsclientArgs ?? []), "--eval", form];

  let result;
  try {
    result = await pi.exec(client, args, { timeout: 20000 });
  } catch (error) {
    throw new Error(
      `${client}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (result.code !== 0) {
    throw new Error(describeFailure(client, result.stderr, result.stdout, result.code));
  }

  return { bufferName, display: config.emacsDisplay };
}

function describeFailure(client: string, stderr: string, stdout: string, code: number): string {
  const combined = [stderr, stdout]
    .filter((text) => text.trim())
    .join("\n");

  const noServer =
    /can't find socket|No socket or alternate editor|Connection refused/i.test(combined);
  if (noServer) {
    const inside = process.env.INSIDE_EMACS
      ? ` (pi is inside Emacs: INSIDE_EMACS=${process.env.INSIDE_EMACS})`
      : "";
    return (
      `no Emacs server reachable${inside}. Start it with M-x server-start — ` +
      `and add (require 'server) (unless (server-running-p) (server-start)) ` +
      `to init.el so it starts with Emacs.`
    );
  }

  const detail = combined
    .split("\n")
    .map((line) => line.replace(/^emacsclient:\s*/, "").trim())
    .filter((line) => line && !line.startsWith("--") && !/^Please use:?$/.test(line))
    .slice(0, 4)
    .join(" ")
    .trim();

  return detail || `${client} exited ${code}`;
}
