# Agents

This extension ships **no builtin agents** — every subagent is defined by you.

Drop markdown files (YAML frontmatter + system prompt) into:

- `~/.pi/agent/agents/` — user scope, available in every project
- `<cwd>/.pi/agents/` — project scope, wins name collisions

```markdown
---
name: reviewer
description: Code review against the task
tools: read, grep, bash
---

Review the code for the task. Check correctness, tests, edge cases,
and simplicity. Report concrete findings with file/line references.
```

See `docs/configuration.md` for the full frontmatter reference.
