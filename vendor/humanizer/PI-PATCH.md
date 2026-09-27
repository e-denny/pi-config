# Pi adaptation notes

Upstream: https://github.com/apoapostolov/humanizer (MIT).
This directory is the pristine upstream tree, vendored for diffing. The
installed, Pi-adapted copies live in `~/.pi/agent/skills/`:

| Skill | Installed path |
| --- | --- |
| `humanizer` | `~/.pi/agent/skills/humanizer/` |
| `simple-english` | `~/.pi/agent/skills/simple-english/` |
| `ai-writing-detector` | `~/.pi/agent/skills/ai-writing-detector/` |
| `writing-prose` | `~/.pi/agent/skills/writing-prose/` |
| `writing-voice` | `~/.pi/agent/skills/writing-voice/` |

## What changed for Pi

1. **Frontmatter normalized to the Agent Skills spec.** `category`, `tags`,
   `version`, and `related_skills` moved under `metadata:`. Top-level keys are
   now only `name`, `description`, `license`, `compatibility`, `metadata`.
   Upstream's extra keys were ignored by Pi (unknown keys are not validated),
   but the spec-compliant form is portable.
2. **Descriptions rewritten for routing.** Pi selects skills from the
   description alone, so each one now states what the skill does *and* when it
   applies ("Use when ...").
3. **`license: MIT` added**, and the upstream LICENSE copied into each skill
   directory. `ai-writing-detector` keeps its own vendored engine LICENSE.
4. **`compatibility` added** where a runtime is needed: Python 3
   (`simple-english`, detector hosted spread), Node >= 18
   (`ai-writing-detector`), Vale CLI (`writing-prose`).
5. **`agents/openai.yaml` removed.** That is Codex/OpenAI interface metadata;
   Pi has no equivalent and ignores it.
6. **Hardcoded install paths replaced.** `~/.hermes/skills/...` and
   `~/.config/agents/skills/...` became `~/.pi/...` paths or skill-directory
   references. The write-up now points at the `VALE_BIN` / `VALE_CONFIG`
   overrides that `scripts/vale-lint.sh` already supported.
7. **Monorepo-only references made standalone.** Pointers to the upstream
   repository root `SOURCES.md`, `.github/workflows`, and the `skills.sh`
   installer now describe upstream as upstream, and pin lookup points at
   `~/.pi/vendor/humanizer/SOURCES.md`.
8. **Cross-skill relative links** (`../humanizer/references/...`,
   `[../SKILL.md](../SKILL.md)`) were kept: they resolve because all five
   skills are installed side by side. The one exception, `writing-voice`'s link
   into `humanizer`, now names the sibling skill instead of assuming a shared
   parent directory.

Nothing in the instruction bodies was rewritten otherwise. No factual claims,
rules, or reference material were altered.

## Verified

- `python3 simple-english/scripts/voice_lint.py <file>` — runs, reports counts.
- `node ai-writing-detector/scripts/analyze.js <file>` — runs, emits
  `signals_only` report.
- `node ai-writing-detector/scripts/validate-cli.js before.md after.md` — runs.
- `bash ai-writing-detector/scripts/smoke.sh` — 17 passed, 0 failed.
- `bash writing-prose/scripts/vale-lint.sh <file>` — Vale 3.23.0 at
  `~/.local/bin/vale`; reports error-level violations (em dash, spelling) and
  exits 1, warnings do not block.
- House vocabulary seeded from `book/drafts/why-marx-still-matters`: 423 entries
  appended to `vale/styles/config/vocabularies/Hermes/accept.txt`, taking
  `Vale.Spelling` on those drafts from 2,665 flags (487 unique) to 12 flags
  (9 unique), all of them genuine typos left in on purpose.

## Known Pi-specific caveats

- **`writing-voice` is not always-on.** Upstream assumes a host that loads it
  at session start. Pi loads skills on demand, so invoke `/skill:writing-voice`
  or point at it from an `AGENTS.md` if you want the mode rules present in
  every session.
- **`writing-prose` needs Vale.** Installed here as a user-local static binary
  at `~/.local/bin/vale` (Vale 3.23.0, `~/.local/bin` is on `PATH`). Remove it
  with `rm ~/.local/bin/vale`; Arch users can instead take `extra/vale` from
  pacman. The Microsoft and HermesHouse style packs ship inside the skill, so
  `vale sync` is only needed to refresh them. To silence proper names and
  domain terms, add them to
  `vale/styles/config/vocabularies/Hermes/accept.txt`.
- **Vale vocab mechanics** (verified empirically, worth knowing before editing
  `accept.txt`): matching is case-insensitive, so one entry silences every
  casing; possessives are covered by the base entry (`Harman` also accepts
  `Harman's`); plurals are *not* (`Microsoft` does not accept `Microsofts`), so
  both forms are listed. Plain entries double as casing authorities under
  `Vale.Terms`; `(?i)` regex entries are ignored by that rule, which is why
  jargon uses `(?i)` and names do not. The house config sets `Vale.Terms = NO`.
- **Overlapping skills** already installed: `~/.pi/agent/skills/human-voice`
  and the project-local `.pi/skills/humanize-writing` cover ground similar to
  `humanizer`. Names differ, so all of them load; pick one per job rather than
  stacking them.

## Updating from upstream

```bash
git clone --depth 1 https://github.com/apoapostolov/humanizer /tmp/humanizer
# diff before overwriting: the Pi edits in agent/skills/ are the only delta
diff -ru /home/edgar/.pi/vendor/humanizer/skills/humanizer \
         /home/edgar/.pi/agent/skills/humanizer
```

Re-apply the changes above to any upstream file you refresh.
