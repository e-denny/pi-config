#!/usr/bin/env python3
"""
convert-latex-footnotes.py — Convert LaTeX footnote superscripts to standard
markdown footnote references throughout a file.

This script handles the common Mathpix output patterns where in-text footnote
callouts are left as LaTeX rather than converted to markdown.

Conversions performed (in order — more-specific patterns first):

1. Superscript inside a LaTeX math citation:
       $(\\mathrm{G}, 684 .)^{3}$   →   (G, 684.)[^3]
   (any $...$ expression that ends with ^{N}$)

2. Bare LaTeX superscript:
       ${ }^{3}$   →   [^3]
   (also handles ${}^{3}$, $ {}^{3} $, etc.)

3. Plain caret-brace superscript outside math delimiters (rarer):
       ^{3}   →   [^3]   (only when NOT inside a $...$ pair)

4. Bundled authors' affiliation note:
       [^0]: ${ }^{1}$ Affiliations text   →   [^auth]: Affiliations text
   (updates both the definition and any [^0] reference in the body)

5. Stray [^0] on its own line (page-break artifact) → line deleted

6. Footnote definition missing colon:
       [^N] text   →   [^N]: text
   (only when at the start of a line and followed by non-empty text)

Usage:
    python3 convert-latex-footnotes.py <file.md> [--prefix PREFIX]

Options:
    --prefix PREFIX   Chapter prefix for per-chapter numbering, e.g. "ch1".
                      If given, [^3] becomes [^ch1-3] everywhere.

Edits the file in place. Prints a summary of what was changed.
"""

import re
import sys
import shutil
import argparse


# ── helpers ────────────────────────────────────────────────────────────────

def apply_prefix(n: str, prefix: str) -> str:
    """Return the footnote key, optionally prefixed."""
    if prefix:
        return f'{prefix}-{n}'
    return n


# ── per-line transformations ────────────────────────────────────────────────

def convert_line(line: str, prefix: str) -> tuple[str, int]:
    """Apply all substitutions to a single line. Returns (new_line, count)."""
    changed = 0
    original = line

    # 1. Citation superscript: $(\mathrm{...})^{N}$
    #    Capture everything between the outer $ delimiters so we can strip the
    #    LaTeX markup while keeping the human-readable content.
    def repl_citation(m):
        nonlocal changed
        changed += 1
        inner = m.group(1)          # e.g. \mathrm{G}, 684 .
        n     = m.group(2)          # footnote number
        # Strip \mathrm{...} wrappers, collapse spaces, fix trailing dot-space
        readable = re.sub(r'\\mathrm\{([^}]*)\}', r'\1', inner)
        readable = re.sub(r'\s+', ' ', readable).strip()
        readable = re.sub(r'\s*\.\s*$', '.', readable)
        key = apply_prefix(n, prefix)
        return f'({readable})[^{key}]'

    line = re.sub(
        r'\$\(([^$]+?)\)\^?\{(\d+)\}\$',
        repl_citation,
        line
    )

    # 2. Bare LaTeX superscript: ${ }^{N}$  or  ${}^{N}$  etc.
    def repl_bare(m):
        nonlocal changed
        changed += 1
        n = m.group(1)
        key = apply_prefix(n, prefix)
        return f'[^{key}]'

    line = re.sub(
        r'\$\s*\{?\s*\}\s*\^\{(\d+)\}\s*\$',
        repl_bare,
        line
    )

    # 3. Stray ^{N} outside math (not preceded/followed by $)
    #    Only match if not already inside a $…$ span.
    def repl_caret(m):
        nonlocal changed
        changed += 1
        n = m.group(1)
        key = apply_prefix(n, prefix)
        return f'[^{key}]'

    # Quick heuristic: skip lines that still contain $
    if '$' not in line:
        line = re.sub(r'\^\{(\d+)\}', repl_caret, line)

    if line != original:
        pass  # changes already counted above

    return line, changed


# ── whole-file pass ─────────────────────────────────────────────────────────

def convert_file(path: str, prefix: str) -> None:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    total_superscripts = 0
    new_lines = []

    for line in lines:
        new_line, n = convert_line(line, prefix)
        total_superscripts += n
        new_lines.append(new_line)

    content = '\n'.join(new_lines)

    # ── Pass 2: bundled authors' affiliation [^0] ──────────────────────────
    # Pattern: [^0]: ${ }^{1}$ Affiliations text
    affil_removed = 0
    def repl_affil_def(m):
        nonlocal affil_removed
        affil_removed += 1
        rest = re.sub(r'\$\s*\{?\s*\}\s*\^\{\d+\}\s*\$\s*', '', m.group(1)).strip()
        return f'[^auth]: {rest}'

    content = re.sub(
        r'^\[\^0\]:\s*(.+)$',
        repl_affil_def,
        content,
        flags=re.MULTILINE
    )
    if affil_removed:
        # Update the body reference [^0] → [^auth]
        content = content.replace('[^0]', '[^auth]')

    # ── Pass 3: stray [^0] on its own line ───────────────────────────────
    stray_removed = 0
    def repl_stray(m):
        nonlocal stray_removed
        stray_removed += 1
        return ''

    content = re.sub(r'^\[\^0\]\s*$\n?', repl_stray, content, flags=re.MULTILINE)

    # ── Pass 4: definition missing colon  [^N] text → [^N]: text ─────────
    missing_colon = 0
    def repl_colon(m):
        nonlocal missing_colon
        missing_colon += 1
        n    = m.group(1)
        rest = m.group(2)
        key  = apply_prefix(n, prefix)
        return f'[^{key}]: {rest}'

    content = re.sub(
        r'^\[\^(\d+)\]\s+(?!:)(\S)',
        repl_colon,
        content,
        flags=re.MULTILINE
    )

    # ── write out ──────────────────────────────────────────────────────────
    shutil.copy2(path, path + '.bak')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f'Converted {total_superscripts} LaTeX superscript(s) to markdown footnote references.')
    if affil_removed:
        print(f'Converted {affil_removed} bundled-affiliation [^0] definition(s) to [^auth].')
    if stray_removed:
        print(f'Removed {stray_removed} stray [^0] line(s).')
    if missing_colon:
        print(f'Added missing colon to {missing_colon} footnote definition(s).')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('file', help='Markdown file to process')
    parser.add_argument(
        '--prefix', default='',
        help='Chapter prefix for per-chapter footnote IDs (e.g. "ch1")'
    )
    args = parser.parse_args()
    convert_file(args.file, args.prefix)
