#!/usr/bin/env python3
"""Style alignment: measure a target text against a baseline on a focused panel
of length-stable, LLM-controllable stylometric measures.

The heavy analysis is delegated to the existing stylometry skill
(``stylometry-report``). This script only orchestrates the two texts, extracts
the alignment panel from the JSON output, compares baseline / previous target /
current target, and writes the baseline and comparison reports.

It is intentionally stdlib-only, so it can run with the system Python. The
stylometry wrapper bootstraps its own virtualenv.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import statistics
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

DEFAULT_STYLOMETRY = Path.home() / ".pi/agent/skills/stylometry/scripts/stylometry-report"
STATE_FILE = "state.json"
PANEL_VERSION = 3
STATUS_ORDER = {"matched": 0, "close": 1, "off": 2}


# ---------------------------------------------------------------------------
# Panel definition
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Metric:
    id: str
    label: str
    family: str
    key: str
    attr: str
    weight: float
    floor: float
    digits: int = 4
    unit: str = ""
    dist: str | None = None
    up: str = ""
    down: str = ""
    couples: str = ""
    optional: str | None = None  # "fiction", "verse", or "extras"
    source: str = "engine"  # "engine" (stylometry JSON) or "derived" (paragraph stats)


# The panel follows evidence/style-matching-control-panel.md in the stylometry
# skill: fixed-window means and fixed-denominator proportions/densities only.
PANEL: list[Metric] = [
    # Sentence geometry
    Metric(
        "mean_sentence_length", "Mean sentence length", "Sentence geometry",
        "sentence_stats", "mean_sentence_length", 1.0, 1.0, 2, "words",
        "mean_sentence_length_dist",
        "Merge sentences or add clauses.",
        "Split sentences at clause boundaries.",
        "FK, Fog, ARI, CLI, sentence rhythm, punctuation",
    ),
    Metric(
        "sentence_length_std", "Sentence-length SD", "Sentence geometry",
        "sentence_stats", "sentence_length_std", 1.0, 1.0, 2, "words",
        "sentence_length_std_dist",
        "Mix very short and long sentences.",
        "Make sentence lengths more uniform.",
        "Mean sentence length, sentence rhythm, readability",
    ),
    Metric(
        "simple_ratio", "Simple-sentence ratio", "Sentence geometry",
        "sentence_types", "simple_ratio", 0.5, 0.03, 4, "ratio",
        "simple_ratio_dist",
        "Write a bare subject-verb-object sentence and stop it.",
        "Attach a clause or a modifier to every sentence.",
        "Mean sentence length, clausal density, coordination index, sentence-length SD",
    ),
    Metric(
        "mean_t_unit_length", "Mean T-unit length", "Sentence geometry",
        "advanced", "mean_t_unit_length", 0.25, 2.0, 2, "words",
        "mean_t_unit_length_dist",
        "Lengthen the clause: put the modifiers inside it rather than adding clauses.",
        "Shorten clauses; move material out to a second clause or sentence.",
        "Clausal density, mean sentence length, dependency distance",
    ),
    # Paragraphing
    Metric(
        "mean_paragraph_words", "Paragraph length (words)", "Paragraphing",
        "derived", "paragraph_words_mean", 0.75, 10.0, 1, "words", None,
        "Develop each paragraph further, or merge two into one.",
        "Break a paragraph where the topic moves, or cut filler sentences.",
        "Paragraph-length SD, paragraph length (sentences), sentence geometry",
        optional=None, source="derived",
    ),
    Metric(
        "paragraph_words_std", "Paragraph-length SD (words)", "Paragraphing",
        "derived", "paragraph_words_std", 0.5, 8.0, 1, "words", None,
        "Mix long developed paragraphs with short ones.",
        "Make paragraphs more uniform in size.",
        "Paragraph length (words), sentence-length SD",
        optional=None, source="derived",
    ),
    Metric(
        "mean_paragraph_length", "Paragraph length (sentences)", "Paragraphing",
        "cohesion", "mean_paragraph_length", 0.5, 0.5, 2, "sentences", None,
        "Merge paragraphs, or add sentences to each.",
        "Split paragraphs at topic breaks.",
        "Paragraph length (words), paragraph topic consistency, sentence geometry",
    ),
    Metric(
        "paragraph_topic_consistency", "Paragraph topic consistency", "Paragraphing",
        "cohesion", "paragraph_topic_consistency", 0.5, 0.04, 4, "ratio", None,
        "Keep one topic per paragraph; make the topic sentence explicit.",
        "Let a paragraph carry two topics, or open one before the turn.",
        "Paragraph length, content-word overlap, mean sentence similarity",
    ),
    # Word weight
    Metric(
        "mean_syllables_per_word", "Mean syllables per word", "Word weight",
        "rhythm", "mean_syllables_per_word", 0.75, 0.02, 3, "syllables", None,
        "Use polysyllabic or Latinate words.",
        "Use short or Germanic words.",
        "Readability, word length, formality",
    ),
    Metric(
        "avg_word_length", "Average word length", "Word weight",
        "character", "avg_word_length", 0.5, 0.05, 2, "chars",
        "avg_word_length_dist",
        "Use longer words.",
        "Use shorter words.",
        "Syllables, readability, formality",
    ),
    # Readability
    Metric(
        "flesch_kincaid_grade", "Flesch-Kincaid grade", "Readability",
        "flesch", "grade_level", 1.0, 0.5, 2, "grade", "grade_level_dist",
        "Longer sentences and polysyllables.",
        "Split sentences and simplify vocabulary.",
        "All readability formulas, sentence geometry",
    ),
    Metric(
        "dale_chall_difficult_ratio", "Dale-Chall difficult-word ratio",
        "Readability", "dale_chall", "difficult_word_ratio", 1.0, 0.02, 4,
        "ratio", "difficult_word_ratio_dist",
        "Use words outside the Dale-Chall 3,000 list.",
        "Use familiar everyday words.",
        "Rare-word ratio, frequency rank, syllables",
    ),
    # Lexical diversity and repetition
    Metric(
        "mattr", "MATTR (window 50)", "Lexical diversity",
        "mattr", "mattr_score", 1.0, 0.02, 4, "ratio", "mattr_score_dist",
        "Use synonyms and paraphrase; vary local vocabulary.",
        "Repeat key words within 50-word windows.",
        "MTLD, Yule, rare-word ratio, readability",
    ),
    Metric(
        "mtld", "MTLD", "Lexical diversity",
        "mtld", "mtld_average", 0.75, 3.0, 2, "score", "mtld_average_dist",
        "Spread new types evenly; vary vocabulary.",
        "Cluster repeated words.",
        "MATTR, Yule, hapax ratio",
    ),
    Metric(
        "yule_k", "Yule's K", "Lexical repetition",
        "yule", "yule_k", 0.75, 5.0, 2, "score", "yule_k_dist",
        "Repeat a few high-frequency content words.",
        "Remove tics and refrains.",
        "MATTR, MTLD (inverse)",
    ),
    Metric(
        "rare_word_ratio", "Rare-word ratio", "Vocabulary",
        "freq_soph", "rare_word_ratio", 0.5, 0.02, 4, "ratio",
        "rare_word_ratio_dist",
        "Use technical, specific, or archaic words.",
        "Use everyday words.",
        "Dale-Chall, syllables, readability",
    ),
    # POS profile
    Metric(
        "noun_verb_ratio", "Noun-verb ratio", "POS profile",
        "pos", "noun_verb_ratio", 0.75, 0.2, 3, "ratio",
        "noun_verb_ratio_dist",
        "Nominalize verbs.",
        "Verbalize nouns.",
        "Lexical density, passive, formality, syllables",
    ),
    Metric(
        "lexical_density", "Lexical density", "POS profile",
        "pos", "lexical_density", 0.75, 0.01, 4, "ratio",
        "lexical_density_dist",
        "Use content words; drop function words.",
        "Use pronouns and prepositions.",
        "Noun ratio, readability",
    ),
    Metric(
        "adjective_ratio", "Adjective ratio", "POS profile",
        "pos", "adjective_ratio", 0.5, 0.01, 4, "ratio",
        "adjective_ratio_dist",
        "Add attributive adjectives.",
        "Use concrete nouns and verbs.",
        "Word length, readability",
    ),
    Metric(
        "adverb_ratio", "Adverb ratio", "POS profile",
        "pos", "adverb_ratio", 0.5, 0.01, 4, "ratio",
        "adverb_ratio_dist",
        "Add -ly and degree adverbs.",
        "Use strong verbs.",
        "Syllables, word length",
    ),
    # Syntax
    Metric(
        "passive_ratio", "Passive-voice ratio", "Syntax",
        "advanced", "passive_voice_ratio", 1.0, 0.02, 4, "ratio",
        "passive_voice_ratio_dist",
        "Use be/get + past participle.",
        "Use active voice.",
        "Impersonal density, formality, noun ratio",
    ),
    Metric(
        "clausal_density", "Clausal density", "Syntax",
        "advanced", "clausal_density", 0.75, 0.2, 3, "ratio",
        "clausal_density_dist",
        "Add clauses per T-unit.",
        "Use simple sentences.",
        "Sentence length, parse depth, punctuation",
    ),
    Metric(
        "dependency_distance", "Mean dependency distance", "Syntax",
        "advanced", "dependency_distance", 0.5, 0.3, 3, "tokens",
        "dependency_distance_dist",
        "Postpose modifiers; add parentheticals.",
        "Use canonical adjacent SVO.",
        "Parse depth, readability",
    ),
    Metric(
        "coordination_index", "Coordination index", "Syntax",
        "advanced", "coordination_index", 0.5, 0.02, 3, "ratio",
        "coordination_index_dist",
        "Join clauses with and/but/or.",
        "Use subordination, apposition, or separate sentences instead of coordinating.",
        "Compound sentence ratio, additive connectives, clausal density",
    ),
    Metric(
        "mean_parse_tree_depth", "Mean parse-tree depth", "Syntax",
        "advanced", "mean_parse_tree_depth", 0.5, 0.4, 2, "levels",
        "mean_parse_tree_depth_dist",
        "Nest modifiers: relative clauses, participial phrases, stacked PPs.",
        "Flatten toward SVO and fewer nested modifiers.",
        "Dependency distance, clausal density, T-unit length",
    ),
    Metric(
        "subordination_index", "Subordination index", "Syntax",
        "advanced", "subordination_index", 0.5, 0.02, 4, "ratio",
        "subordination_index_dist",
        "Subordinate with because/although/which/when.",
        "Coordinate, or cut to a separate sentence.",
        "Coordination index, clausal density, dependent clause ratio",
    ),
    Metric(
        "preposition_ratio", "Preposition ratio", "Syntax",
        "function_words", "preposition_ratio", 0.5, 0.01, 4, "ratio", None,
        "Build explicit prepositional phrases (of, in, for, with).",
        "Use verb particles, possessives, and compounds in place of PPs.",
        "Determiner ratio, dependency distance, parse depth, sentence length",
    ),
    Metric(
        "determiner_ratio", "Determiner ratio", "Syntax",
        "function_words", "determiner_ratio", 0.25, 0.01, 4, "ratio", None,
        "Put an article or determiner with every noun.",
        "Use bare plurals, proper names, and pronouns.",
        "Preposition ratio, noun-verb ratio, lexical density",
    ),
    # Voice and markers
    Metric(
        "contraction_ratio", "Contraction ratio", "Voice and markers",
        "markers", "contraction_ratio", 0.75, 0.01, 4, "ratio", None,
        "Use don't / I'm / it's.",
        "Use do not / I am / it is.",
        "Formality, first person, readability",
    ),
    Metric(
        "negation_density", "Negation density", "Voice and markers",
        "markers", "negation_density", 0.5, 0.15, 2, "per 100 words", None,
        "Define by contrast: not X but Y, never, no.",
        "State what is the case; keep at most one negation per point.",
        "Adversative connectives, pronoun density, formality",
    ),
    Metric(
        "hedging_density", "Hedging density", "Voice and markers",
        "markers", "hedging_density", 0.25, 0.15, 2, "per 100 words", None,
        "Hedge with perhaps/maybe/about/roughly.",
        "Assert directly where the evidence allows.",
        "Adverb ratio, modal density, intensifier density",
    ),
    Metric(
        "modal_density", "Modal density", "Voice and markers",
        "markers", "modal_density", 0.25, 0.15, 2, "per 100 words", None,
        "Use can/could/may/must/should/will.",
        "State the claim without a modal.",
        "Hedging density, passive ratio, formality",
    ),
    Metric(
        "intensifier_density", "Intensifier density", "Voice and markers",
        "markers", "intensifier_density", 0.25, 0.15, 2, "per 100 words", None,
        "Qualify with more/very/so/most.",
        "Drop the intensifier; let the verb or the noun carry the degree.",
        "Adverb ratio, hedging density, modal density",
    ),
    # Cohesion
    Metric(
        "pronoun_density", "Pronoun density", "Cohesion",
        "cohesion", "pronoun_density", 0.75, 2.0, 2, "per 100 words", None,
        "Use first/second person and dialogue.",
        "Use repeated full noun phrases.",
        "Formality, noun ratio, lexical density",
    ),
    Metric(
        "demonstrative_density", "Demonstrative density", "Cohesion",
        "cohesion", "demonstrative_density", 0.25, 0.2, 2, "per 100 words", None,
        "Point with this/that/these/those.",
        "Repeat the full noun phrase instead.",
        "Pronoun density, content-word overlap, mean sentence similarity",
    ),
    Metric(
        "connective_density", "Connective density", "Cohesion",
        "cohesion", "connective_density", 0.75, 0.5, 2, "per 100 words", None,
        "Add however/therefore/moreover/then.",
        "Use parataxis.",
        "Cohesion, syllables, punctuation",
    ),
    # Punctuation
    Metric(
        "punctuation_density", "Punctuation density", "Punctuation",
        "character", "punctuation_density", 0.25, 0.5, 2, "per 100 words",
        "punctuation_density_dist",
        "Add commas, semicolons, dashes, or parentheses.",
        "Strip optional punctuation.",
        "The individual punctuation densities below",
    ),
    Metric(
        "semicolon_density", "Semicolon density", "Punctuation",
        "markers", "semicolon_density", 0.5, 0.15, 2, "per 100 words", None,
        "Join two independent clauses with a semicolon.",
        "Use a colon, a comma and conjunction, or a full stop.",
        "Punctuation density, mean sentence length, punctuation variety",
    ),
    Metric(
        "colon_density", "Colon density", "Punctuation",
        "markers", "colon_density", 0.25, 0.3, 2, "per 100 words", None,
        "Introduce lists, expansions, and appositions with a colon.",
        "Put the expansion in its own sentence.",
        "Semicolon density, punctuation density, sentence length",
    ),
    Metric(
        "dash_density", "Dash density", "Punctuation",
        "markers", "dash_density", 0.25, 0.1, 2, "per 100 words", None,
        "Add em-dash asides.",
        "Use commas or parentheses for the aside.",
        "Parenthetical density, punctuation density",
    ),
    Metric(
        "parenthetical_density", "Parenthetical density", "Punctuation",
        "markers", "parenthetical_density", 0.5, 0.5, 2, "per 100 words", None,
        "Set asides, glosses, and citations in parentheses; appose rather than co-ordinate.",
        "Fold the aside into the sentence, or drop it.",
        "Dash density, dependency distance, parse depth, sentence length",
    ),
    # Rhythm
    Metric(
        "sentence_length_alternation", "Sentence-length alternation", "Rhythm",
        "rhythm", "sentence_length_alternation", 0.5, 0.05, 3, "ratio", None,
        "Alternate long and short sentences.",
        "Make sentence lengths more uniform.",
        "Sentence-length SD, sentence rhythm",
    ),
    Metric(
        "word_bigram_entropy", "Word bigram entropy", "N-grams",
        "word_bigram", "entropy", 0.5, 0.2, 2, "bits", "entropy_dist",
        "Vary collocations.",
        "Use formulaic pairs.",
        "MATTR, punctuation",
    ),
    # Register
    Metric(
        "formality_score", "Formality score", "Register",
        "genre", "formality_score", 0.25, 2.0, 2, "0-100", None,
        "Latinate words, nominalization, passive; no first person.",
        "Contractions, first person, conversational markers.",
        "Its components below (Latinate, nominalization, passive, first person)",
    ),
    Metric(
        "latinate_ratio", "Latinate ratio", "Register",
        "genre", "latinate_ratio", 0.5, 0.01, 4, "ratio", None,
        "Prefer commence/utilise/demonstrate/require.",
        "Prefer start/use/show/need.",
        "Formality score, syllables per word, word length",
    ),
    Metric(
        "nominalization_density", "Nominalization density", "Register",
        "genre", "nominalization_density", 0.5, 0.3, 2, "per 100 words", None,
        "Turn predicates into -tion/-ment/-ness/-ity nouns.",
        "Verbalize: put the action back in a verb.",
        "Formality score, noun-verb ratio, passive",
    ),
    Metric(
        "first_person_ratio", "First-person ratio", "Register",
        "genre", "first_person_ratio", 0.5, 0.02, 4, "ratio", None,
        "Use I/we.",
        "Use third person or impersonal constructions.",
        "Pronoun density, formality",
    ),
    Metric(
        "dialogue_ratio", "Dialogue ratio", "Register",
        "genre", "dialogue_ratio", 0.5, 0.02, 4, "ratio", None,
        "Use quoted speech.",
        "Use narration.",
        "Pronoun density, sentence length, punctuation",
        "fiction",
    ),
    # Prosody (optional)
    Metric(
        "alliteration_density", "Alliteration density", "Prosody",
        "rhythm", "alliteration_density", 0.25, 0.2, 2, "per 100 words", None,
        "Repeat initial consonant sounds.",
        "Vary initial sounds.",
        "Word choice",
        "verse",
    ),
    Metric(
        "assonance_density", "Assonance density", "Prosody",
        "rhythm", "assonance_density", 0.25, 0.5, 2, "per 100 words", None,
        "Repeat vowel sounds.",
        "Vary vowel sounds.",
        "Word choice",
        "verse",
    ),
    # Repetition/slop (optional)
    Metric(
        "flagged_words_per_10k", "Flagged words per 10k", "Repetition/slop",
        "rep_uni", "flagged_words_per_10k", 0.25, 0.5, 2, "per 10k words", None,
        "Repeat content words more.",
        "Remove clichés and repeated content words.",
        "Yule, MATTR",
        "extras",
    ),
    Metric(
        "flagged_ngrams_per_10k", "Flagged n-grams per 10k", "Repetition/slop",
        "rep_ng", "flagged_per_10k", 0.25, 0.5, 2, "per 10k n-grams", None,
        "Repeat set phrases.",
        "Remove repeated phrases.",
        "Word bigram entropy, MATTR",
        "extras",
    ),
]

PANEL_BY_ID = {m.id: m for m in PANEL}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def fmt(value: Any, digits: int = 2) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if math.isnan(number) or math.isinf(number):
        return "—"
    return f"{number:.{digits}f}"


def fmt_signed(value: Any, digits: int = 2) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if math.isnan(number) or math.isinf(number):
        return "—"
    if abs(number) < 0.5 * (10 ** -digits):
        number = 0.0
    return f"{number:+.{digits}f}"


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"file not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON in {path}: {exc}")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise SystemExit(f"file not found: {path}")


def parse_ids(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def validate_ids(ids: list[str], flag: str) -> None:
    unknown = [i for i in ids if i not in PANEL_BY_ID]
    if unknown:
        known = ", ".join(m.id for m in PANEL)
        raise SystemExit(f"unknown metric id(s) for {flag}: {', '.join(unknown)}\nknown: {known}")


def default_workdir(target: Path) -> Path:
    return target.parent / f"{target.stem}.style-alignment"


def word_count(path: Path) -> str:
    text = read_text(path)
    return f"{len(text.split()):,}"


# ---------------------------------------------------------------------------
# Apparatus stripping and paragraph statistics
# ---------------------------------------------------------------------------

FOOTNOTE_DEF = re.compile(r"^\s{0,3}\[\^[^\]]+\]:")
INLINE_NOTE_LINE = re.compile(r"^\s{0,3}\[\^[^\]]+\]\s")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
RULE = re.compile(r"^\s*([-*_])\1{2,}\s*$")
TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def strip_apparatus(text: str) -> tuple[str, dict[str, int]]:
    """Reduce a document to the prose under study, and count what was removed.

    Removed: YAML frontmatter, fenced code, headings, horizontal rules, table
    rows, footnote definitions (with their indented continuation lines),
    footnote reference markers, figure/image embeds, and HTML comments.
    Kept: paragraphs, block quotations, lists, inline math.

    Footnote apparatus is not the prose whose style is being compared. Left in,
    the notes' own conventions drive the numbers: in the run that prompted this,
    250 of a chapter's 323 semicolons sat in citation footnotes, so the
    punctuation family reported a tenfold gap where the body prose had fourfold;
    and 64 one-to-three-sentence notes dragged the paragraph statistics down by
    roughly a fifth. Headings and table rows are removed for the same reason:
    each one is a "paragraph" of two to ten words.
    """
    stats = {
        "footnote_definitions": 0,
        "headings": 0,
        "table_rows": 0,
        "images": 0,
    }
    lines = text.lstrip("\ufeff\n\r\t ").splitlines()
    kept: list[str] = []
    i, n = 0, len(lines)
    lead = 0
    while lead < n and not lines[lead].strip():
        lead += 1
    if lead < n and lines[lead].strip().lstrip("\ufeff").strip() == "---":
        close = lead + 1
        while close < n and lines[close].strip() != "---":
            close += 1
        if close < n:  # a terminated frontmatter block only
            i = close + 1
    in_code = False
    seen_definition = False
    while i < n:
        line = lines[i]
        if FENCE.match(line):
            in_code = not in_code
            i += 1
            continue
        if in_code:
            i += 1
            continue
        # A definition is `[^12]: text`. Some files write the note text straight
        # after the marker with no colon; once the notes have started, such a
        # line is a note too, not body prose.
        is_definition = bool(FOOTNOTE_DEF.match(line)) or (
            seen_definition and bool(INLINE_NOTE_LINE.match(line))
        )
        if is_definition:
            seen_definition = True
            stats["footnote_definitions"] += 1
            i += 1
            while i < n and (
                not lines[i].strip()
                or lines[i].startswith("    ")
                or lines[i].startswith("\t")
            ):
                i += 1
            continue
        if HEADING.match(line):
            stats["headings"] += 1
            i += 1
            continue
        if RULE.match(line):
            i += 1
            continue
        if TABLE_ROW.match(line):
            stats["table_rows"] += 1
            i += 1
            continue
        kept.append(line)
        i += 1
    text = "\n".join(kept)
    stats["images"] = len(re.findall(r"!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)", text))
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL)
    text = re.sub(r"!\[\[[^\]]*\]\]", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[\^[^\]]+\]", "", text)
    text = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"(?m)^[ \t]{0,3}>[ \t]?", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n", stats


def paragraph_stats(text: str) -> dict[str, float | None]:
    """Paragraph count, mean length in words, and length SD.

    Paragraphs are blank-line-separated blocks, the same segmentation the
    stylometry engine's ``paragraph_count`` uses. A document with fewer than
    three blocks has no meaningful paragraph geometry, so the values are
    returned as ``None`` and the panel marks them unavailable.
    """
    blocks = [b for b in re.split(r"\n[ \t]*\n", text) if b.strip()]
    sizes = [len(b.split()) for b in blocks]
    if len(sizes) < 3:
        return {
            "paragraph_count": None,
            "paragraph_words_mean": None,
            "paragraph_words_std": None,
        }
    return {
        "paragraph_count": float(len(sizes)),
        "paragraph_words_mean": statistics.fmean(sizes),
        "paragraph_words_std": statistics.pstdev(sizes),
    }


def prepare_analysis_copy(
    path: Path,
    workdir: Path,
    name: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    """Write the copy that is actually measured, and describe what was removed.

    The file is kept in ``raw/`` so the measurement can be audited: every number
    in the reports refers to this text, not to the source file.
    """
    text = read_text(path)
    if settings.get("strip_apparatus", True):
        measured, removed = strip_apparatus(text)
    else:
        measured, removed = text, {}
    out = workdir / "raw" / f"{name}.analysis.md"
    out.write_text(measured if measured.endswith("\n") else measured + "\n", encoding="utf-8")
    return {
        "path": str(out),
        "stripped": bool(settings.get("strip_apparatus", True)),
        "removed": removed,
        "words_original": len(text.split()),
        "words_measured": len(measured.split()),
        "derived": paragraph_stats(measured),
    }


def apparatus_summary(info: dict[str, Any] | None) -> str:
    """One line describing what was measured, for the report headers."""
    if not info:
        return "not recorded"
    removed = info.get("removed") or {}
    parts = []
    if removed.get("footnote_definitions"):
        parts.append(f"{removed['footnote_definitions']} footnote definitions")
    if removed.get("headings"):
        parts.append(f"{removed['headings']} headings")
    if removed.get("table_rows"):
        parts.append(f"{removed['table_rows']} table rows")
    if removed.get("images"):
        parts.append(f"{removed['images']} images")
    what = (
        "apparatus stripped (" + ", ".join(parts) + ")"
        if parts
        else ("apparatus stripping on, nothing removed" if info.get("stripped")
              else "apparatus stripping off")
    )
    derived = info.get("derived") or {}
    paragraphs = derived.get("paragraph_count")
    in_paragraphs = f" in {int(paragraphs):,} paragraphs" if paragraphs else ""
    return (
        f"{what}; measured {info.get('words_measured', 0):,} of "
        f"{info.get('words_original', 0):,} words{in_paragraphs}"
    )


# ---------------------------------------------------------------------------
# Analysis via the stylometry skill
# ---------------------------------------------------------------------------


def stylometry_report_path() -> Path:
    import os

    raw = os.environ.get("STYLOMETRY_REPORT")
    path = Path(raw) if raw else DEFAULT_STYLOMETRY
    if not path.is_file():
        raise SystemExit(
            "stylometry-report not found.\n"
            f"expected: {path}\n"
            "Install/keep the stylometry skill, or set STYLOMETRY_REPORT to its script."
        )
    return path


def selected(m: Metric, settings: dict[str, Any]) -> bool:
    only = settings.get("only") or []
    skip = settings.get("skip") or []
    if only:
        return m.id in only
    if m.id in skip:
        return False
    if m.optional == "fiction" and not settings.get("fiction"):
        return False
    if m.optional == "verse" and not settings.get("verse"):
        return False
    if m.optional == "extras" and not settings.get("extras"):
        return False
    return True


def sections_for(settings: dict[str, Any]) -> list[str]:
    sections = [
        "lexical", "readability", "syntactic", "character", "ngrams",
        "markers", "genre", "cohesion", "prosody",
    ]
    if settings.get("extras"):
        sections.append("extras")
    return sections


def analyze_text(
    text_path: Path,
    name: str,
    workdir: Path,
    settings: dict[str, Any],
    verbose: bool = False,
) -> dict[str, Any]:
    """Run stylometry-report on one text and return the raw JSON payload."""
    raw_dir = workdir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    json_path = raw_dir / f"{name}.stylometry.json"
    report_path = raw_dir / f"{name}.stylometry.md"
    log_path = raw_dir / f"{name}.analysis.log"

    cmd = [
        str(stylometry_report_path()),
        str(text_path),
        "--json", str(json_path),
        "-o", str(report_path),
        "--quiet",
        "--all-metrics",
        "--sections", ",".join(sections_for(settings)),
    ]
    if settings.get("strip_markdown", True):
        cmd.append("--strip-markdown")
    else:
        cmd.append("--no-strip-markdown")

    if verbose:
        print("running:", " ".join(cmd), file=sys.stderr)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=settings.get("timeout", 1800),
        )
    except subprocess.TimeoutExpired:
        raise SystemExit(f"stylometry analysis timed out for {text_path}")
    log_path.write_text(
        (proc.stdout or "") + "\n" + (proc.stderr or ""),
        encoding="utf-8",
    )
    if proc.returncode != 0:
        tail = "\n".join(log_path.read_text(encoding="utf-8").splitlines()[-40:])
        raise SystemExit(f"stylometry analysis failed for {text_path}\n{tail}")
    if verbose and proc.stderr.strip():
        print(proc.stderr, file=sys.stderr)
    if not json_path.is_file():
        raise SystemExit(f"stylometry analysis did not produce {json_path}")
    return read_json(json_path)


def extract_panel(payload: dict[str, Any], derived: dict[str, Any] | None = None) -> dict[str, Any]:
    """Extract every panel value (including optional metrics) from raw JSON.

    ``derived`` carries the paragraph statistics computed by this script on the
    measured copy; those metrics read from it instead of the engine's JSON.
    """
    metrics = payload.get("metrics") or {}
    out: dict[str, Any] = {}
    for m in PANEL:
        value: float | None = None
        sd: float | None = None
        if m.source == "derived":
            raw_value = (derived or {}).get(m.attr)
            if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
                candidate = float(raw_value)
                if not (math.isnan(candidate) or math.isinf(candidate)):
                    value = candidate
            out[m.id] = {"value": value, "sd": None}
            continue
        node = metrics.get(m.key)
        if isinstance(node, dict):
            raw_value = node.get(m.attr)
            if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
                candidate = float(raw_value)
                if not (math.isnan(candidate) or math.isinf(candidate)):
                    value = candidate
            if m.dist and isinstance(node.get(m.dist), dict):
                raw_sd = node[m.dist].get("std")
                if isinstance(raw_sd, (int, float)) and not isinstance(raw_sd, bool):
                    candidate = float(raw_sd)
                    if not (math.isnan(candidate) or math.isinf(candidate)):
                        sd = candidate
        out[m.id] = {"value": value, "sd": sd}
    return {
        "panel_version": PANEL_VERSION,
        "meta": payload.get("meta", {}),
        "skipped": payload.get("skipped", []),
        "metrics": out,
    }


def classify_z(z: float | None, matched_z: float, close_z: float) -> str:
    if z is None:
        return "unavailable"
    az = abs(z)
    if az <= matched_z:
        return "matched"
    if az <= close_z:
        return "close"
    return "off"


def effective_sigma(metric: Metric, baseline: dict[str, Any]) -> float:
    entry = (baseline.get("metrics") or {}).get(metric.id) or {}
    sd = entry.get("sd")
    try:
        sd_f = float(sd) if sd is not None else 0.0
    except (TypeError, ValueError):
        sd_f = 0.0
    if math.isnan(sd_f) or math.isinf(sd_f):
        sd_f = 0.0
    return max(sd_f, metric.floor)


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def compare_panels(
    panel: list[Metric],
    baseline: dict[str, Any],
    previous: dict[str, Any] | None,
    current: dict[str, Any],
    settings: dict[str, Any],
) -> tuple[list[dict[str, Any]], float | None, dict[str, int], dict[str, int]]:
    rows: list[dict[str, Any]] = []
    counts = {"matched": 0, "close": 0, "off": 0, "unavailable": 0}
    movement = {"toward": 0, "away": 0, "unchanged": 0, "no_previous": 0}
    total_weight = 0.0
    total = 0.0
    matched_z = float(settings.get("matched_z", 0.5))
    close_z = float(settings.get("close_z", 1.0))

    for m in panel:
        if not selected(m, settings):
            continue
        b_entry = (baseline.get("metrics") or {}).get(m.id) or {}
        c_entry = (current.get("metrics") or {}).get(m.id) or {}
        b = b_entry.get("value")
        c = c_entry.get("value")
        p = None
        if previous is not None:
            p_entry = (previous.get("metrics") or {}).get(m.id) or {}
            p = p_entry.get("value")

        row: dict[str, Any] = {
            "metric": m,
            "baseline": b,
            "previous": p,
            "current": c,
            "sd": b_entry.get("sd"),
            "sigma": effective_sigma(m, baseline),
            "z": None,
            "z_before": None,
            "gap": None,
            "gap_before": None,
            "move": None,
            "move_pct": None,
            "move_threshold": None,
            "closure_pct": None,
            "toward": None,
            "status": "unavailable",
            "status_before": None,
            "status_change": None,
        }

        if b is None or c is None:
            counts["unavailable"] += 1
            if previous is None or p is None:
                movement["no_previous"] += 1
            rows.append(row)
            continue

        sigma = row["sigma"]
        gap = c - b
        z = gap / sigma if sigma > 0 else None
        move = (c - p) if p is not None else None
        move_pct = (100.0 * move / abs(p)) if (move is not None and p not in (None, 0)) else None
        move_threshold = 0.25 * sigma

        if z is None:
            status = "unavailable"
            counts["unavailable"] += 1
        else:
            status = classify_z(z, matched_z, close_z)
            counts[status] += 1
            total_weight += m.weight
            total += m.weight * min(z * z, 9.0)

        # Before/after detail: the previous iteration's own gap and status, how
        # much of the gap this iteration closed, and whether the status moved.
        gap_before = None
        z_before = None
        status_before = None
        closure_pct = None
        status_change = None
        if p is not None:
            gap_before = p - b
            z_before = gap_before / sigma if sigma > 0 else None
            status_before = classify_z(z_before, matched_z, close_z)
            if gap_before != 0 and gap is not None:
                closure_pct = 100.0 * (abs(gap_before) - abs(gap)) / abs(gap_before)
            if status_before in STATUS_ORDER and status in STATUS_ORDER:
                before_rank = STATUS_ORDER[status_before]
                after_rank = STATUS_ORDER[status]
                if after_rank < before_rank:
                    status_change = "improved"
                elif after_rank > before_rank:
                    status_change = "worsened"
                else:
                    status_change = "unchanged"

        toward = None
        if previous is not None and p is not None:
            prev_gap = p - b
            if move is None or abs(move) < move_threshold:
                toward = "unchanged"
            elif prev_gap == 0:
                toward = "away"
            elif prev_gap * move < 0:
                toward = "toward"
            else:
                toward = "away"
            movement[toward] = movement.get(toward, 0) + 1
        else:
            movement["no_previous"] += 1

        row.update({
            "z": z,
            "z_before": z_before,
            "gap": gap,
            "gap_before": gap_before,
            "move": move,
            "move_pct": move_pct,
            "move_threshold": move_threshold,
            "closure_pct": closure_pct,
            "toward": toward,
            "status": status,
            "status_before": status_before,
            "status_change": status_change,
        })
        rows.append(row)

    score = math.sqrt(total / total_weight) if total_weight > 0 else None
    return rows, score, counts, movement


def status_rank(row: dict[str, Any]) -> float:
    z = row.get("z")
    if z is None:
        return -1.0
    return row["metric"].weight * abs(z)


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def rough_profile_lines(panel: list[Metric], values: dict[str, Any], settings: dict[str, Any]) -> list[str]:
    def value(mid: str) -> float | None:
        entry = (values.get("metrics") or {}).get(mid) or {}
        v = entry.get("value")
        return float(v) if isinstance(v, (int, float)) else None

    lines: list[str] = []

    def add(mid: str, label: str, text: str) -> None:
        v = value(mid)
        if v is not None and selected(PANEL_BY_ID[mid], settings):
            m = PANEL_BY_ID[mid]
            unit = "" if m.unit in {"ratio", "score", "0-100"} else f" {m.unit}"
            lines.append(f"- **{label}**: {fmt(v, m.digits)}{unit} — {text}.")

    v = value("mean_sentence_length")
    if v is not None:
        add("mean_sentence_length", "Mean sentence length", "short" if v < 12 else "medium" if v <= 20 else "long")

    v = value("mean_paragraph_words")
    if v is not None:
        band = "short" if v < 70 else "medium" if v <= 140 else "long" if v <= 220 else "very long"
        add("mean_paragraph_words", "Paragraph length", band)

    v = value("paragraph_words_std")
    if v is not None:
        band = "uniform" if v < 40 else "varied" if v <= 90 else "very varied"
        add("paragraph_words_std", "Paragraph-length SD", band)

    v = value("sentence_length_std")
    if v is not None:
        add("sentence_length_std", "Sentence-length SD", "uniform" if v < 6 else "varied" if v <= 10 else "very varied")

    v = value("flesch_kincaid_grade")
    if v is not None:
        band = "easy" if v < 6 else "middle school" if v < 9 else "high school" if v < 12 else "college" if v < 16 else "difficult"
        add("flesch_kincaid_grade", "Flesch-Kincaid grade", band)

    v = value("mattr")
    if v is not None:
        add("mattr", "MATTR", "low local diversity" if v < 0.70 else "moderate local diversity" if v <= 0.80 else "high local diversity")

    v = value("mtld")
    if v is not None:
        add("mtld", "MTLD", "low diversity" if v < 50 else "moderate diversity" if v <= 70 else "high diversity")

    v = value("yule_k")
    if v is not None:
        add("yule_k", "Yule's K", "diverse/repetitive-light" if v < 100 else "moderate repetition" if v <= 150 else "highly repetitive")

    v = value("rare_word_ratio")
    if v is not None:
        add("rare_word_ratio", "Rare-word ratio", "common vocabulary" if v < 0.20 else "mixed vocabulary" if v <= 0.35 else "rare vocabulary")

    v = value("lexical_density")
    if v is not None:
        add("lexical_density", "Lexical density", "low" if v < 0.40 else "moderate" if v <= 0.50 else "high")

    v = value("passive_ratio")
    if v is not None:
        add("passive_ratio", "Passive-voice ratio", "low" if v < 0.08 else "moderate" if v <= 0.15 else "high")

    v = value("formality_score")
    if v is not None:
        add("formality_score", "Formality score", "informal" if v < 20 else "neutral" if v <= 40 else "formal" if v <= 60 else "very formal")

    v = value("punctuation_density")
    if v is not None:
        add("punctuation_density", "Punctuation density", "sparse" if v < 10 else "typical" if v <= 18 else "dense")

    v = value("pronoun_density")
    if v is not None:
        add("pronoun_density", "Pronoun density", "low" if v < 10 else "moderate" if v <= 18 else "high")

    v = value("connective_density")
    if v is not None:
        add("connective_density", "Connective density", "sparse" if v < 5 else "moderate" if v <= 9 else "dense")

    return lines


def render_baseline_report(
    baseline_path: Path,
    panel_data: dict[str, Any],
    settings: dict[str, Any],
    baseline_report_path: Path,
) -> str:
    meta = panel_data.get("meta") or {}
    selected_metrics = [m for m in PANEL if selected(m, settings)]
    lines: list[str] = []
    lines.append("# Style Alignment Baseline Report")
    lines.append("")
    lines.append(f"- **Baseline:** `{baseline_path}`")
    lines.append(f"- **Tokens (engine tokenizer):** {meta.get('token_count', '—')}")
    lines.append(f"- **Chunk size:** {settings.get('chunk_size', 1000)}")
    lines.append(f"- **Panel:** {len(selected_metrics)} metrics (version {PANEL_VERSION})")
    lines.append(f"- **Measured text:** {apparatus_summary(panel_data.get('apparatus'))}")
    lines.append(f"- **Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append("This is the reference profile. It uses only the length-stable,")
    lines.append("LLM-controllable measures selected in the stylometry skill's")
    lines.append("`evidence/style-matching-control-panel.md`. Counts, extrema,")
    lines.append("whole-document TTR/HD-D, labels, and confidence scores are excluded.")
    lines.append("")
    lines.append("## How the text was measured")
    lines.append("")
    lines.append("Before analysis the text is reduced to prose: YAML frontmatter, footnote")
    lines.append("definitions and their reference markers, headings, horizontal rules, table")
    lines.append("rows, code fences, figure embeds, and HTML comments are removed. The copy")
    lines.append("actually measured is kept in `raw/` next to the raw stylometry output.")
    lines.append("Footnote apparatus is not prose: its citation conventions would drive the")
    lines.append("punctuation and word-length numbers, and each note would count as a")
    lines.append("paragraph. Pass `--no-strip-apparatus` at `init` to measure the file as")
    lines.append("written instead (not recommended when the two texts carry unequal apparatus).")
    lines.append("")
    lines.append("## Baseline panel detail")
    lines.append("")
    lines.append("Every selected metric, one line each, with the tolerance and both levers.")
    lines.append("")
    lines.append("| Family | Metric | Baseline | Chunk SD | Tolerance | Wt | How to move it | Also moves |")
    lines.append("|---|---|---:|---:|---:|---:|---|---|")
    for m in selected_metrics:
        entry = (panel_data.get("metrics") or {}).get(m.id) or {}
        val = entry.get("value")
        sd = entry.get("sd")
        sd_text = fmt(sd, m.digits) if (sd is not None and sd > 0) else "—"
        tolerance = effective_sigma(m, panel_data)
        lever = f"↑ {m.up} · ↓ {m.down}"
        lines.append(
            f"| {m.family} | {m.label} | {fmt(val, m.digits)} | {sd_text} | "
            f"{fmt(tolerance, m.digits)} | {m.weight:.2f} | {lever} | {m.couples} |"
        )
    lines.append("")
    lines.append("`Chunk SD` is the baseline's internal spread across fixed windows,")
    lines.append("used as the tolerance. `Tolerance` is the effective value actually used:")
    lines.append("the chunk SD when it is larger than the panel's domain floor, otherwise")
    lines.append("the floor. A dash in `Chunk SD` means the measure is single-pass, so the")
    lines.append("floor alone sets the tolerance.")
    lines.append("")
    profile = rough_profile_lines(PANEL, panel_data, settings)
    if profile:
        lines.append("## Rough profile")
        lines.append("")
        lines.append("These bands are rough and genre-dependent. The baseline values, not")
        lines.append("the band labels, are the target.")
        lines.append("")
        lines.extend(profile)
        lines.append("")
    skipped = panel_data.get("skipped") or []
    if skipped:
        lines.append("## Unavailable / skipped")
        lines.append("")
        for item in skipped:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                lines.append(f"- {item[0]} — {item[1]}")
            else:
                lines.append(f"- {item}")
        lines.append("")
        lines.append("Unavailable metrics are excluded from the alignment score. A missing")
        lines.append("spaCy model is the usual cause for syntactic, cohesion, or genre")
        lines.append("metrics; see the stylometry skill's setup script.")
        lines.append("")
    else:
        lines.append("All selected panel metrics were computed.")
        lines.append("")
    if any(m.id == "dialogue_ratio" for m in selected_metrics):
        lines.append("Dialogue ratio uses straight-quote detection. Curly quotes may")
        lines.append("read as zero; verify the baseline's quote style before targeting it.")
        lines.append("")
    lines.append("## Next")
    lines.append("")
    lines.append(f"1. Run the humanizer detection pass on the target copy")
    lines.append(f"   (`target-iter-00.md` in the work directory).")
    lines.append(f"2. Run `style-align compare` with `--humanizer-report` to create")
    lines.append(f"   `comparison-00.md`.")
    lines.append(f"3. Present the baseline and comparison, then ask whether to start")
    lines.append(f"   the first alignment iteration.")
    lines.append("")
    lines.append(f"Raw baseline JSON: `{baseline_report_path.with_suffix('.json')}`")
    lines.append(f"Raw stylometry report: `{baseline_report_path}`")
    lines.append("")
    return "\n".join(lines)


def direction_hint(row: dict[str, Any], settings: dict[str, Any]) -> str:
    z = row.get("z")
    if z is None:
        return "—"
    if abs(z) <= float(settings.get("matched_z", 0.5)):
        return "—"
    gap = row.get("gap")
    if gap is None:
        return "—"
    m: Metric = row["metric"]
    if gap > 0:
        return f"↓ {m.down}"
    if gap < 0:
        return f"↑ {m.up}"
    return "—"


def build_edit_plan(rows: list[dict[str, Any]], settings: dict[str, Any]) -> str:
    deviations = [
        r for r in rows
        if r.get("z") is not None
        and r.get("status") in ("off", "close")
        and abs(r["z"]) > float(settings.get("matched_z", 0.5))
    ]
    deviations.sort(key=status_rank, reverse=True)
    top = deviations[:5]

    lines: list[str] = []
    lines.append("## Edit plan")
    lines.append("")
    if not top:
        lines.append("All selected metrics are within tolerance. No further style edits are")
        lines.append("required. If the humanizer reports open findings, fix those and re-measure.")
        lines.append("")
        return "\n".join(lines)

    for i, r in enumerate(top, start=1):
        m: Metric = r["metric"]
        gap = r["gap"]
        z = r["z"]
        direction = "lower" if gap > 0 else "raise"
        hint = m.down if gap > 0 else m.up
        close_note = " (close; optional)" if r["status"] == "close" else ""
        line = (
            f"{i}. **{m.label}** — baseline {fmt(r['baseline'], m.digits)}, "
            f"target {fmt(r['current'], m.digits)}, gap {fmt_signed(gap, m.digits)} "
            f"(z {z:+.2f}). Move **{direction}**: {hint.rstrip('.')}.{close_note}"
        )
        if r.get("move") is not None:
            line += f" Last iteration: {fmt_signed(r['move'], m.digits)} ({r['toward']})."
        lines.append(line)
        if m.couples:
            lines.append(f"   Also moves: {m.couples}.")
        lines.append("")

    def gap_of(metric_id: str) -> float | None:
        """Gap to baseline for one member, from every row (not just the top five)."""
        for r in rows:
            if r["metric"].id == metric_id:
                g = r.get("gap")
                return float(g) if isinstance(g, (int, float)) else None
        return None

    lines.append("**Do not**")
    lines.append("")
    lines.append("- Do not change facts, names, numbers, citations, or paragraph order.")
    lines.append("- Do not stack unmeasured passes; apply one pass, then re-measure.")
    lines.append("- Do not introduce em dashes, AI vocabulary such as `furthermore`,")
    lines.append("  `pivotal`, `underscore`, or `foster`, or AI-style padding.")

    # Each permission is decided from that measure's own gap, not from which
    # metrics happen to be in the top five. A conflated check once told the
    # editor that adding passives was allowed while the passive measure was
    # above the baseline.
    def permission(metric_id: str, under: str, over: str) -> None:
        gap = gap_of(metric_id)
        if gap is None:
            return
        lines.append(under if gap < 0 else over)

    permission(
        "passive_ratio",
        "- Passive voice is under the baseline, so it is available where the actor is\n"
        "  unknown or irrelevant; do not go past the baseline's level.",
        "- Do not add passive voice; the target already uses more of it than the\n"
        "  baseline. Prefer the active construction where the actor is known.",
    )
    permission(
        "nominalization_density",
        "- Nominalizations are under the baseline's level, so nominalizing where the\n"
        "  action is genuinely the topic is allowed; do not exceed the baseline.",
        "- Do not nominalize to sound academic; the target already nominalizes more\n"
        "  than the baseline. Prefer the verb.",
    )
    permission(
        "mean_sentence_length",
        "- Do not split sentences; the target is already shorter than the baseline.\n"
        "  Merge sentences or add clauses instead.",
        "- Do not merge sentences; the target is already longer than the baseline.\n"
        "  Split at clause boundaries instead.",
    )
    permission(
        "sentence_length_std",
        "- Do not flatten sentence lengths; the target already varies less than the\n"
        "  baseline. Mix very short and long sentences.",
        "- Do not manufacture variation for its own sake; the target already varies\n"
        "  more than the baseline. Keep the short sentences you have.",
    )
    permission(
        "simple_ratio",
        "- Keep some one-clause sentences; the target has fewer than the baseline.",
        "- Do not chop sentences into bare simple sentences; the target already has\n"
        "  more of them than the baseline.",
    )
    permission(
        "mattr",
        "- Do not repeat key terms mechanically; the target is less diverse than the\n"
        "  baseline. Vary vocabulary and paraphrase.",
        "- Do not synonym-swap mechanically; the target is already more diverse than\n"
        "  the baseline. Repeat key terms where it helps.",
    )
    lines.append("- Run the humanizer pass after the style edits; do not ship obvious AI tells.")
    lines.append("")
    lines.append("Apply at paragraph level. Keep the original meaning and order. Then run")
    lines.append("`style-align compare` again.")
    lines.append("")
    return "\n".join(lines)


def render_humanizer_section(
    humanizer_path: Path | None,
    humanizer_text: str | None,
) -> str:
    lines: list[str] = []
    lines.append("## Humanizer findings")
    lines.append("")
    if humanizer_path is None:
        lines.append("No humanizer report was attached for this iteration.")
        lines.append("")
        lines.append("Run the humanizer detection pass on the target before the next")
        lines.append("iteration and pass the report with `--humanizer-report`. The style")
        lines.append("pass must not introduce obvious AI tells.")
        lines.append("")
        return "\n".join(lines)

    lines.append(f"Attached report: `{humanizer_path}`")
    lines.append("")
    lines.append("Fix only the findings the user approved. Preserve facts, quotes, and")
    lines.append("the writer's voice. The humanizer's `Never inject these` list is a hard")
    lines.append("constraint on every style edit.")
    lines.append("")
    if humanizer_text and humanizer_text.strip():
        lines.append("---")
        lines.append("")
        lines.append(humanizer_text.strip())
        lines.append("")
        lines.append("---")
        lines.append("")
    else:
        lines.append("The attached report is empty. Treat this as a clean humanizer pass.")
        lines.append("")
    return "\n".join(lines)


def render_summary_table(
    rows: list[dict[str, Any]],
    settings: dict[str, Any],
) -> str:
    lines: list[str] = []
    lines.append("## Summary table")
    lines.append("")
    lines.append(
        "| Family | Metric | Baseline | Before | After | Change | "
        "Gap before (z) | Gap after (z) | Status before → after | Next move |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---|---|")
    for r in rows:
        m: Metric = r["metric"]
        before = fmt(r["previous"], m.digits) if r.get("previous") is not None else "—"
        changed = fmt_signed(r["move"], m.digits) if r.get("move") is not None else "—"
        gap_before = _gap_cell(r.get("gap_before"), r.get("z_before"), m.digits)
        gap_after = _gap_cell(r.get("gap"), r.get("z"), m.digits)
        if r.get("status_before"):
            status_text = f"{r['status_before']} → {r['status']}"
        else:
            status_text = str(r.get("status"))
        lines.append(
            f"| {m.family} | {m.label} | {fmt(r['baseline'], m.digits)} | "
            f"{before} | {fmt(r['current'], m.digits)} | {changed} | {gap_before} | "
            f"{gap_after} | {status_text} | {direction_hint(r, settings)} |"
        )
    lines.append("")
    lines.append("`Before` is the previous iteration's value; `Change` is")
    lines.append("`After - Before`. `Gap` is the value minus the baseline, with `z`")
    lines.append("that gap divided by the baseline's chunk SD (or the panel floor).")
    lines.append("Status: matched `|z| <= {0}`, close `|z| <= {1}`, off otherwise.".format(
        settings.get("matched_z", 0.5), settings.get("close_z", 1.0),
    ))
    if any(r["metric"].id == "dialogue_ratio" for r in rows):
        lines.append("Dialogue ratio uses straight-quote detection; curly quotes may")
        lines.append("read as zero.")
    lines.append("")
    lines.append("The full before/after detail for every metric is in the")
    lines.append("`Detailed metric ledger` section below.")
    lines.append("")
    return "\n".join(lines)


def original_point(
    series: dict[str, dict[int, Any]] | None,
    metric_id: str,
) -> tuple[int | None, Any]:
    """The original target's value for a metric: iteration 00 when it is still
    on record, otherwise the earliest recorded iteration."""
    values = (series or {}).get(metric_id) or {}
    if not values:
        return None, None
    first = 0 if 0 in values else min(values)
    return first, values.get(first)


def cumulative_row(
    row: dict[str, Any],
    series: dict[str, dict[int, Any]] | None,
    iteration: int | None = None,
) -> dict[str, Any]:
    """Baseline, original target, current value, and how much of the original
    gap has been closed (in percent; negative means it moved away)."""
    m: Metric = row["metric"]
    first_it, original = original_point(series, m.id)
    baseline = row.get("baseline")
    current = row.get("current")
    change = (
        current - original
        if current is not None and original is not None
        else None
    )
    gap_closed = None
    sigma = row.get("sigma")
    z0 = (
        (original - baseline) / sigma
        if sigma and baseline is not None and original is not None
        else None
    )
    if (
        baseline is not None
        and current is not None
        and original is not None
        and original != baseline
        # A percentage of a gap that was already inside the close band is noise:
        # hedging at |z| 0.13 reads "-231%" for a move no one should care about.
        and (z0 is None or abs(z0) > 1.0)
    ):
        gap_closed = 100.0 * (abs(original - baseline) - abs(current - baseline)) / abs(
            original - baseline
        )
    # How much the gap-closed share itself moved since the previous iteration:
    # the aim is for this to be positive, iteration after iteration.
    gap_closed_prev = None
    if iteration is not None and iteration > 0:
        previous = ((series or {}).get(m.id) or {}).get(iteration - 1)
        if (
            previous is not None
            and gap_closed is not None
            and baseline is not None
            and original != baseline
        ):
            # the cumulative share as the previous iteration left it
            gap_closed_prev = 100.0 * (
                abs(original - baseline) - abs(previous - baseline)
            ) / abs(original - baseline)
    delta = (
        gap_closed - gap_closed_prev
        if gap_closed is not None and gap_closed_prev is not None
        else None
    )
    return {
        "metric": m,
        "original_iteration": first_it,
        "baseline": baseline,
        "original": original,
        "current": current,
        "change": change,
        "gap_closed": gap_closed,
        "gap_closed_prev": gap_closed_prev,
        "gap_closed_delta": delta,
    }


def render_cumulative_table(
    rows: list[dict[str, Any]],
    series: dict[str, dict[int, Any]] | None,
    iteration: int,
    settings: dict[str, Any],
) -> str:
    """Cumulative progress against the original target, one table per family.

    The summary table answers "what did this iteration change"; this one answers
    "how far have we come since the original text". `Gap closed` is the share of
    the original distance to the baseline that the text has covered, so 100%
    means the metric now sits on the baseline and a negative value means it has
    drifted away from it."""
    lines: list[str] = []
    lines.append("## Cumulative progress")
    lines.append("")
    cum = [cumulative_row(r, series, iteration) for r in rows]
    known = [c for c in cum if c["gap_closed"] is not None]
    first_iterations = sorted(
        {c["original_iteration"] for c in cum if c["original_iteration"] is not None}
    )
    ref = first_iterations[0] if first_iterations else 0

    lines.append(
        f"Every metric's distance from the baseline at the original target "
        f"(`{ref:02d}`) and now (`{iteration:02d}`). **`Gap closed` is the aim of "
        "the whole exercise**: 100% means the metric sits on the baseline. It is "
        "not always reachable: subject matter, technical vocabulary and genre "
        "leave some metrics legitimately far apart, and a few move against the "
        "baseline as the price of a larger gain elsewhere. What should rise is "
        "the number of metrics whose gap-closed share rises, and the size of "
        "those rises, from one iteration to the next. `—` marks a metric that "
        "was already inside the close band at the original text, where a "
        "percentage of a near-zero gap is noise rather than progress. The figure "
        "in parentheses is the change in points since the previous iteration: "
        "a positive number means this pass left the metric closer to the "
        "baseline than the last pass did, which is the only thing that has to "
        "keep improving."
    )
    lines.append("")
    if not known:
        lines.append("> Cumulative progress needs an iteration 00 on record.")
        lines.append("")
        return "\n".join(lines)

    family: str | None = None
    for c in cum:
        m: Metric = c["metric"]
        d = m.digits
        if m.family != family:
            if family is not None:
                lines.append("")
            family = m.family
            lines.append(f"### {family}")
            lines.append("")
            lines.append(
                f"| Metric | Baseline | Original ({ref:02d}) | "
                f"Iteration ({iteration:02d}) | Change | Gap closed |"
            )
            lines.append("|---|---:|---:|---:|---:|---:|")
        if c["current"] is None:
            row_cells = "— | — | — | —"
        else:
            change = (
                fmt_signed(c["change"], d) if c["change"] is not None else "—"
            )
            closed = "—"
            if c["gap_closed"] is not None:
                closed = f"{c['gap_closed']:+.0f}%"
                if c["gap_closed_delta"] is not None:
                    closed += f" ({c['gap_closed_delta']:+.0f})"
            row_cells = (
                f"{fmt(c['original'], d) if c['original'] is not None else '—'} | "
                f"{fmt(c['current'], d)} | {change} | {closed}"
            )
        lines.append(
            f"| {m.label} | {fmt(c['baseline'], d) if c['baseline'] is not None else '—'} | "
            f"{row_cells} |"
        )

    lines.append("")
    if iteration == 0:
        lines.append(
            "This is the original target, so every gap-closed share is 0 by "
            "definition. The column starts moving with the next iteration."
        )
        lines.append("")
        lines.append(
            "A metric that is capped in the weighted mismatch (any `|z|` above 3) "
            "can move a long way without changing D. Read this table for direction "
            "and the summary table above for what the last pass did."
        )
        lines.append("")
        return "\n".join(lines)

    improved = [c for c in known if c["gap_closed"] > 0.5]
    regressed = [c for c in known if c["gap_closed"] < -0.5]
    flat = [c for c in known if abs(c["gap_closed"]) <= 0.5]
    unknown = len(cum) - len(known)
    tally = (
        f"Since iteration {ref:02d}: **{len(improved)}** metrics closed part of "
        f"their gap, **{len(regressed)}** drifted further, **{len(flat)}** moved "
        "by less than half a per cent"
    )
    tally += (
        f", and **{unknown}** were already inside the close band at the original, "
        "where a percentage would be noise (shown `—`)."
        if unknown
        else "."
    )
    lines.append(tally)
    lines.append("")
    if regressed:
        names = ", ".join(
            f"{c['metric'].label} ({c['gap_closed']:+.0f}%)"
            for c in sorted(regressed, key=lambda c: c["gap_closed"])
        )
        lines.append(f"Drifted away: {names}.")
        lines.append("")
    lines.append(
        "A metric that is capped in the weighted mismatch (any `|z|` above 3) can "
        "move a long way without changing D. Read this table for direction and "
        "the summary table above for what the last pass did."
    )
    lines.append("")
    return "\n".join(lines)


def _gap_cell(gap: Any, z: Any, digits: int) -> str:
    if gap is None:
        return "—"
    if z is None:
        return fmt_signed(gap, digits)
    return f"{fmt_signed(gap, digits)} ({z:+.2f})"


def _unit_suffix(m: Metric) -> str:
    if not m.unit or m.unit in {"ratio", "score", "0-100"}:
        return ""
    return f" {m.unit}"


def _optional_note(m: Metric) -> str:
    return f" · {m.optional} only" if m.optional else ""


def _gap_detail(gap: Any, z: Any, status: Any, digits: int) -> str:
    text = fmt_signed(gap, digits)
    if z is not None:
        text += f" (z {z:+.2f}, {status})"
    return text


def render_metric_block(
    row: dict[str, Any],
    settings: dict[str, Any],
    iteration: int,
    previous_available: bool,
    series: dict[str, dict[int, Any]] | None,
) -> list[str]:
    """One metric, every measured value: baseline, before, after, movement,
    gap before/after, status before/after, trajectory, next move, coupling."""
    m: Metric = row["metric"]
    d = m.digits
    unit = _unit_suffix(m)
    sigma = row.get("sigma")
    sd = row.get("sd")
    lines: list[str] = [f"#### {m.label} (`{m.id}`)", ""]

    mode = (
        "chunked: tolerance = baseline chunk SD"
        if sd
        else "single-pass: tolerance = panel domain floor"
    )
    lines.append(
        f"- **Panel:** weight {m.weight:.2f} · {m.family} · {mode}"
        f"{_optional_note(m)}"
    )

    baseline = row.get("baseline")
    if baseline is None:
        lines.append("- **Baseline:** unavailable")
    elif sd:
        lines.append(
            f"- **Baseline:** {fmt(baseline, d)}{unit} · chunk SD {fmt(sd, d)} · "
            f"tolerance {fmt(sigma, d)} (domain floor {fmt(m.floor, d)})"
        )
    else:
        lines.append(
            f"- **Baseline:** {fmt(baseline, d)}{unit} · {fmt(sigma, d)} tolerance "
            f"(single-pass: domain floor {fmt(m.floor, d)})"
        )

    previous = row.get("previous")
    if previous_available and previous is not None:
        lines.append(f"- **Before** (iteration {iteration - 1:02d}): {fmt(previous, d)}{unit}")
    elif previous_available:
        lines.append(f"- **Before** (iteration {iteration - 1:02d}): unavailable")
    else:
        lines.append("- **Before:** — (initial analysis; there is no previous target)")

    current = row.get("current")
    if current is None:
        lines.append(f"- **After** (iteration {iteration:02d}): unavailable")
    else:
        lines.append(f"- **After** (iteration {iteration:02d}): {fmt(current, d)}{unit}")

    move = row.get("move")
    if previous_available and move is not None:
        pct = row.get("move_pct")
        pct_text = f" ({fmt_signed(pct, 2)}%)" if pct is not None else ""
        toward = row.get("toward")
        direction = {
            "toward": "toward the baseline",
            "away": "away from the baseline",
        }.get(toward or "", "no direction available")
        closure = row.get("closure_pct")
        if closure is None:
            closure_text = ""
        elif closure >= 0:
            closure_text = f" · {fmt(closure, 1)}% of the gap closed"
        else:
            closure_text = f" · gap widened by {fmt(abs(closure), 1)}%"
        lines.append(
            f"- **Change:** {fmt_signed(move, d)}{unit}{pct_text} · {direction}"
            f"{closure_text}"
        )
        threshold = row.get("move_threshold")
        if threshold is not None:
            if toward == "unchanged":
                lines.append(
                    f"- **Noise:** move {fmt(abs(move), d)} is within the noise threshold "
                    f"{fmt(threshold, d)} (0.25 × tolerance); treat as unchanged."
                )
            else:
                lines.append(
                    f"- **Noise:** movement threshold {fmt(threshold, d)} "
                    f"(0.25 × tolerance); the move of {fmt(abs(move), d)} exceeds it."
                )
    elif previous_available:
        lines.append("- **Change:** unavailable (one of the two values is missing)")
    else:
        lines.append("- **Change:** — (movement starts with the next iteration)")

    gap_before = row.get("gap_before")
    gap_after = row.get("gap")
    before_text = _gap_detail(gap_before, row.get("z_before"), row.get("status_before"), d)
    after_text = _gap_detail(gap_after, row.get("z"), row.get("status"), d)
    if gap_before is not None and gap_after is not None:
        change = row.get("status_change") or "unchanged"
        lines.append(f"- **Gap to baseline:** {before_text} before → {after_text} after · {change}")
    elif gap_before is not None:
        lines.append(f"- **Gap to baseline:** {before_text} before → unavailable after")
    elif gap_after is not None:
        lines.append(f"- **Gap to baseline:** {after_text}")
    else:
        lines.append("- **Gap to baseline:** unavailable")

    if series:
        entries = sorted(series.get(m.id, {}).items())
        if len(entries) >= 2:
            parts = [
                f"`{it:02d}` {fmt(v, d) if v is not None else '—'}"
                for it, v in entries
            ]
            parts.append(f"baseline {fmt(baseline, d)}")
            lines.append("- **Trajectory:** " + " → ".join(parts))

    cum = cumulative_row(row, series)
    if cum["gap_closed"] is not None:
        lines.append(
            "- **Gap closed since iteration "
            f"{cum['original_iteration']:02d}:** {cum['gap_closed']:+.0f}% "
            f"(original {fmt(cum['original'], d)} → now {fmt(cum['current'], d)})"
        )

    if row.get("status") == "unavailable" or current is None:
        lines.append(
            "- **Next move:** none — the metric is unavailable this iteration "
            "(see the unavailable section)."
        )
    else:
        hint = direction_hint(row, settings)
        lines.append(f"- **Next move:** {hint}" if hint != "—" else "- **Next move:** — (matched)")

    if m.couples:
        lines.append(f"- **Also moves:** {m.couples}")
    lines.append("")
    return lines


def render_metric_ledger(
    rows: list[dict[str, Any]],
    settings: dict[str, Any],
    iteration: int,
    previous_available: bool,
    series: dict[str, dict[int, Any]] | None,
) -> str:
    lines: list[str] = []
    lines.append("## Detailed metric ledger")
    lines.append("")
    lines.append(
        "Every selected metric, one block each, in panel order. Each block gives "
        "the baseline and its tolerance, the previous iteration's value (before), "
        "this iteration's value (after), the raw and percent change, how much of "
        "the gap that closed, the gap and z before and after, the status before "
        "and after, the value across all iterations, and the next move."
    )
    lines.append("")

    families: list[str] = []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        fam = r["metric"].family
        if fam not in grouped:
            grouped[fam] = []
            families.append(fam)
        grouped[fam].append(r)

    for fam in families:
        lines.append(f"### {fam}")
        lines.append("")
        for r in grouped[fam]:
            lines.extend(render_metric_block(
                r, settings, iteration, previous_available, series,
            ))

    off_panel = [m for m in PANEL if not selected(m, settings)]
    lines.append("### Metrics not in this run")
    lines.append("")
    if not off_panel:
        lines.append("Every panel metric is selected; nothing is left out.")
    else:
        lines.append(
            "These panel metrics were excluded, so they have no baseline or target "
            "values in this run:"
        )
        lines.append("")
        for m in off_panel:
            reason = {
                "fiction": "needs `--fiction` (or `--only`)",
                "verse": "needs `--verse` (or `--only`)",
                "extras": "needs extras, i.e. no `--no-extras` (or `--only`)",
            }.get(m.optional or "", "excluded by `--only`/`--skip`")
            lines.append(
                f"- **{m.label}** (`{m.id}`, {m.family}, weight {m.weight:.2f}) — {reason}"
            )
    lines.append("")
    return "\n".join(lines)


def render_movement_section(rows: list[dict[str, Any]], previous_available: bool) -> str:
    lines: list[str] = []
    lines.append("## Movement this iteration")
    lines.append("")
    if not previous_available:
        lines.append("This is the initial target analysis; there is no previous target")
        lines.append("to compare against. Movement starts with the next iteration.")
        lines.append("")
        return "\n".join(lines)

    all_moved = [r for r in rows if r.get("move") is not None]
    moved = [r for r in all_moved if r.get("toward") != "unchanged"]
    moved.sort(key=lambda r: abs(r["move"]), reverse=True)

    toward = sum(1 for r in all_moved if r.get("toward") == "toward")
    away = sum(1 for r in all_moved if r.get("toward") == "away")
    unchanged = sum(1 for r in all_moved if r.get("toward") == "unchanged")
    lines.append(f"Moved toward baseline: **{toward}**; away: **{away}**; unchanged: **{unchanged}**.")
    lines.append("")
    lines.append("Movement below 0.25× the effective tolerance counts as unchanged.")
    lines.append("")
    if not moved:
        lines.append("No movement exceeded the noise threshold (0.25× the effective")
        lines.append("tolerance). The raw values are still in the measurement table.")
        lines.append("")
        return "\n".join(lines)
    lines.append("Largest meaningful moves:")
    lines.append("")
    for r in moved[:5]:
        m: Metric = r["metric"]
        lines.append(
            f"- **{m.label}**: {fmt(r['previous'], m.digits)} → "
            f"{fmt(r['current'], m.digits)} ({fmt_signed(r['move'], m.digits)})."
        )
    lines.append("")
    return "\n".join(lines)


def render_unavailable_section(rows: list[dict[str, Any]], skipped: list[Any]) -> str:
    lines: list[str] = []
    lines.append("## Unavailable metrics")
    lines.append("")
    unavailable = [r for r in rows if r["status"] == "unavailable"]
    if not unavailable and not skipped:
        lines.append("All selected metrics were available.")
        lines.append("")
        return "\n".join(lines)
    if unavailable:
        for r in unavailable:
            lines.append(f"- {r['metric'].family}: {r['metric'].label}")
    if skipped:
        lines.append("")
        lines.append("Analysis warnings:")
        lines.append("")
        for item in skipped:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                lines.append(f"- {item[0]} — {item[1]}")
            else:
                lines.append(f"- {item}")
    lines.append("")
    lines.append("Unavailable metrics are excluded from the alignment score.")
    lines.append("")
    return "\n".join(lines)


def render_comparison_report(
    baseline_path: Path,
    target_before_path: Path | None,
    target_now_path: Path,
    iteration: int,
    panel_data: dict[str, Any],
    rows: list[dict[str, Any]],
    score: float | None,
    previous_score: float | None,
    counts: dict[str, int],
    movement: dict[str, int],
    settings: dict[str, Any],
    humanizer_path: Path | None,
    humanizer_text: str | None,
    previous_available: bool,
    series: dict[str, dict[int, Any]] | None = None,
) -> str:
    meta = panel_data.get("meta") or {}
    lines: list[str] = []
    lines.append(f"# Style Alignment Comparison — Iteration {iteration:02d}")
    lines.append("")
    lines.append(f"- **Baseline:** `{baseline_path}`")
    if target_before_path is not None:
        lines.append(f"- **Target before:** `{target_before_path}`")
    lines.append(f"- **Target now:** `{target_now_path}`")
    lines.append(f"- **Tokens (engine tokenizer, target now):** {meta.get('token_count', '—')}")
    lines.append(f"- **Measured text:** {apparatus_summary(panel_data.get('apparatus'))}")
    lines.append(f"- **Chunk size:** {settings.get('chunk_size', 1000)}")
    lines.append(f"- **Matched tolerance:** |z| <= {settings.get('matched_z', 0.5)}; close <= {settings.get('close_z', 1.0)}")
    lines.append(f"- **Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append("## Result")
    lines.append("")
    if score is None:
        lines.append("- **Weighted mismatch D:** unavailable (no comparable metrics).")
    elif previous_score is None:
        lines.append(f"- **Weighted mismatch D:** {score:.2f}.")
    else:
        delta = score - previous_score
        lines.append(f"- **Weighted mismatch D:** {score:.2f} (previous {previous_score:.2f}, change {fmt_signed(delta, 2)}).")
    lines.append(
        f"- **Metrics:** {counts.get('matched', 0)} matched, "
        f"{counts.get('close', 0)} close, {counts.get('off', 0)} off, "
        f"{counts.get('unavailable', 0)} unavailable."
    )
    if previous_available:
        lines.append(
            f"- **Movement:** {movement.get('toward', 0)} toward baseline, "
            f"{movement.get('away', 0)} away, {movement.get('unchanged', 0)} unchanged."
        )
    else:
        lines.append("- **Movement:** none yet; this is the initial target analysis.")
    gaps = [
        r for r in rows
        if r.get("z") is not None
        and r.get("status") in ("off", "close")
        and abs(r["z"]) > float(settings.get("matched_z", 0.5))
    ]
    gaps.sort(key=status_rank, reverse=True)
    if gaps:
        names = ", ".join(r["metric"].label for r in gaps[:5])
        lines.append(f"- **Biggest remaining gaps:** {names}.")
    else:
        lines.append("- **Biggest remaining gaps:** none; the selected panel is within tolerance.")
    lines.append("")
    lines.append(build_edit_plan(rows, settings))
    lines.append(render_humanizer_section(humanizer_path, humanizer_text))
    lines.append(render_summary_table(rows, settings))
    lines.append(render_cumulative_table(rows, series, iteration, settings))
    lines.append(render_movement_section(rows, previous_available))
    lines.append(render_metric_ledger(
        rows, settings, iteration, previous_available, series,
    ))
    lines.append(render_unavailable_section(rows, panel_data.get("skipped") or []))
    lines.append("## Next")
    lines.append("")
    lines.append("Ask the user whether to run another iteration.")
    lines.append("")
    lines.append("- If yes: copy the current target to the next `target-iter-NN.md`,")
    lines.append("  apply the approved humanizer fixes and the edit plan, then run")
    lines.append("  `style-align compare` again.")
    lines.append("- If no: summarize the final comparison, the remaining gaps, and the")
    lines.append("  artifact paths. Do not run another pass.")
    lines.append("")
    return "\n".join(lines)


def comparison_payload(
    iteration: int,
    baseline_path: Path,
    target_now_path: Path,
    target_before_path: Path | None,
    rows: list[dict[str, Any]],
    score: float | None,
    previous_score: float | None,
    counts: dict[str, int],
    movement: dict[str, int],
    humanizer_path: Path | None,
    settings: dict[str, Any],
    series: dict[str, dict[int, Any]] | None = None,
) -> dict[str, Any]:
    metrics = []
    for r in rows:
        m: Metric = r["metric"]
        cumulative = cumulative_row(r, series, iteration)
        metrics.append({
            "id": m.id,
            "label": m.label,
            "family": m.family,
            "weight": m.weight,
            "unit": m.unit,
            "optional": m.optional,
            "baseline": r.get("baseline"),
            "previous": r.get("previous"),
            "current": r.get("current"),
            "sd": r.get("sd"),
            "sigma": r.get("sigma"),
            "z": r.get("z"),
            "z_before": r.get("z_before"),
            "gap": r.get("gap"),
            "gap_before": r.get("gap_before"),
            "move": r.get("move"),
            "move_pct": r.get("move_pct"),
            "move_threshold": r.get("move_threshold"),
            "closure_pct": r.get("closure_pct"),
            "toward": r.get("toward"),
            "status": r.get("status"),
            "status_before": r.get("status_before"),
            "status_change": r.get("status_change"),
            "original": cumulative["original"],
            "original_iteration": cumulative["original_iteration"],
            "cumulative_change": cumulative["change"],
            "gap_closed_pct": cumulative["gap_closed"],
            "gap_closed_prev_pct": cumulative["gap_closed_prev"],
            "gap_closed_delta_pct": cumulative["gap_closed_delta"],
            "trajectory": {
                str(it): v for it, v in sorted((series or {}).get(m.id, {}).items())
            },
        })
    return {
        "iteration": iteration,
        "baseline_path": str(baseline_path),
        "target_before_path": str(target_before_path) if target_before_path else None,
        "target_now_path": str(target_now_path),
        "score": score,
        "previous_score": previous_score,
        "counts": counts,
        "movement": movement,
        "humanizer_report": str(humanizer_path) if humanizer_path else None,
        "settings": settings,
        "metrics": metrics,
    }


# ---------------------------------------------------------------------------
# State and commands
# ---------------------------------------------------------------------------


def state_path(workdir: Path) -> Path:
    return workdir / STATE_FILE


def load_state(workdir: Path) -> dict[str, Any]:
    path = state_path(workdir)
    if not path.is_file():
        raise SystemExit(f"no style-alignment state in {workdir} (run `style-align init` first)")
    return read_json(path)


def save_state(workdir: Path, state: dict[str, Any]) -> None:
    write_json(state_path(workdir), state)


def cmd_init(args: argparse.Namespace) -> int:
    baseline = Path(args.baseline).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    if not baseline.is_file():
        raise SystemExit(f"baseline not found: {baseline}")
    if not target.is_file():
        raise SystemExit(f"target not found: {target}")

    workdir = Path(args.workdir).expanduser().resolve() if args.workdir else default_workdir(target)
    if workdir.exists() and state_path(workdir).exists() and not args.force:
        raise SystemExit(
            f"work directory already initialized: {workdir}\n"
            "use --force to overwrite, or choose a different --workdir"
        )
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "raw").mkdir(exist_ok=True)

    only = parse_ids(args.only)
    skip = parse_ids(args.skip)
    validate_ids(only, "--only")
    validate_ids(skip, "--skip")

    settings = {
        "chunk_size": 1000,
        "strip_markdown": not args.keep_markdown,
        "strip_apparatus": not args.no_strip_apparatus,
        "fiction": bool(args.fiction),
        "verse": bool(args.verse),
        "extras": not args.no_extras,
        "matched_z": float(args.matched_z),
        "close_z": float(args.close_z),
        "only": only,
        "skip": skip,
        "timeout": int(args.timeout),
    }
    # Explicitly selecting an optional metric enables its section.
    if any(PANEL_BY_ID[i].optional == "fiction" for i in only):
        settings["fiction"] = True
    if any(PANEL_BY_ID[i].optional == "verse" for i in only):
        settings["verse"] = True
    if any(PANEL_BY_ID[i].optional == "extras" for i in only):
        settings["extras"] = True
    if not [m for m in PANEL if selected(m, settings)]:
        raise SystemExit("the selected panel is empty; check --only/--skip")

    # Phase 1: baseline analysis.
    print(f"analysing baseline: {baseline}", file=sys.stderr)
    baseline_analysis = prepare_analysis_copy(baseline, workdir, "baseline", settings)
    baseline_payload = analyze_text(
        Path(baseline_analysis["path"]), "baseline", workdir, settings, args.verbose,
    )
    baseline_panel = extract_panel(baseline_payload, baseline_analysis["derived"])
    baseline_panel["apparatus"] = baseline_analysis
    write_json(workdir / "raw" / "baseline.panel.json", baseline_panel)
    baseline_report = workdir / "baseline-report.md"
    baseline_report.write_text(
        render_baseline_report(
            baseline, baseline_panel, settings, workdir / "raw" / "baseline.stylometry.md",
        ),
        encoding="utf-8",
    )

    # Copy the target so the original is never modified by the loop.
    target_copy = workdir / "target-iter-00.md"
    shutil.copyfile(target, target_copy)

    state = {
        "version": 1,
        "panel_version": PANEL_VERSION,
        "baseline_path": str(baseline),
        "baseline_panel": str(workdir / "raw" / "baseline.panel.json"),
        "baseline_report": str(baseline_report),
        "target_original": str(target),
        "target_copy": str(target_copy),
        "workdir": str(workdir),
        "iteration": -1,
        "previous_target": None,
        "previous_target_json": None,
        "previous_panel": None,
        "previous_comparison": None,
        "previous_score": None,
        "settings": settings,
        "history": [],
        "created": datetime.now().isoformat(timespec="seconds"),
    }
    save_state(workdir, state)

    readme = workdir / "README.md"
    readme.write_text(
        "\n".join([
            "# Style alignment work",
            "",
            f"Baseline: `{baseline}`",
            f"Original target: `{target}`",
            "",
            "Files:",
            "- `baseline-report.md` — phase 1 baseline profile.",
            "- `raw/` — raw stylometry JSON/Markdown for each analysis.",
            "- `raw/*.analysis.md` — the prose-only copy actually measured (footnote apparatus,",
            "  headings, table rows, and figure lines removed). Quote numbers from this,",
            "  not from the source file.",
            "- `target-iter-00.md` — copy of the original target; edit copies, not the original.",
            "- `comparison-00.md` — initial target analysis (summary table + detailed per-metric ledger).",
            "- `comparison-NN.md` — post-iteration comparison: the summary table gives",
            "  before/after for the last pass, the cumulative table gives every metric's",
            "  gap closed since iteration 00 by family, and the ledger gives baseline,",
            "  before, after, change, gap before/after, status before/after and trajectory.",
            "- `humanizer-NN.md` — humanizer detection reports (created by the agent).",
            "- `state.json` — iteration state; do not hand-edit unless resuming.",
            "",
            "Workflow:",
            "1. Run the humanizer detection pass on `target-iter-00.md`.",
            "2. Run `style-align compare --workdir . --target target-iter-00.md --humanizer-report humanizer-00.md`.",
            "3. Apply the approved humanizer fixes and the comparison's edit plan to a new copy.",
            "4. Run `style-align compare --workdir . --target target-iter-01.md --humanizer-report humanizer-01.md`.",
            "5. Ask the user after every comparison whether to continue.",
            "",
        ]),
        encoding="utf-8",
    )

    print("")
    print("Style alignment initialized.")
    print(f"workdir: {workdir}")
    print(f"baseline report: {baseline_report}")
    print(f"target copy: {target_copy}")
    print("")
    print("Next: run the humanizer detection pass on target-iter-00.md, then:")
    print(f"  style-align compare --workdir {workdir} --target {target_copy} \\")
    print(f"    --humanizer-report {workdir / 'humanizer-00.md'}")
    return 0


def build_series(
    history: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    iteration: int,
) -> dict[str, dict[int, Any]]:
    """Collect every recorded target value per metric, for the trajectory lines.
    Later iterations than the one being written are ignored (they are stale)."""
    series: dict[str, dict[int, Any]] = {}
    for h in history:
        raw = h.get("comparison_json")
        if not raw or not Path(raw).is_file():
            continue
        try:
            payload = read_json(Path(raw))
        except SystemExit:
            continue
        it = payload.get("iteration")
        if it is None or int(it) > iteration:
            continue
        for entry in payload.get("metrics") or []:
            mid = entry.get("id")
            if mid:
                series.setdefault(mid, {})[int(it)] = entry.get("current")
    for r in rows:
        series.setdefault(r["metric"].id, {})[int(iteration)] = r.get("current")
    return series


def cmd_compare(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir).expanduser().resolve()
    state = load_state(workdir)
    settings = state.get("settings") or {}
    stored_version = state.get("panel_version")
    if stored_version != PANEL_VERSION:
        raise SystemExit(
            f"this work directory was initialised with panel version {stored_version}, "
            f"but the script now uses panel version {PANEL_VERSION}.\n"
            "The baseline profile and the target would be measured on different panels,\n"
            "so the comparison would not be meaningful. Re-run `style-align init`\n"
            "(move the old work directory aside first if you want to keep its reports)."
        )
    target = Path(args.target).expanduser().resolve()
    if not target.is_file():
        raise SystemExit(f"target not found: {target}")

    if args.iteration is None:
        iteration = int(state.get("iteration", -1)) + 1
    else:
        iteration = int(args.iteration)
    if iteration < 0:
        raise SystemExit("iteration must be >= 0")
    history_len = len(state.get("history") or [])
    if args.iteration is not None and iteration > history_len:
        raise SystemExit(
            f"cannot skip iterations: iteration {iteration} requested, "
            f"but the next sequential iteration is {history_len}"
        )

    comparison_md = workdir / f"comparison-{iteration:02d}.md"
    comparison_json = workdir / f"comparison-{iteration:02d}.json"
    if comparison_md.exists() and not args.force:
        raise SystemExit(
            f"{comparison_md} already exists; use --force to overwrite or pass --iteration"
        )

    baseline_path = Path(state["baseline_path"])
    baseline_panel = read_json(Path(state["baseline_panel"]))

    previous_panel = None
    target_before_path = None
    history = state.get("history") or []
    if iteration > 0:
        # Prefer the recorded prior iteration. This keeps re-runs (--force) and
        # out-of-order iterations honest: iteration N's "before" is N-1, not
        # whatever happened to be the latest state entry.
        prev_entry = history[iteration - 1] if iteration - 1 < len(history) else None
        prev_panel_path = (
            prev_entry.get("panel") if prev_entry else state.get("previous_panel")
        )
        prev_target_path = (
            prev_entry.get("target") if prev_entry else state.get("previous_target")
        )
        if not prev_panel_path or not Path(prev_panel_path).is_file():
            raise SystemExit(
                "no previous target analysis in state; run iteration 0 first "
                "(`style-align compare --target target-iter-00.md`)"
            )
        previous_panel = read_json(Path(prev_panel_path))
        target_before_path = Path(prev_target_path) if prev_target_path else None
    if args.previous_panel:
        previous_panel = read_json(Path(args.previous_panel).expanduser().resolve())
        target_before_path = Path(args.previous_target).expanduser().resolve() if args.previous_target else target_before_path

    print(f"analysing target: {target}", file=sys.stderr)
    target_analysis = prepare_analysis_copy(
        target, workdir, f"target-{iteration:02d}", settings,
    )
    target_payload = analyze_text(
        Path(target_analysis["path"]), f"target-{iteration:02d}", workdir, settings,
        args.verbose,
    )
    target_panel = extract_panel(target_payload, target_analysis["derived"])
    target_panel["apparatus"] = target_analysis
    target_panel_path = workdir / "raw" / f"target-{iteration:02d}.panel.json"
    write_json(target_panel_path, target_panel)

    rows, score, counts, movement = compare_panels(
        PANEL, baseline_panel, previous_panel, target_panel, settings,
    )
    previous_available = previous_panel is not None
    previous_score = None
    if previous_available:
        if iteration > 0 and iteration - 1 < len(history):
            previous_score = history[iteration - 1].get("score")
        if previous_score is None:
            previous_score = state.get("previous_score")
    if previous_score is None and previous_available:
        # Best-effort: read the previous comparison JSON if it exists.
        prev_cmp = state.get("previous_comparison")
        if prev_cmp and Path(prev_cmp).is_file():
            try:
                previous_score = read_json(Path(prev_cmp)).get("score")
            except SystemExit:
                previous_score = None

    humanizer_path = None
    humanizer_text = None
    if args.humanizer_report:
        humanizer_path = Path(args.humanizer_report).expanduser().resolve()
        if not humanizer_path.is_file():
            raise SystemExit(f"humanizer report not found: {humanizer_path}")
        humanizer_text = read_text(humanizer_path)

    series = build_series(history, rows, iteration)
    report = render_comparison_report(
        baseline_path=baseline_path,
        target_before_path=target_before_path,
        target_now_path=target,
        iteration=iteration,
        panel_data=target_panel,
        rows=rows,
        score=score,
        previous_score=previous_score,
        counts=counts,
        movement=movement,
        settings=settings,
        humanizer_path=humanizer_path,
        humanizer_text=humanizer_text,
        previous_available=previous_available,
        series=series,
    )
    comparison_md.write_text(report, encoding="utf-8")
    write_json(
        comparison_json,
        comparison_payload(
            iteration=iteration,
            baseline_path=baseline_path,
            target_now_path=target,
            target_before_path=target_before_path,
            rows=rows,
            score=score,
            previous_score=previous_score,
            counts=counts,
            movement=movement,
            humanizer_path=humanizer_path,
            settings=settings,
            series=series,
        ),
    )

    entry = {
        "iteration": iteration,
        "target": str(target),
        "panel": str(target_panel_path),
        "comparison": str(comparison_md),
        "comparison_json": str(comparison_json),
        "score": score,
        "counts": counts,
        "movement": movement,
        "humanizer_report": str(humanizer_path) if humanizer_path else None,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }
    history = state.setdefault("history", [])
    if iteration < len(history):
        # Re-running an iteration invalidates later iterations.
        del history[iteration + 1:]
        history[iteration] = entry
    else:
        history.append(entry)
    state.update({
        "iteration": iteration,
        "previous_target": str(target),
        "previous_target_json": str(workdir / "raw" / f"target-{iteration:02d}.stylometry.json"),
        "previous_panel": str(target_panel_path),
        "previous_comparison": str(comparison_md),
        "previous_score": score,
    })
    save_state(workdir, state)

    print("")
    print(f"comparison: {comparison_md}")
    print(f"comparison JSON: {comparison_json}")
    print(f"target panel: {target_panel_path}")
    if score is not None:
        print(f"weighted mismatch D: {score:.2f}")
    print(
        f"metrics: {counts.get('matched', 0)} matched, "
        f"{counts.get('close', 0)} close, {counts.get('off', 0)} off, "
        f"{counts.get('unavailable', 0)} unavailable"
    )
    if previous_available:
        print(
            f"movement: {movement.get('toward', 0)} toward, "
            f"{movement.get('away', 0)} away, {movement.get('unchanged', 0)} unchanged"
        )
    else:
        print("movement: initial analysis (no previous target)")
    gaps = [
        r for r in rows
        if r.get("z") is not None and r.get("status") in ("off", "close")
        and abs(r["z"]) > float(settings.get("matched_z", 0.5))
    ]
    gaps.sort(key=status_rank, reverse=True)
    if gaps:
        print("top gaps:")
        for r in gaps[:5]:
            print(
                f"  - {r['metric'].label}: baseline {fmt(r['baseline'], r['metric'].digits)}, "
                f"target {fmt(r['current'], r['metric'].digits)}, z {r['z']:+.2f}"
            )
    print("")
    print("Read the comparison report, present it, and ask the user whether to run")
    print("another iteration.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir).expanduser().resolve()
    state = load_state(workdir)
    print(f"workdir: {workdir}")
    print(f"baseline: {state.get('baseline_path')}")
    print(f"original target: {state.get('target_original')}")
    print(f"current iteration: {state.get('iteration')}")
    print(f"previous target: {state.get('previous_target')}")
    print(f"baseline report: {state.get('baseline_report')}")
    history = state.get("history") or []
    if not history:
        print("no comparisons yet")
        return 0
    print("")
    print("| Iter | D | Matched | Close | Off | Toward | Away | Humanizer | Comparison |")
    print("|---:|---:|---:|---:|---:|---:|---:|---|---|")
    for h in history:
        c = h.get("counts") or {}
        m = h.get("movement") or {}
        d = h.get("score")
        humanizer = h.get("humanizer_report") or "—"
        print(
            f"| {h.get('iteration')} | {fmt(d, 2)} | {c.get('matched', 0)} | "
            f"{c.get('close', 0)} | {c.get('off', 0)} | {m.get('toward', 0)} | "
            f"{m.get('away', 0)} | {humanizer} | {h.get('comparison')} |"
        )
    return 0


def cmd_panel(args: argparse.Namespace) -> int:
    print("| ID | Family | Metric | Wt | Optional | Up | Down |")
    print("|---|---|---|---:|---|---|---|")
    for m in PANEL:
        print(
            f"| `{m.id}` | {m.family} | {m.label} | {m.weight:.2f} | "
            f"{m.optional or '—'} | {m.up} | {m.down} |"
        )
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="style-align",
        description=(
            "Align a target text to a baseline on a focused panel of length-stable, "
            "LLM-controllable stylometric measures. Uses the stylometry skill for "
            "analysis and the humanizer skill for the AI-tell pass."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="phase 1: analyze the baseline and prepare the workdir")
    p_init.add_argument("--baseline", required=True, help="baseline text file")
    p_init.add_argument("--target", required=True, help="target text file")
    p_init.add_argument("--workdir", help="work directory (default: <target>.style-alignment)")
    p_init.add_argument("--fiction", action="store_true", help="include dialogue ratio")
    p_init.add_argument("--verse", action="store_true", help="include alliteration/assonance")
    p_init.add_argument("--no-extras", action="store_true", help="skip repetition/slop metrics")
    p_init.add_argument("--keep-markdown", action="store_true", help="do not strip markdown before analysis")
    p_init.add_argument(
        "--no-strip-apparatus", action="store_true",
        help="measure footnote definitions, headings, and table rows as prose (default: strip them)",
    )
    p_init.add_argument("--matched-z", type=float, default=0.5, help="matched tolerance (default 0.5)")
    p_init.add_argument("--close-z", type=float, default=1.0, help="close tolerance (default 1.0)")
    p_init.add_argument("--only", help="comma-separated metric ids to include")
    p_init.add_argument("--skip", help="comma-separated metric ids to exclude")
    p_init.add_argument("--timeout", type=int, default=1800, help="analysis timeout in seconds")
    p_init.add_argument("--force", action="store_true", help="overwrite an initialized workdir")
    p_init.add_argument("--verbose", action="store_true", help="show analysis commands and logs")
    p_init.set_defaults(func=cmd_init)

    p_cmp = sub.add_parser("compare", help="phase 2: analyze the target and write a comparison report")
    p_cmp.add_argument("--workdir", required=True, help="work directory from init")
    p_cmp.add_argument("--target", required=True, help="current target text file")
    p_cmp.add_argument("--humanizer-report", help="humanizer detection report to attach")
    p_cmp.add_argument("--iteration", type=int, help="override the auto-incremented iteration")
    p_cmp.add_argument("--previous-panel", help="override the previous target panel JSON")
    p_cmp.add_argument("--previous-target", help="path label for the previous target")
    p_cmp.add_argument("--force", action="store_true", help="overwrite an existing comparison")
    p_cmp.add_argument("--verbose", action="store_true", help="show analysis commands and logs")
    p_cmp.set_defaults(func=cmd_compare)

    p_status = sub.add_parser("status", help="show workdir state and iteration history")
    p_status.add_argument("--workdir", required=True)
    p_status.set_defaults(func=cmd_status)

    p_panel = sub.add_parser("panel", help="list the alignment panel")
    p_panel.set_defaults(func=cmd_panel)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
