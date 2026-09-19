#!/usr/bin/env python3
r"""
verify-section.py — Deterministic residue audit for one markdown file
(a cleaned section or a merged chapter). Read-only: prints what it finds,
never edits.

Checks (high precision, low false-positive by design):

  1. page_markers        lines that are exactly `[^digits]` or `[^digits]:`
                         (the remove-page-number-markers.py forms)
  2. bare_number_lines   lines that are only 1-4 digits (page-number residue,
                         e.g. a stray "36" line)
  3. latex_superscript   Mathpix superscript artifacts `${ }^{...}` or a bare
                         `\^{` in prose
  4. escaped_ampersand   `\&` anywhere (always an artifact in prose)
  5. escaped_percent     `\%` anywhere (never needed in markdown)
  6. escaped_dollar      `\$` — informational: usually a leftover LaTeX escape
                         (fix to `$`), but judge from the line (inside a code
                         fence or deliberately escaped is acceptable)
  7. body_footnote_defs  footnote definitions (`[^key]:`) whose line is NOT in
                         the file's trailing footnote block. The trailing
                         block is the last run of definitions at the end of the
                         file: definitions may be multi-line and separated by
                         single blank lines, but nothing after the block may
                         start a new paragraph (a non-blank line after a blank
                         that is not attached to a definition above it).
  8. stray_footnote_ref  a line that is only `[^N]` (a lone reference or a
                         colon-less definition)
  9. crlf / hygiene      `\r` characters, trailing whitespace, and EOF newline
                         hygiene (file must end with exactly one newline)

Every finding prints up to MAX_SAMPLES example line numbers and text so a
reader can judge without re-grepping. Exit code 0 = clean, 1 = findings.

Usage:
    python3 verify-section.py <file.md>

Example output:
    page_markers: 0
    bare_number_lines: 2
        L36: 36
    verdict: CLEAN            (exit 0)
    verdict: ISSUES FOUND     (exit 1)
"""

import re
import sys

MAX_SAMPLES = 5

PAGE_MARKER_RE = re.compile(r'^\[\^\d+\]:?\s*$')
BARE_NUMBER_RE = re.compile(r'^[0-9]{1,4}$')
LATEX_SUP_RE = re.compile(r'\$\{\s*\}\^\{|\^\{[^}]*\}')
ESC_AMP_RE = re.compile(r'\\&')
ESC_PCT_RE = re.compile(r'\\%')
ESC_DOLLAR_RE = re.compile(r'\\\$')
DEF_RE = re.compile(r'^\[\^([^\]]+)\]:')
REF_LINE_RE = re.compile(r'^\[\^[^\]]+\]\s*$')


def _attached_gap(lines, a, b):
    """True when lines a+1..b-1 are blanks or paragraphs attached to the
    definition that starts at line a (no new paragraph may start in between,
    where a new paragraph = non-blank line following a blank line)."""
    attached = True  # the line above a non-blank is its def start
    for raw in lines[a:b - 1]:
        if raw.strip() == '':
            attached = False
        elif not attached:
            return False  # non-blank after a blank -> new paragraph
    return True


def audit(path: str):
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    lines = text.split('\n')
    n = len(lines) - (1 if lines and lines[-1] == '' else 0)

    findings = {k: [] for k in (
        'page_markers', 'bare_number_lines', 'latex_superscript',
        'escaped_ampersand', 'escaped_percent', 'escaped_dollar',
        'body_footnote_defs', 'stray_footnote_ref', 'crlf', 'trailing_ws',
        'eof_newline')}

    def_lines = []  # 1-based line numbers of definition starts
    for idx, raw in enumerate(lines[:n]):
        ln = idx + 1
        if PAGE_MARKER_RE.match(raw):
            findings['page_markers'].append((ln, raw))
        if BARE_NUMBER_RE.match(raw):
            findings['bare_number_lines'].append((ln, raw))
        if LATEX_SUP_RE.search(raw):
            findings['latex_superscript'].append((ln, raw[:100]))
        if ESC_AMP_RE.search(raw):
            findings['escaped_ampersand'].append((ln, raw[:100]))
        if ESC_PCT_RE.search(raw):
            findings['escaped_percent'].append((ln, raw[:100]))
        if ESC_DOLLAR_RE.search(raw):
            findings['escaped_dollar'].append((ln, raw[:100]))
        if '\r' in raw:
            findings['crlf'].append((ln, 'contains CR'))
        if raw != raw.rstrip():
            findings['trailing_ws'].append((ln, 'trailing whitespace'))
        if DEF_RE.match(raw):
            def_lines.append(ln)
        if REF_LINE_RE.match(raw):
            findings['stray_footnote_ref'].append((ln, raw[:100]))

    # Find the trailing footnote block: the last run of definitions that
    # extends to EOF, where every gap between consecutive definitions is
    # attached (definition text or blank lines) and nothing after the last
    # definition starts a new paragraph.
    if def_lines:
        block_start = None
        run = [def_lines[-1]]
        for a in reversed(def_lines[:-1]):
            b = run[0]
            if b - a > 1 and not _attached_gap(lines, a - 1, b - 1):
                break
            run.insert(0, a)
        # gap between last def and EOF must stay attached too
        if _attached_gap(lines, run[-1] - 1, n):
            block_start = run[0]
        for ln in def_lines:
            if block_start is None or ln < block_start:
                findings['body_footnote_defs'].append((ln, f'[^{ln}] def outside tail block'))

    # EOF newline hygiene
    if text and not text.endswith('\n'):
        findings['eof_newline'].append((n, 'missing final newline'))
    else:
        k = len(text) - len(text.rstrip('\n'))
        if k > 1:
            findings['eof_newline'].append((n, f'{k} trailing newlines'))

    return findings


def main():
    if len(sys.argv) != 2:
        print(f'Usage: {sys.argv[0]} <file.md>', file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    findings = audit(path)
    total = 0
    order = ('page_markers', 'bare_number_lines', 'latex_superscript',
             'escaped_ampersand', 'escaped_percent', 'escaped_dollar',
             'body_footnote_defs', 'stray_footnote_ref', 'crlf',
             'trailing_ws', 'eof_newline')
    for key in order:
        items = findings[key]
        print(f'{key}: {len(items)}')
        for ln, txt in items[:MAX_SAMPLES]:
            print(f'    L{ln}: {txt}')
        total += len(items)
    print('verdict: ISSUES FOUND' if total else 'verdict: CLEAN')
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    main()
