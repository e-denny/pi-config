/**
 * Extension entry shim.
 *
 * The real factory lives in src/index.ts; this root-level entry exists so pi
 * labels the extension "pi-subagents" in the startup Extensions list instead
 * of "src". pi derives local-extension labels from the entry file's path and
 * strips a trailing index.ts before taking the shortest unique path suffix,
 * so the entry must be <root>/index.ts for the package directory name to
 * surface.
 */
export { default } from "./src/index.ts";
