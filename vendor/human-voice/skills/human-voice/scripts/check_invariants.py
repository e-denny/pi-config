#!/usr/bin/env python3
"""Invariant diff: did the rewrite keep every fact it was handed?

The linter scores style and the detector gate scores machine-ness. Neither looks
at whether the numbers survived. This does: it compares a rewrite against its
original and lists the invariants that went missing and the numbers, links and
citations that appeared out of nowhere, which is the shape fabrication takes.

    python3 check_invariants.py draft.md rewrite.md
    python3 check_invariants.py --context notes.md draft.md rewrite.md
    python3 check_invariants.py draft.md -            # rewrite from stdin
    cat rewrite.md | python3 check_invariants.py - rewrite.md
    python3 check_invariants.py --json draft.md rewrite.md
    python3 check_invariants.py --quiet draft.md rewrite.md

Exit: 0 when every invariant survived, 1 when something was lost or introduced,
2 for a usage or read error. Exit 1 is a gate, not a suggestion: restore the
missing span verbatim, or remove the addition, or mark it [SOURCE NEEDED].

Pass `--context` for author material the rewrite was allowed to draw on. Anything
present there counts as sourced rather than invented, so a rewrite that folds real
specifics into the prose does not get reported as fabricating them.

This is a floor like the linter. It compares tokens, not claims: "rose 12%" and
"fell 12%" look identical to it, so claim drift, defined terms and PII stay your
read. It exists so a script-based agent gets the same deterministic check the MCP
tool and humanize.py's loop already had.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from human_voice_llm import invariants  # noqa: E402

EXIT_OK = 0
EXIT_CHANGED = 1
EXIT_ERROR = 2

KIND_LABEL = {
    "code_blocks": "fenced code blocks",
    "inline_code": "inline code",
    "links": "links",
    "numbers": "numbers",
    "citations": "citations",
}


def read_target(target):
    if target != "-":
        with open(target, encoding="utf-8") as fh:
            return fh.read()
    return sys.stdin.read()


def render(result, limit):
    lines = ["invariants: %s" % ("ok" if result["ok"] else "CHANGED")]
    if result["ok"]:
        lines.append("  nothing lost, nothing introduced")
    else:
        for line in invariants.summarize(result, limit=limit):
            lines.append("  %s" % line)
    if result["placeholders"]:
        shown = ", ".join(repr(p) for p in result["placeholders"][:limit])
        more = (" (+%d more)" % (len(result["placeholders"]) - limit)
                if len(result["placeholders"]) > limit else "")
        lines.append("  left for the author, placeholders: %s%s" % (shown, more))
    lines.append("  token-level check only: claim drift, defined terms and PII are yours to read")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="Exit: 0 every invariant survived, 1 something lost or introduced, "
               "2 usage or read error.")
    ap.add_argument("original", help="the source the rewrite came from, or - for stdin")
    ap.add_argument("rewrite", help="the rewrite, or - for stdin (one of the two only)")
    ap.add_argument("--context", action="append", metavar="FILE",
                    help="author material the rewrite could draw on (repeatable); "
                         "anything here counts as sourced, not invented")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--quiet", action="store_true", help="print only the status line")
    ap.add_argument("--max-items", type=int, default=12, dest="max_items",
                    help="items listed per kind (default %(default)s)")
    args = ap.parse_args(argv)

    if args.original == "-" and args.rewrite == "-":
        ap.error("only one of original and rewrite can read from stdin")

    try:
        original = read_target(args.original)
        rewrite = read_target(args.rewrite)
        context = "\n\n".join(read_target(path) for path in args.context or [])
    except OSError as exc:
        print("cannot read %s: %s" % (exc.filename, exc.strerror), file=sys.stderr)
        return EXIT_ERROR

    result = invariants.compare(original, rewrite, context or None)

    if args.json:
        json.dump(dict(result, status="ok" if result["ok"] else "changed"), sys.stdout, indent=2)
        print()
    elif args.quiet:
        print("invariants: %s" % ("ok" if result["ok"] else "CHANGED"))
    else:
        print(render(result, args.max_items))
        if not result["ok"]:
            print("  restore missing spans verbatim; remove additions, or mark them [SOURCE NEEDED]")
    return EXIT_OK if result["ok"] else EXIT_CHANGED


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        os._exit(0)
