#!/usr/bin/env python3
"""
reflow-markdown.py — Reflow prose lines in a markdown file to a maximum width.

Surgical: only blocks that contain a line longer than the width (or a wikilink
split across lines) are rewritten; compliant blocks pass through byte-identical.

Wraps (whole-word, filling close to the limit):
  - prose paragraphs
  - block quotes (> lines)
  - footnote definitions ([^...]:)
  - list items (each item wrapped independently with a hanging indent)
  - 4-space indented sub-paragraphs

Leaves unchanged (they cannot be wrapped, even if over width):
  - YAML frontmatter (leading --- ... ---)
  - fenced code blocks (``` / ~~~)
  - HTML comments (<!-- ... -->)
  - headings, blank lines, horizontal rules
  - display math blocks ($$...$$), single- or multi-line
  - table rows (| ...)

Atomic tokens (never split; moved whole to the next line when they don't fit):
  - Obsidian wikilinks: [[slug]] and [[slug|display text]]
  - inline LaTeX: $...$
  - markdown links: [label](url)
  - inline code: `...`

Wikilinks or links split across source lines ([[slug|  +  display]]) are
rejoined and normalised when their paragraph is reflowed.

Usage:
    python3 reflow-markdown.py <file.md> [--width N]

Edits the file in place (backup saved as <file>.bak). Default width: 100.
"""

import re
import argparse
import shutil

ATOMIC = re.compile(
    r'\$[^$\n]+\$'                   # inline math
    r'|\[\[[^\]\n]*\]\]'             # wikilink: [[slug]] or [[slug|display text]]
    r'|\[[^\]\n]*\]\([^)\n]*\)'      # markdown link: [label](url)
    r'|`[^`\n]+`'                    # inline code
)

# A line ending inside an open wikilink (no closing ]]) — needs rejoining
OPEN_WIKILINK = re.compile(r'\[\[[^\]\n]*$')
# A list marker: optional indent, then - * + or 1. 1), with following space
LIST_MARKER = re.compile(r'^(\s*)([-*+]|\d+[.)])(\s+)')
FOOTNOTE = re.compile(r'^\[\^\S+?\]:')
HR = re.compile(r'^(-{3,}|\*{3,}|_{3,})\s*$')


def tokenise(text):
    """Split text into tokens; atomic spans ($...$, [[...]], [..](..), `...`)
    are kept whole, everything else splits on whitespace."""
    tokens = []
    pos = 0
    for m in ATOMIC.finditer(text):
        if m.start() > pos:
            tokens.extend(text[pos:m.start()].split())
        tokens.append(m.group(0))
        pos = m.end()
    if pos < len(text):
        tokens.extend(text[pos:].split())
    return tokens


def fill(text, width, initial_indent='', subsequent_indent=''):
    """Greedy line packer; atomic tokens are never split, just moved whole."""
    tokens = tokenise(text)
    if not tokens:
        return initial_indent
    lines = []
    indent = initial_indent
    current = indent
    for tok in tokens:
        if current == indent:
            current += tok
        elif len(current) + 1 + len(tok) <= width:
            current += ' ' + tok
        else:
            lines.append(current)
            indent = subsequent_indent
            current = indent + tok
    lines.append(current)
    return '\n'.join(lines)


def repair_atomics(text):
    """Normalise whitespace inside wikilinks (fixes joins like
    '[[slug| display]]' and '[[ slug | display ]]')."""

    def fix_link(m):
        inner = m.group(1)
        inner = re.sub(r'\s*\|\s*', '|', inner)
        inner = re.sub(r'\s+', ' ', inner).strip()
        return '[[' + inner + ']]'

    return re.sub(r'\[\[([^\]\n]*)\]\]', fix_link, text)


def join_paragraph(lines):
    """Join source lines into one paragraph, repairing split atomic tokens:
    no space is inserted where the previous line ends inside an open
    [[wikilink or a [label] awaiting its (url)."""
    stripped = [ln.strip() for ln in lines]
    parts = [stripped[0]]
    for s in stripped[1:]:
        prev = parts[-1]
        if OPEN_WIKILINK.search(prev) or (prev.endswith(']') and s.startswith('(')):
            parts.append(s)          # continue the token, no space
        else:
            parts.append(' ' + s)
    return repair_atomics(''.join(parts))


def needs_reflow(block, width):
    """True when a block must be reflowed: an over-width line, or a wikilink
    split across lines."""
    if any(len(l) > width for l in block):
        return True
    for l in block[:-1]:
        if OPEN_WIKILINK.search(l):
            return True
    return False


def reflow(path, width=100):
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    src = text.split('\n')
    n = len(src)

    out = []
    exempt = set()   # output indices that are pass-through structures

    def emit(lines, is_exempt=False):
        start = len(out)
        out.extend(lines)
        if is_exempt:
            exempt.update(range(start, len(out)))

    i = 0

    # YAML frontmatter — leading --- ... --- untouched
    if src and src[0].strip() == '---':
        j = 1
        while j < n and src[j].strip() != '---':
            j += 1
        if j < n:
            emit(src[0:j + 1], True)
            i = j + 1
        else:
            emit(src[0:], True)
            i = n

    while i < n:
        line = src[i]

        # Blank line
        if line.strip() == '':
            emit([line])
            i += 1
            continue

        # Heading
        if line.startswith('#'):
            emit([line], True)
            i += 1
            continue

        # Horizontal rule
        if HR.match(line):
            emit([line], True)
            i += 1
            continue

        # Fenced code block
        if line.startswith('```') or line.startswith('~~~'):
            j = i + 1
            while j < n and not (src[j].startswith('```') or src[j].startswith('~~~')):
                j += 1
            emit(src[i:j + 1], True)
            i = j + 1
            continue

        # HTML comment
        if line.strip().startswith('<!--'):
            if '-->' in line:
                emit([line], True)
                i += 1
                continue
            j = i + 1
            while j < n and '-->' not in src[j]:
                j += 1
            emit(src[i:j + 1], True)
            i = j + 1
            continue

        # Display math block $$ ... $$ — single- or multi-line, untouched
        if line.startswith('$$'):
            emit([line], True)
            i += 1
            if line.count('$$') < 2:      # opening delimiter, not self-closing
                while i < n and '$$' not in src[i]:
                    emit([src[i]], True)
                    i += 1
                if i < n:
                    emit([src[i]], True)  # closing delimiter
                    i += 1
            continue

        # Footnote definition: [^tag]: text
        if FOOTNOTE.match(line):
            block = [line]
            j = i + 1
            while j < n:
                nl = src[j]
                if (nl.strip() == '' or nl.startswith('#') or nl.startswith('>')
                        or nl.startswith('    ') or nl.startswith('|')
                        or nl.startswith('$$') or FOOTNOTE.match(nl)):
                    break
                block.append(nl)
                j += 1
            if needs_reflow(block, width):
                m = FOOTNOTE.match(line)
                rest = line[len(m.group(0)):].strip()
                combined = m.group(0) + ' ' + join_paragraph([rest] + block[1:])
                emit(fill(combined, width, subsequent_indent='    ').split('\n'))
            else:
                emit(block)
            i = j
            continue

        # Block quote
        if line.startswith('>'):
            block = [line]
            j = i + 1
            while j < n and src[j].startswith('>'):
                block.append(src[j])
                j += 1
            pm = re.match(r'^(>+\s*)', block[0])
            prefix = pm.group(1) if pm else '> '
            if needs_reflow(block, width):
                stripped = [re.sub(r'^>+\s*', '', b) for b in block]
                wrapped = fill(join_paragraph(stripped), width - len(prefix))
                emit([prefix + wl for wl in wrapped.split('\n')])
            else:
                emit(block)
            i = j
            continue

        # List item — each item wrapped independently with a hanging indent
        lm = LIST_MARKER.match(line)
        if lm:
            indent = lm.group(1)
            marker = lm.group(2) + lm.group(3)
            first_content = line[len(lm.group(0)):].strip()
            item = [line]
            j = i + 1
            while j < n:
                nl = src[j]
                if (nl.strip() == '' or nl.startswith('#') or nl.startswith('>')
                        or nl.startswith('|') or nl.startswith('$$')
                        or nl.startswith('```') or FOOTNOTE.match(nl) or HR.match(nl)
                        or LIST_MARKER.match(nl)):
                    break          # new item (any indent) or new block
                item.append(nl)
                j += 1
            if needs_reflow(item, width):
                content = join_paragraph([first_content] + item[1:])
                hang = indent + ' ' * len(marker)
                wrapped = fill(content, width,
                               initial_indent=indent + marker,
                               subsequent_indent=hang)
                emit(wrapped.split('\n'))
            else:
                emit(item)
            i = j
            continue

        # 4-space indented paragraph (footnote sub-paragraphs, etc.)
        if line.startswith('    '):
            block = [line]
            j = i + 1
            while j < n:
                nl = src[j]
                if (nl.strip() == '' or not nl.startswith('    ')
                        or nl.startswith('#') or nl.startswith('>') or nl.startswith('|')
                        or nl.startswith('$$') or FOOTNOTE.match(nl)
                        or LIST_MARKER.match(nl)):
                    break
                block.append(nl)
                j += 1
            if needs_reflow(block, width):
                wrapped = fill(join_paragraph(block), width,
                               initial_indent='    ', subsequent_indent='    ')
                emit(wrapped.split('\n'))
            else:
                emit(block)
            i = j
            continue

        # Table row — untouched
        if line.startswith('|'):
            emit([line], True)
            i += 1
            continue

        # Regular prose paragraph
        para = [line]
        j = i + 1
        while j < n:
            nl = src[j]
            if (nl.strip() == '' or nl.startswith('#') or nl.startswith('>')
                    or nl.startswith('|') or nl.startswith('$$') or nl.startswith('```')
                    or nl.startswith('    ') or FOOTNOTE.match(nl) or HR.match(nl)
                    or LIST_MARKER.match(nl)):
                break
            para.append(nl)
            j += 1
        if needs_reflow(para, width):
            emit(fill(join_paragraph(para), width).split('\n'))
        else:
            emit(para)
        i = j
        continue

    result = '\n'.join(out)
    if result and not result.endswith('\n'):
        result += '\n'

    if result == text:
        over = [l for l in out if len(l) > width]
        if over:
            print(f"No changes needed ({len(out)} lines; {len(over)} over "
                  f"{width}, all exempt structures).")
        else:
            print(f"No changes needed ({len(out)} lines; none over {width}).")
        return

    shutil.copy2(path, path + '.bak')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(result)

    over = [(idx, l) for idx, l in enumerate(out) if len(l) > width]
    over_exempt = [l for idx, l in over if idx in exempt]
    over_reflowable = [l for idx, l in over if idx not in exempt]
    print(f"Done. Lines: {len(out)} (was {len(src)}). Over {width} chars: "
          f"{len(over)} — {len(over_exempt)} exempt (table/math/frontmatter/"
          f"code/heading), {len(over_reflowable)} unbreakable tokens.")
    for l in over_reflowable:
        print(f"  [{len(l)}] {l[:80]}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('file', help='Markdown file to reflow')
    parser.add_argument('--width', type=int, default=100,
                        help='Maximum characters per line (default: 100)')
    args = parser.parse_args()
    width = args.width
    reflow(args.file, width)
