#!/usr/bin/env python3
"""
fix-ocr-typos.py — Apply a list of exact-string find/replace pairs to a file.

Claude identifies OCR typos in a document and passes them to this script as
a JSON array of {"from": "...", "to": "..."} objects.  The script applies all
replacements in a single pass (each "from" is replaced with its "to" wherever
it appears in the file) and reports what changed.

Usage:
    python3 fix-ocr-typos.py <file.md> <replacements.json>

    Or pipe JSON on stdin:
    echo '[{"from": "capitalrelation", "to": "capital relation"}]' | \\
        python3 fix-ocr-typos.py <file.md> -

replacements.json format:
    [
      {"from": "capitalrelation",   "to": "capital relation"},
      {"from": "20078",             "to": "2007-8"},
      {"from": "MayJune",           "to": "May-June"}
    ]

Replacements are applied in the order listed.  The file is edited in place;
a .bak copy is written before any changes.
"""

import json
import sys
import shutil


def load_replacements(source: str) -> list[dict]:
    if source == '-':
        return json.load(sys.stdin)
    with open(source, 'r', encoding='utf-8') as f:
        return json.load(f)


def apply_replacements(path: str, replacements: list[dict]) -> None:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    counts = {}
    for entry in replacements:
        frm = entry['from']
        to  = entry['to']
        n   = content.count(frm)
        if n:
            content = content.replace(frm, to)
            counts[frm] = (to, n)

    if content == original:
        print('No changes made (none of the "from" strings were found).')
        return

    shutil.copy2(path, path + '.bak')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

    total = sum(v[1] for v in counts.values())
    print(f'Fixed {total} occurrence(s) across {len(counts)} typo pattern(s):')
    for frm, (to, n) in counts.items():
        print(f'  {n}x  {frm!r}  →  {to!r}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} <file.md> <replacements.json|->', file=sys.stderr)
        sys.exit(1)

    path         = sys.argv[1]
    replacements = load_replacements(sys.argv[2])
    apply_replacements(path, replacements)
