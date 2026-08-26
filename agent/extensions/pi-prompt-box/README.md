# pi-prompt-box

Draws the prompt input area as a rounded-corner box and **folds the footer
into the box's bottom line**:

```
╭──────────────────────────────────────────────────────────╮
│ type your prompt here                                     │
╰─ ~/D/llm-wiki (main) ── ↑1.2k ↓3.4k 12.3%/200k ── ds-v4-flash high ─╯
```

The bottom line has three sections separated by horizontal (`─`) runs that
stretch to fill the width:

- **left** — working directory + git branch
- **middle** — token usage (`↑` input, `↓` output, `R` cache-read,
  `W` cache-write, `CH` cache hit %, `$` cost), context usage
  (`12.3%/200k`, colored red/warning past 70%/90%), session name
- **right** — model id + thinking level (provider prefix when several
  providers are configured)

The corner glyphs (`╰ ╯`) with a single `─` right after/before them frame the
line, so the box keeps its rounded bottom corners. The built-in footer below
the prompt is hidden because its content now lives in the box (this also
hides extension statuses set via `ctx.ui.setStatus()`).

### Model abbreviation

Known providers are shortened in the model id, so `deepseek-v4-flash` shows
as `ds-v4-flash`:

```
deepseek → ds      anthropic → a      openai → oai      google → g
gemini  → gm       mistral → m        groq → gq         xai → x
qwen    → q        kimi → k           together → tg
```

Unknown providers keep the id unchanged. There is no `•` between the model
and its thinking level (`ds-v4-flash high`).

### Path abbreviation

Every folder except the last is abbreviated to its first character
(hidden folders keep their dot):

```
~/Documents/llm-wiki/  →  ~/D/llm-wiki
~/Projects/.config/pi  →  ~/P/.c/pi
/home/edgar/work/pi    →  /h/e/w/pi
```

### Overflow tiers

When the info is too long for a single line, the bottom line degrades
instead of truncating first:

1. **Padded** three sections: `╰─ L ── M ── R ─╯`
2. **Unpadded** three sections: `╰─L────M────R─╯` (spaces removed)
3. The usage/session **middle moves to a separate footer line** below the
   box; cwd + model stay on the box line. If even that is too long, the
   right (model) section is truncated first, then the left (cwd).

The box also keeps the other editor features: multi-line input, word
wrapping, vertical scrolling (the `─── ↑ N more ───` indicator stays inside
the top border), autocomplete dropdowns, the fake cursor, and IME
hardware-cursor positioning.

## Install

The extension lives in `~/.pi/agent/extensions/pi-prompt-box/` and is
auto-discovered by pi. Restart pi or run `/reload` to activate it.

To make it project-local instead, move the folder to `.pi/extensions/`
inside the project.

## Configuration

Optional glyph overrides in `~/.config/pi-prompt-box.json` (or
`$XDG_CONFIG_HOME/pi-prompt-box.json`). All fields are optional; every glyph
must be a single-width cell, otherwise the default is kept.

```json
{
  "topLeft": "╭",
  "topRight": "╮",
  "bottomLeft": "╰",
  "bottomRight": "╯",
  "horizontal": "─",
  "vertical": "│"
}
```

The defaults (`╭ ╮ ╰ ╯`) are box-drawing arc corners, present in the
standard box-drawing block of every Nerd Font (U+2500–U+2570) and most
monospace fonts. If your font lacks them or you prefer a different look,
swap in your own glyphs (e.g. heavy lines `┏ ┓ ┗ ┛` or `━ ┃`).

## How it works

`PromptBoxEditor` extends `CustomEditor` and overrides `render(width)`:

1. Asks the base editor to lay out text at `width - 2` columns, leaving room
   for the side bars.
2. Locates the bottom border by scanning rendered lines from the end — the
   real border always sits below every content line, so autocomplete rows
   appended below it are never mistaken for it.
3. Wraps the top border in corner glyphs (preserving scroll indicators) and
   every content / autocomplete row in vertical bars.
4. Replaces the bottom border with the footer line (`buildBottomLines`):
   three sections joined by flex `─` separators, framed by `╰─ … ─╯`,
   degrading through the overflow tiers (padded → unpadded → usage/session
   on a footer line below the box).
5. Re-styles everything through `this.borderColor`, so bash mode and
   thinking-level border colors keep working.

The footer data is read live per render from the session context (cwd,
entries for usage totals, model, thinking level, context usage) plus the
`FooterDataProvider` captured via `setFooter` (git branch, provider count).
The editor is invalidated on `message_end`, `model_select`,
`thinking_level_select`, `session_info_changed`, and git branch changes, so
the bottom line stays current without waiting for the next keystroke.

## Smoke test

`smoke-test.ts` exercises the layout logic against the real pi-tui renderer:

```sh
bun smoke-test.ts
```

It checks width filling, path abbreviation, section placement, truncation
priority, and corner preservation across several terminal widths.
