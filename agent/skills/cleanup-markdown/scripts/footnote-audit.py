#!/usr/bin/env python3
r"""
footnote-audit.py — Report the footnote key structure of one markdown file:
definitions, references, duplicates, dangling and orphan keys. Read-only.

Definition = a line-start `[^key]:` (the form cleanup produces). A line-start
`[^key] text` without a colon is counted as a REFERENCE, because in cleaned
output a body paragraph may legitimately begin with its marker (e.g. a
sentence that opens with the footnote reference). Pre-cleanup Mathpix output
contains page markers (`[^42]` alone / `[^42]Text` at line start) which will
therefore appear as extra references — so treat dangling/orphans from raw
files as approximate; the aggregator re-runs this on the merged, renumbered
file, where the numbers are exact.

Buckets (JSON output):
  defs        key -> [line numbers]             (colon-form definitions)
  refCounts   key -> number of references       (incl. line-start no-colon)
  lineStarts  number of line-start `[^key]` no-colon occurrences
  dupDefs     keys with more than one definition line
  dangling    keys referenced but never defined
  orphans     keys defined but never referenced

Numbering regimes are obvious from dupDefs/dangling/orphans: per-page
numbering (same key, different texts) shows as dupDefs; notes grouped in one
Notes section show as many dangling refs in the body (defs live in the Notes
section) — expected pre-merge, not an error.

Usage:
    python3 footnote-audit.py <file.md> [--json out.json]

Prints a compact human summary; with --json also writes the full structure.
Exit code 0 (informational; orphans/dangling are expected pre-cleanup).
"""

import json
import re
import sys

DEF_RE = re.compile(r'^\[\^([^\]]+)\]:')
REF_RE = re.compile(r'\[\^([^\]]+)\]')


def audit(path: str):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    defs = {}      # key -> [line numbers (1-based)]
    line_starts = 0
    for idx, raw in enumerate(lines):
        ln = idx + 1
        m = DEF_RE.match(raw)
        if m:
            defs.setdefault(m.group(1), []).append(ln)
        elif re.match(r'^\[\^[^\]]+\]\s', raw) or re.match(r'^\[\^[^\]]+\]$', raw):
            line_starts += 1  # reference (or pre-clean page marker) at line start

    refs = {}
    for idx, raw in enumerate(lines):
        def_m = DEF_RE.match(raw)
        start = def_m.end() if def_m else 0  # skip a definition's own label
        for m in REF_RE.finditer(raw, start):
            refs[m.group(1)] = refs.get(m.group(1), 0) + 1

    dup_defs = sorted(k for k, v in defs.items() if len(v) > 1)
    dangling = sorted(k for k in refs if k not in defs)
    orphans = sorted(k for k in defs if k not in refs)

    return {
        'defs': {k: v for k, v in sorted(defs.items())},
        'refCounts': {k: v for k, v in sorted(refs.items())},
        'lineStarts': line_starts,
        'dupDefs': dup_defs,
        'dangling': dangling,
        'orphans': orphans,
        'defCount': sum(len(v) for v in defs.values()),
        'refCount': sum(refs.values()),
        'uniqueDefKeys': len(defs),
        'uniqueRefKeys': len(refs),
    }


def main():
    args = sys.argv[1:]
    out_json = None
    if '--json' in args:
        i = args.index('--json')
        out_json = args[i + 1]
        args = args[:i]
    if len(args) != 1:
        print(f'Usage: {sys.argv[0]} <file.md> [--json out.json]', file=sys.stderr)
        sys.exit(2)
    path = args[0]
    r = audit(path)
    print(f'defs: {r["defCount"]} ({r["uniqueDefKeys"]} keys)  '
          f'refs: {r["refCount"]} ({r["uniqueRefKeys"]} keys)  '
          f'line-start no-colon forms: {r["lineStarts"]}')
    print('dupDefs:  ' + (', '.join(r['dupDefs']) or 'none'))
    print('dangling: ' + (', '.join(r['dangling']) or 'none'))
    print('orphans:  ' + (', '.join(r['orphans']) or 'none'))
    if out_json:
        with open(out_json, 'w', encoding='utf-8') as f:
            json.dump(r, f, indent=1)
        print(f'wrote {out_json}')
    sys.exit(0)


if __name__ == '__main__':
    main()
