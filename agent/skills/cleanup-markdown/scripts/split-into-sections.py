#!/usr/bin/env python3
"""
split-into-sections.py — Split a Mathpix-style markdown file into
roughly-TARGET-word sections for parallel cleanup, and merge cleaned
sections back into a single file.

Commands
--------
  split <file.md> [--target N] [--dir DIR]
      Split <file.md> into sections of ~N words (default 4000).
      Writes section-01.md, section-02.md, ... plus manifest.json into DIR
      (default: a fresh temp dir under /tmp). Prints a summary listing each
      section with its word count, original line range, and first line.

  merge <manifest.json> --out <output.md>
      Read the section file list from a manifest (in order) and concatenate
      the *current* contents of those files into <output.md>. Each section
      is stripped of trailing blank lines and sections are joined by a
      single blank line, so seams always fall on clean block boundaries.

Split rules
-----------
- The input is cut into "blocks" at blank lines (a block is a maximal run of
  consecutive non-blank lines). A block is atomic: it is never split. This
  keeps paragraphs, block quotes, list runs, table rows and footnote
  definition lines intact and guarantees no sentence is ever cut mid-line.

- Always-cut boundaries (a new section starts at the block when the current
  section is non-empty):
    * headings whose depth is at most the shallowest heading depth that
      occurs at least twice in the document (chapter level), and
    * any heading whose text looks like a chapter/part marker
      ("Chapter 2", "ch. III", "Part Two", "Lecture 1"), regardless of depth.
  This keeps chapters (and part/chapter seams) from ever straddling two
  sections, so footnote definitions of one chapter are never pushed into
  the span of the next chapter by the merge step.

- Inside a chapter the splitter absorbs whole blocks until the section is
  roughly TARGET words, then cuts at the next convenient boundary:
    * a deeper heading once the section is at least half the target
      (long chapters split at sub-headings), or
    * a plain paragraph boundary once the next block would push the section
      past ~1.25x the target (hard overshoot guard; single huge paragraphs
      stay whole and may exceed the target).

The output is meant to be reviewed by a supervisor: read the printed
summary / manifest, spot-check a few boundaries in the source file, and if
the always-cut depth was wrong for a particular document, pass
--heading-depth <N> to force it.
"""

import argparse
import json
import os
import re
import sys
import tempfile

# A footnote definition line: [^N]: text  (also [^auth]: etc.) — used to
# annotate blocks so a supervisor can see where footnote bodies ended up.
DEF_RE = re.compile(r'^\[\^[^\]]+\]:')

# Heading text that unmistakably starts a chapter/part, at any depth.
CHAPTER_TEXT_RE = re.compile(
    r'^\s*'
    r'(chapter|ch\.?|part|lecture|lesson|section|book|volume)\s+'
    r'([0-9]+|[ivxlcdm]+)\b',
    re.IGNORECASE
)

# Bare numbered heading, e.g. "# 1", "## 12. Title", "### 3 Title".
BARE_NUMBER_RE = re.compile(r'^\s*[0-9]+(?:\s*[.:]\s*|\s+)\S', re.IGNORECASE)


def heading_depth(line: str) -> int:
    """Return the ATX depth (1..6) if the line is a heading, else 0."""
    m = re.match(r'^(#{1,6})(?:\s+|$)', line)
    return len(m.group(1)) if m else 0


def is_blank(line: str) -> bool:
    return line.strip() == ''


def word_count(text: str) -> int:
    return len(text.split())


class Block:
    __slots__ = ('lines', 'start', 'end', 'depth', 'kind')

    def __init__(self, lines, start):
        self.lines = lines            # list of str, no trailing '\n'
        self.start = start            # 1-based first line number in source
        self.end = start + len(lines) - 1
        first = lines[0] if lines else ''
        self.depth = heading_depth(first)
        if self.depth:
            self.kind = 'heading'
        elif DEF_RE.match(first):
            self.kind = 'footnote-defs'
        elif first.startswith('>'):
            self.kind = 'quote'
        elif first.startswith('|'):
            self.kind = 'table'
        elif re.match(r'^\s*([-*+]|\d+[.)])\s+', first):
            self.kind = 'list'
        else:
            self.kind = 'text'

    @property
    def words(self):
        return word_count('\n'.join(self.lines))

    @property
    def is_heading(self) -> bool:
        return self.depth > 0

    @property
    def text(self) -> str:
        return '\n'.join(self.lines)


def read_blocks(path: str) -> list:
    """Split file content into Blocks at blank lines.

    Fenced code regions (``` or ~~~) are treated as atomic: blank lines
    inside a fence do not split blocks.
    """
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    if content.endswith('\n'):
        content = content[:-1]
    raw_lines = content.split('\n')

    blocks = []
    cur = []
    start = 1
    lineno = 1
    in_fence = False
    for line in raw_lines:
        stripped = line.strip()
        if stripped.startswith('```') or stripped.startswith('~~~'):
            in_fence = not in_fence
        if is_blank(line) and not in_fence:
            if cur:
                blocks.append(Block(cur, start))
                cur = []
            start = lineno + 1
        else:
            cur.append(line)
        lineno += 1
    if cur:
        blocks.append(Block(cur, start))
    return blocks


def pick_always_depth(blocks: list) -> int:
    """Shallowest heading depth occurring >= 2 times; fallback: shallowest
    occurring >= 1 time; 0 if there are no headings at all."""
    counts = {}
    for b in blocks:
        if b.is_heading:
            counts[b.depth] = counts.get(b.depth, 0) + 1
    if not counts:
        return 0
    for d in sorted(counts):
        if counts[d] >= 2:
            return d
    return min(counts)


def looks_like_chapter(block) -> bool:
    if not block.is_heading:
        return False
    text = block.lines[0]
    return bool(CHAPTER_TEXT_RE.match(text) or BARE_NUMBER_RE.match(text))


def split_file(path: str, target: int, out_dir: str, force_depth: int = 0) -> dict:
    blocks = read_blocks(path)
    always_depth = force_depth if force_depth else pick_always_depth(blocks)
    hard_cap = int(target * 1.25)
    half = int(target / 2)

    sections = []          # list of dicts
    cur = []               # blocks of the open section
    cur_words = 0

    def flush(index, cur, cur_words):
        if not cur:
            return None
        first_block = cur[0]
        body = []
        for b in cur:
            body.extend(b.lines)
        text = '\n'.join(body) + '\n'
        fname = os.path.join(out_dir, f'section-{index:02d}.md')
        with open(fname, 'w', encoding='utf-8') as f:
            f.write(text)
        info = {
            'index': index,
            'file': os.path.abspath(fname),
            'words': cur_words,
            'start_line': first_block.start,
            'end_line': cur[-1].end,
            'starts_at_heading': first_block.is_heading,
            'heading_depth': first_block.depth,
            'first_line': first_block.lines[0][:200] if first_block.lines else '',
            'kind': first_block.kind,
        }
        sections.append(info)

    idx = 1
    for block in blocks:
        start_new = False
        if cur:
            if block.is_heading:
                if looks_like_chapter(block):
                    start_new = True
                elif always_depth and block.depth <= always_depth:
                    start_new = True
                elif cur_words >= half:
                    start_new = True
            elif cur_words + block.words > hard_cap:
                start_new = True
        if start_new:
            flush(idx, cur, cur_words)
            idx += 1
            cur = []
            cur_words = 0
        cur.append(block)
        cur_words += block.words
    flush(idx, cur, cur_words)

    source = os.path.abspath(path)
    manifest = {
        'source': source,
        'target_words': target,
        'always_depth': always_depth,
        'output_dir': os.path.abspath(out_dir),
        'sections': sections,
    }
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
    return manifest


def print_summary(manifest: dict) -> None:
    sections = manifest['sections']
    total = sum(s['words'] for s in sections)
    print(f"Split '{manifest['source']}' into {len(sections)} section(s), "
          f"{total} words total, target {manifest['target_words']} words.")
    print(f"Always-cut heading depth: {manifest['always_depth'] or 'none'}")
    print()
    for s in sections:
        tag = f"heading(d{s['heading_depth']})" if s['starts_at_heading'] else f"{s['kind']}"
        print(f"  section-{s['index']:02d}.md  {s['words']:>7} words  "
              f"lines {s['start_line']}-{s['end_line']}  [{tag}]  {s['first_line'][:70]!r}")


def merge_sections(manifest_path: str, out_path: str) -> None:
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    parts = []
    for s in manifest['sections']:
        fname = s['file']
        if not os.path.exists(fname):
            sys.exit(f"merge: section file missing: {fname}")
        with open(fname, 'r', encoding='utf-8') as f:
            text = f.read()
        # Strip trailing blank lines; keep a single trailing newline.
        lines = text.split('\n')
        while lines and is_blank(lines[-1]):
            lines.pop()
        if lines and lines[-1] != '':
            lines.append('')
        parts.append('\n'.join(lines))
    merged = '\n\n'.join(p for p in parts if p) + '\n'
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(merged)
    print(f"Merged {len(parts)} section(s) into {os.path.abspath(out_path)} "
          f"({word_count(merged)} words).")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='command', required=True)

    p_split = sub.add_parser('split', help='split a file into sections')
    p_split.add_argument('file')
    p_split.add_argument('--target', type=int, default=4000)
    p_split.add_argument('--dir', default=None)
    p_split.add_argument('--heading-depth', type=int, default=0,
                         help='force the always-cut heading depth (default: auto)')

    p_merge = sub.add_parser('merge', help='merge cleaned sections back together')
    p_merge.add_argument('manifest')
    p_merge.add_argument('--out', required=True)

    args = ap.parse_args()

    if args.command == 'split':
        if not args.file.endswith('.md'):
            sys.exit(f"Not a .md file: {args.file}")
        out_dir = args.dir or tempfile.mkdtemp(prefix='cleanup-md-')
        os.makedirs(out_dir, exist_ok=True)
        manifest = split_file(args.file, args.target, out_dir,
                              force_depth=args.heading_depth)
        print_summary(manifest)
        print(f"\nManifest: {os.path.join(out_dir, 'manifest.json')}")
        print(f"Work dir: {out_dir}")
    else:
        merge_sections(args.manifest, args.out)


if __name__ == '__main__':
    main()
