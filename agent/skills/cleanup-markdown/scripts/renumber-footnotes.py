#!/usr/bin/env python3
"""
renumber-footnotes.py — Consolidate markdown footnote definitions at the end
of a document and (optionally) renumber them per chapter.

This is the supervisor's tool for the final footnote pass, run on the
*merged* document. Editor subagents have already:
  * moved every footnote definition in their section to the bottom of that
    section (so after merging, definitions sit at the seams between the
    body of one chapter and the heading of the next, or at the very end),
  * kept the original footnote numbers (they never renumber doc-wide).

This script then does the mechanical part of the supervisor's job:

1. Chapters. Each --chapter-lines entry (1-based line of a chapter heading)
   starts a new chapter region; content before the first entry belongs to
   chapter 1 and content after the last entry to the last chapter. Each
   region carries a LABEL (from --chapter-numbers, default 1..C). Regions
   that share a label are treated as one chapter, so you can handle
   documents whose Notes block sits at the end with per-chapter groups: pass
   the body chapter headings *plus* the group headings as --chapter-lines,
   with --chapter-numbers giving every group its real chapter number. The
   references in a body chapter and the definitions in its end-group then
   fall under the same label and pair up correctly.

2. --mode seq (default): the document's footnotes are numbered continuously.
   Definitions are moved to a single consolidated block at the end of the
   file. Keys are left unchanged when they already form the contiguous run
   1..N in ascending document order; if cleanup left gaps, keys are
   renumbered 1..N in ascending order of the original keys.

   --mode ch: footnotes restart at 1 in every chapter (chapter endnotes or
   per-page notes). Within each chapter label, keys are sorted ascending by
   their original number and mapped to [^chNNN-MMM], where NNN is the label
   and MMM the ordinal of the note inside the chapter. Definitions for every
   chapter are moved to a single consolidated block at the end of the file,
   ordered by chapter label and then by ordinal.

   Keys that are not purely numeric (e.g. the bundled-authors key [^auth])
   are never renumbered; their definitions still move to the end block and
   are listed first there, in document order.

3. Identical duplicate definitions (same chapter label, same key, identical
   text — a per-page numbering artefact) are collapsed to one definition;
   all references keep pointing at the survivor.

4. Anything the script cannot safely decide is NOT touched and is reported
   loudly instead, so the supervisor can fix it by hand:
   * a numeric key that has two *different* definitions under one chapter
     label (per-page numbering restarting mid-chapter) — the key is neither
     renumbered nor moved;
   * references to keys that never get a definition;
   * definitions whose key is never referenced under its own chapter label
     (may be normal when refs and defs were split across sections — verify).

Usage
-----
    python3 renumber-footnotes.py <file.md> \
        [--mode seq|ch] \
        [--chapter-lines 42,210,380] \
        [--chapter-numbers 1,2,3] \
        [--dry-run]

    --dry-run prints the full plan (every key mapping, what moves where, and
    every problem it would leave for the supervisor) without editing.

The report printed on every run is the supervisor's checklist: read it, fix
the reported residue with Edit, and re-run if needed.
"""

import argparse
import bisect
import os
import re
import sys
import shutil


def _backup_path(path: str) -> str:
    """<file>.bak if free, else <file>.bak.1, .bak.2, ... — never clobber."""
    bak = path + '.bak'
    if not os.path.exists(bak):
        return bak
    i = 1
    while os.path.exists(f'{bak}.{i}'):
        i += 1
    return f'{bak}.{i}'

# Definition line:  [^key]: rest
DEF_RE = re.compile(r'^[ \t]*\[\^([^\]]+)\]:[ \t]*(.*)$')
# Reference token anywhere
REF_RE = re.compile(r'\[\^([^\]]+)\]')
KEY_RE = re.compile(r'^[A-Za-z0-9_.-]+$')


def norm_text(lines):
    """Normalise a definition's text for equality comparison."""
    return ' '.join(' '.join(lines).split())


def collapse_blank_runs(lines):
    """Collapse runs of consecutive blank lines to a single blank line,
    outside fenced code regions."""
    out = []
    in_fence = False
    prev_blank = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('```') or stripped.startswith('~~~'):
            in_fence = not in_fence
        blank = (stripped == '')
        if blank and prev_blank and not in_fence:
            continue            # second+ blank in a run
        out.append(line)
        prev_blank = blank
    return out


def parse_chapters(chapter_lines_str, chapter_numbers_str):
    """Return (start_lines_1based, labels_for_regions).

    Region i (1-based) is the content between starts[i-1] and starts[i].
    The label of region i is chapter_numbers[i-1]; content before the first
    start shares region 1's label; content after the last start shares the
    last region's label.
    """
    lines = []
    for tok in chapter_lines_str.split(','):
        tok = tok.strip()
        if not tok:
            continue
        try:
            lines.append(int(tok))
        except ValueError:
            sys.exit(f'Bad --chapter-lines value: {tok!r}')
    lines = sorted(set(lines))
    labels = [t.strip() for t in chapter_numbers_str.split(',') if t.strip()]
    if labels and len(labels) != len(lines):
        sys.exit('--chapter-numbers must have the same length as --chapter-lines')
    if lines and not labels:
        labels = [str(i) for i in range(1, len(lines) + 1)]
    return lines, labels


class DefEntry:
    __slots__ = ('key', 'start_line', 'end_line', 'lines', 'region', 'label')

    def __init__(self, key, start_line, lines):
        self.key = key
        self.start_line = start_line
        self.lines = lines            # list of str, incl. continuation lines
        self.end_line = start_line + len(lines) - 1
        self.region = 1
        self.label = '1'

    @property
    def text(self):
        return norm_text(self.lines)


def region_of(lineno, starts):
    """1-based region index for a 1-based line number (min 1)."""
    return max(1, bisect.bisect_right(starts, lineno))


def find_def_entries(lines):
    """Return (entries, in_def).

    An entry starts at a DEF_RE line and continues over the following lines
    until the next definition-starting line or a blank line (whichever comes
    first). Continuation lines are part of the definition text.
    """
    entries = []
    in_def = [False] * len(lines)
    i = 0
    n = len(lines)
    while i < n:
        m = DEF_RE.match(lines[i])
        if not m:
            i += 1
            continue
        entry_lines = [lines[i]]
        j = i + 1
        while j < n and lines[j].strip() != '' and not DEF_RE.match(lines[j]):
            entry_lines.append(lines[j])
            j += 1
        entries.append(DefEntry(m.group(1), i + 1, entry_lines))
        for k in range(i, j):
            in_def[k] = True
        i = j
    return entries, in_def


def numeric(key):
    return key.isdigit()


def label_sort_key(label):
    """Numeric labels sort numerically before text labels."""
    if label.isdigit():
        return (0, int(label), '')
    return (1, 0, label)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file')
    ap.add_argument('--mode', choices=['seq', 'ch'], default='seq')
    ap.add_argument('--chapter-lines', default='',
                    help='comma-separated 1-based line numbers of chapter/group headings')
    ap.add_argument('--chapter-numbers', default='',
                    help='comma-separated chapter labels for chNNN (default: 1..C)')
    ap.add_argument('--dry-run', action='store_true',
                    help='print the plan without editing the file')
    args = ap.parse_args()

    with open(args.file, 'r', encoding='utf-8') as f:
        content = f.read()
    lines = content.split('\n')
    if lines and lines[-1] == '':
        lines = lines[:-1]

    starts, region_labels = parse_chapters(args.chapter_lines, args.chapter_numbers)
    n_regions = len(starts) if starts else 1

    def label_of_region(r):
        if not region_labels:
            return str(r)
        return region_labels[min(r, len(region_labels)) - 1]

    entries, in_def = find_def_entries(lines)
    for e in entries:
        e.region = region_of(e.start_line, starts)
        e.label = label_of_region(e.region)

    # distinct chapter labels in document order of first region appearance
    label_order = []
    for r in range(1, n_regions + 1):
        lab = label_of_region(r)
        if lab not in label_order:
            label_order.append(lab)

    # ---- reference keys per label (definition lines excluded) ----
    ref_keys = {lab: set() for lab in label_order}
    refs_inside_defs = 0
    for idx, line in enumerate(lines):
        if in_def[idx]:
            m = DEF_RE.match(line)
            rest = m.group(2) if m else line
            refs_inside_defs += len(REF_RE.findall(rest))
            continue
        lab = label_of_region(region_of(idx + 1, starts))
        for m in REF_RE.finditer(line):
            k = m.group(1)
            if KEY_RE.match(k):
                ref_keys[lab].add(k)

    def def_keys_of(lab):
        return {e.key for e in entries if e.label == lab}

    # ---- per-label collisions (same numeric key, different def text) ----
    collisions = set()          # (label, key) pairs left for the supervisor
    problems = []
    for lab in label_order:
        variants = {}
        for e in entries:
            if e.label == lab and numeric(e.key):
                variants.setdefault(e.key, set()).add(e.text)
        for key, texts in variants.items():
            if len(texts) > 1:
                collisions.add((lab, key))
                problems.append(
                    f'chapter {lab}: key {key} has {len(texts)} DIFFERENT '
                    'definitions (per-page restart?). Not auto-fixed: match each '
                    'reference to its definition by content and renumber by hand.')

    # ---- build the mapping (label, key) -> new key ----
    mapping = {}                # (label, key) -> new key
    by_ordinal = {}             # label -> [(old_key, new_key)]
    if args.mode == 'ch':
        for lab in label_order:
            keys = ref_keys[lab] | def_keys_of(lab)
            numerics = sorted(int(k) for k in keys
                              if numeric(k) and (lab, k) not in collisions)
            for old in numerics:
                key = str(old)
                ordinal = len(by_ordinal.get(lab, ())) + 1
                new = f'ch{lab}-{ordinal}'
                mapping[(lab, key)] = new
                by_ordinal.setdefault(lab, []).append((key, new))
    else:  # seq — continuous; identity, then compact gaps doc-wide
        all_numeric = sorted({
            int(k)
            for lab in label_order
            for k in (ref_keys[lab] | def_keys_of(lab))
            if numeric(k) and (lab, k) not in collisions
        })
        for new, old in enumerate(all_numeric, start=1):
            old_s, new_s = str(old), str(new)
            if old_s != new_s:
                problems.append(f'compacting key [^{old_s}] -> [^{new_s}] '
                                '(cleanup left a gap)')
            for lab in label_order:
                if (lab, old_s) in collisions:
                    continue
                if old_s in (ref_keys[lab] | def_keys_of(lab)):
                    mapping[(lab, old_s)] = new_s

    # ---- report the plan ----
    print(f'File: {args.file}')
    print(f'Mode: {args.mode} | chapter labels: '
          f'{[label_of_region(r) for r in range(1, n_regions + 1)]}')
    print()
    if args.mode == 'ch':
        for lab in label_order:
            print(f'  chapter {lab}:')
            for old, new in by_ordinal.get(lab, []):
                print(f'    [^{old}] -> [^{new}]')
    else:
        changed = sorted({(o, n) for (_l, o), n in mapping.items() if o != n},
                         key=lambda x: x[0])
        if changed:
            print('  sequential renumbering (gap compaction):')
            for o, n in changed:
                print(f'    [^{o}] -> [^{n}]')
        else:
            print('  keys already form a contiguous run — nothing to renumber.')

    # ---- problems the supervisor must look at ----
    defined_anywhere = {e.key for e in entries}
    dangling = sorted({k for lab in label_order for k in ref_keys[lab]
                       if k not in defined_anywhere})
    if dangling:
        problems.append('References with no definition anywhere: '
                        + ', '.join(f'[^{k}]' for k in dangling))
    orphan = sorted({e.key for e in entries if e.key not in ref_keys[e.label]})
    if orphan:
        problems.append('Definitions never referenced under their own chapter '
                        'label (verify attribution — may be normal when refs '
                        'and defs were split across sections): '
                        + ', '.join(f'[^{k}]' for k in orphan))
    if refs_inside_defs:
        problems.append(f'{refs_inside_defs} footnote reference(s) appear '
                        'INSIDE definition text; they were not re-keyed — '
                        'fix any cross-references by hand.')
    if problems:
        print()
        print('Supervisor checklist (not auto-fixed):')
        for p in problems:
            print(f'  ! {p}')
    print()

    if args.dry_run:
        print('Dry run — no changes made.')
        return

    # ---- apply: re-key references on non-definition lines ----
    new_lines = []
    for idx, line in enumerate(lines):
        if in_def[idx]:
            new_lines.append(line)   # re-keyed when the end block is built
            continue
        lab = label_of_region(region_of(idx + 1, starts))
        out = []
        pos = 0
        for m in REF_RE.finditer(line):
            k = m.group(1)
            if not KEY_RE.match(k):
                continue
            new_key = mapping.get((lab, k))
            out.append(line[pos:m.start(0)])
            out.append(f'[^{new_key}]' if new_key is not None else f'[^{k}]')
            pos = m.end(0)
        out.append(line[pos:])
        new_lines.append(''.join(out))

    # ---- move definitions to the end, de-duplicated ----
    def new_key_for(e):
        if (e.label, e.key) in collisions:
            return None
        return mapping.get((e.label, e.key)) or e.key

    final_entries = []          # (label, entry, new_key)
    keep_in_place = []          # collision defs stay where they are
    for e in entries:
        nk = new_key_for(e)
        if nk is None:
            keep_in_place.append(e)
        else:
            final_entries.append((e.label, e, nk))

    # dedupe identical text on the same (label, new key)
    seen = {}
    kept = []
    dropped = []
    for lab, e, nk in final_entries:
        sig = (lab, nk)
        if sig in seen:
            if norm_text(seen[sig].lines) == norm_text(e.lines):
                dropped.append(e)        # duplicate: never moved, removed in place
                continue
            keep_in_place.append(e)      # different texts: leave for supervisor
            problems.append(f'chapter {lab}: two different definitions '
                            f'map to [^{nk}] — deduplicate by hand.')
            continue
        seen[sig] = e
        kept.append((lab, e, nk))
    final_entries = kept

    def sort_key(item):
        lab, e, nk = item
        if numeric(e.key):
            return (label_sort_key(lab), 0, int(e.key))
        return (label_sort_key(lab), 1, e.start_line)

    final_entries.sort(key=sort_key)

    # remove moved def lines from the body (also the dropped duplicates)
    remove = set()
    for _, e, _ in final_entries:
        for ln in range(e.start_line - 1, e.end_line):
            remove.add(ln)
    for e in dropped:
        for ln in range(e.start_line - 1, e.end_line):
            remove.add(ln)
    body = [ln for i, ln in enumerate(new_lines) if i not in remove]
    while body and body[-1].strip() == '':
        body.pop()
    body = collapse_blank_runs(body)

    block = []
    if final_entries:
        block.append('')
    for _, e, nk in final_entries:
        m = DEF_RE.match(e.lines[0])
        head = f'[^{nk}]: {m.group(2)}' if m else e.lines[0]
        block.append(head)
        for cont in e.lines[1:]:
            block.append(cont.strip())
        block.append('')

    out = body + block
    text = '\n'.join(out)
    if text and not text.endswith('\n'):
        text += '\n'

    bak = _backup_path(args.file)
    shutil.copy2(args.file, bak)
    with open(args.file, 'w', encoding='utf-8') as f:
        f.write(text)

    print(f'Moved {len(final_entries)} definition(s) to the end of the file; '
          f'dropped {len(dropped)} identical duplicate(s); '
          f'left {len(keep_in_place)} collision definition(s) in place for you.')
    if problems:
        print('Remaining supervisor checklist:')
        for p in problems:
            print(f'  ! {p}')
    print(f'Wrote {bak} backup.')


if __name__ == '__main__':
    main()
