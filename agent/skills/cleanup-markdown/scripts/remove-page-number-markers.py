#!/usr/bin/env python3
"""
remove-page-number-markers.py — Strip page-number markers from the start of
lines in PDF-to-markdown output (Mathpix, Adobe, etc.).

In Mathpix output, page numbers appear as `[^N]` or `[^N]:` tokens. They come
in two forms:

  1. Alone on their own line (the entire line is just the marker):
         [^42]
         [^42]:

  2. At the start of a line immediately followed by text, with or without a
     space between the marker and the first word (the more common case):
         [^42]This sentence continues here.
         [^42]: The next paragraph begins.
         [^42] The next paragraph begins.

In both cases the marker is deleted and, for form 2, the remaining text is
kept (joined flush to the left margin, any leading space after the marker
stripped).

These are NOT markdown footnote definitions — the real footnotes are in LaTeX
format (${ }^{N}$) and are converted by convert-latex-footnotes.py afterward.

Usage:
    python3 remove-page-number-markers.py <file.md>

Edits the file in place and prints a count of markers removed.
"""

import re
import sys
import shutil

# Matches [^N] or [^N]: at the very start of a line, capturing any text that
# follows (after an optional space).  Group 1 = remainder (may be empty).
PAGE_MARKER_RE = re.compile(r'^\[\^\d+\]:?\s*(.*)')


def remove_page_markers(path: str) -> int:
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    out_lines = []
    removed = 0
    for line in lines:
        raw = line.rstrip('\n')
        m = PAGE_MARKER_RE.match(raw)
        if m:
            removed += 1
            remainder = m.group(1)
            if remainder:
                # Keep the text that followed the marker
                out_lines.append(remainder + '\n')
            # else: line was only the marker — drop it entirely
        else:
            out_lines.append(line)

    if removed:
        shutil.copy2(path, path + '.bak')
        with open(path, 'w', encoding='utf-8') as f:
            f.writelines(out_lines)

    return removed


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f'Usage: {sys.argv[0]} <file.md>', file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    n = remove_page_markers(path)
    print(f'Removed {n} page-number marker(s) from {path}.')
