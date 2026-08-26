/**
 * Agent definitions: markdown files with YAML frontmatter on top and a
 * system prompt below — the same shape the reference extension uses.
 *
 * Discovery (lowest to highest priority):
 *   1. `~/.pi/agent/agents/**\/*.md`   (user)
 *   2. `<cwd>/.pi/agents/**\/*.md`     (project; wins runtime-name collisions)
 *
 * No builtin agents are shipped: every agent is user- or project-defined.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDef } from "./types.ts";

const USER_AGENT_DIR = path.join(os.homedir(), ".pi", "agent", "agents");

/* ------------------------------------------------------------------ */
/* Frontmatter parsing (no YAML dependency)                            */
/* ------------------------------------------------------------------ */

export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized.trim() };
  }

  // Find the closing fence: a line that starts with `---`.
  const lines = normalized.split("\n");
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimStart().startsWith("---")) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { frontmatter, body: normalized.trim() };
  }

  const block = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n").trim();

  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentKey !== null) {
      frontmatter[currentKey] = currentLines.join("\n").replace(/^\n+|\s+$/g, "");
      currentKey = null;
      currentLines = [];
    }
  };

  for (const rawLine of block) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      if (currentKey !== null) currentLines.push("");
      continue;
    }
    // Continuation of a block list or folded value (indented).
    if (currentKey !== null && (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("- "))) {
      currentLines.push(line.trim());
      continue;
    }
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      flush();
      const key = match[1]!;
      let rawValue = match[2]!.trim();
      if (
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ) {
        rawValue = rawValue.slice(1, -1);
      }
      if (rawValue === "" || rawValue === ">" || rawValue === ">-" || rawValue === "|" || rawValue === "|-") {
        currentKey = key;
        currentLines = [];
      } else {
        frontmatter[key] = rawValue;
      }
    }
    // Non-matching lines are ignored (comments etc.).
  }
  flush();

  return { frontmatter, body };
}

/** Parse a comma-separated or block-list scalar into an array. */
export function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      const listItem = trimmed.match(/^-\s+(.+)$/);
      return (listItem?.[1] ?? trimmed).split(",");
    })
    .map((value) => value.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function toInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.trim() !== "false";
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

function walk(dir: string, visit: (file: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
      visit(full);
    }
  }
}

function readAgentFile(file: string, scope: "user" | "project"): AgentDef | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = parseFrontmatter(content);
  const name = frontmatter.name?.trim();
  // Skip unfilled templates: agent files generated from _templates/ carry
  // `name: {{DOMAIN_SLUG}}` until /wiki-shard replaces the placeholders.
  if (!name || name.includes("{{")) return undefined;
  return {
    name,
    aliases: parseList(frontmatter.aliases) ?? [],
    description: frontmatter.description || undefined,
    tools: parseList(frontmatter.tools),
    extensions: parseList(frontmatter.extensions),
    model: frontmatter.model || undefined,
    thinking: frontmatter.thinking || undefined,
    systemPromptMode: frontmatter.systemPromptMode === "append" ? "append" : "replace",
    inheritProjectContext: parseBool(frontmatter.inheritProjectContext, true),
    inheritSkills: parseBool(frontmatter.inheritSkills, false),
    defaultContext:
      frontmatter.defaultContext === "fork"
        ? "fork"
        : frontmatter.defaultContext === "fresh"
          ? "fresh"
          : undefined,
    timeoutMs: toInt(frontmatter.timeoutMs),
    async: frontmatter.async === "true" ? true : frontmatter.async === "false" ? false : undefined,
    body,
    filePath: file,
    scope,
  };
}

/** Discover all agents for a cwd. Project definitions win name collisions. */
export function discoverAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  const collect = (dir: string, scope: "user" | "project"): void => {
    if (!fs.existsSync(dir)) return;
    walk(dir, (file) => {
      const def = readAgentFile(file, scope);
      if (!def) return;
      const prev = byName.get(def.name);
      if (!prev || scope === "project") byName.set(def.name, def);
    });
  };
  collect(USER_AGENT_DIR, "user");
  collect(path.join(cwd, ".pi", "agents"), "project");
  return [...byName.values()];
}

/** Resolve an agent by canonical name or alias. */
export function findAgent(name: string, cwd: string): AgentDef | undefined {
  const agents = discoverAgents(cwd);
  const canonical = agents.find((agent) => agent.name === name);
  if (canonical) return canonical;
  return agents.find((agent) => agent.aliases.includes(name));
}

/** Format a compact listing line for `subagent({ action: "list" })`. */
export function formatAgentLine(agent: AgentDef): string {
  const parts = [agent.name];
  if (agent.description) parts.push(`— ${agent.description}`);
  const meta: string[] = [];
  if (agent.model) meta.push(`model=${agent.model}`);
  if (agent.thinking) meta.push(`thinking=${agent.thinking}`);
  if (agent.tools) meta.push(`tools=${agent.tools.join(",")}`);
  if (agent.defaultContext) meta.push(`context=${agent.defaultContext}`);
  if (agent.timeoutMs) meta.push(`timeoutMs=${agent.timeoutMs}`);
  if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
  return parts.join(" ");
}
