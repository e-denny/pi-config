#!/usr/bin/env python3
"""Generate a stylometric analysis report for a single text, using pystylometry.

The report is modelled on the library's own showcase document
(``docs/metrics-showcase-hound-of-baskervilles.md``): a markdown file with one
section per metric family, each table followed by a short interpretation.

Every metric is optional-dependency guarded: if a module is unavailable the
metric is skipped, the reason is recorded, and the rest of the report is still
produced.

Usage:
    stylometry_report.py TEXT [-o REPORT.md] [--title T] [--author A]

See ``--help`` for the full option list and ``--list-sections`` for the
section names accepted by ``--sections``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import inspect
import json
import math
import platform
import re
import sys
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Result keys
# ---------------------------------------------------------------------------

SECTION_ORDER = [
    "summary",
    "summary-table",
    "lexical",
    "readability",
    "syntactic",
    "character",
    "ngrams",
    "markers",
    "genre",
    "dialect",
    "drift",
    "prosody",
    "cohesion",
    "extras",
    "appendix",
]

SECTION_DESCRIPTIONS = {
    "summary": "text metadata, size, and the headline token/type counts",
    "summary-table": "every metric in one flat Category | Metric | Value table",
    "lexical": "vocabulary diversity, richness, function words, sophistication, word classes",
    "readability": "grade-level formulas (Flesch, SMOG, Fog, ARI, and friends)",
    "syntactic": "POS ratios, sentence statistics, clause structure, sentence types",
    "character": "character-level fingerprinting and letter frequency",
    "ngrams": "n-gram entropy, perplexity, and top n-gram/​skipgram profiles",
    "markers": "style markers: contractions, hedges, modals, negation, punctuation",
    "genre": "genre/register classification and formality",
    "dialect": "British/American markers and markedness",
    "drift": "intra-document style drift (Kilgarriff chi-squared)",
    "prosody": "syllable rhythm, stress patterns, syllable-pattern repetition",
    "cohesion": "referential and lexical cohesion, coherence scores",
    "extras": "BNC frequency profile and repetition/slop detection",
    "appendix": "environment, parameters, and skipped metrics",
}

DRIFT_WINDOW = 1000
DRIFT_STRIDE = 500

# ---------------------------------------------------------------------------
# Focused metric set
#
# The default report keeps one or two measures per category, chosen from the
# redundancy evidence in evidence/metric-redundancy.md: the readability formulas
# correlate 0.92-0.99 with each other, so Flesch-Kincaid carries the
# syllable-based cluster and Dale-Chall the familiarity-based one (they agree at
# only +0.51, which is the point of keeping both); among lexical-diversity
# measures, MTLD and MATTR are the two the validation literature finds purest,
# and rare-word ratio covers vocabulary sophistication.
#
# --all-metrics restores the full set.
# ---------------------------------------------------------------------------

CORE_ANALYSES: dict[str, tuple[str, ...]] = {
    "lexical": ("mtld", "mattr", "freq_soph"),
    "readability": ("flesch", "dale_chall"),
}

# Metric labels (as written in the consolidated table) that survive in focused
# mode, for the categories that are narrowed.
CORE_TABLE_ROWS: dict[str, frozenset[str]] = {
    "Lexical": frozenset({
        "MTLD forward",
        "MTLD backward",
        "MTLD average",
        "MATTR",
        "MATTR std dev",
        "MATTR window size",
        "Rare word ratio",
        "Common word ratio",
    }),
    "Readability": frozenset({
        "Flesch-Kincaid grade",
        "Dale-Chall score",
        "Dale-Chall grade",
        "Dale-Chall difficult word ratio",
    }),
}


# ---------------------------------------------------------------------------
# Small formatting helpers
# ---------------------------------------------------------------------------


def fnum(value: Any, nd: int = 4) -> str:
    """Format a number for a table cell, tolerating NaN/None and ints."""
    if value is None:
        return "n/a"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        if math.isnan(value):
            return "n/a"
        if math.isinf(value):
            return "inf" if value > 0 else "-inf"
        if value == 0:
            value = 0.0  # normalise -0.0 so it never prints as "-0.0000"
        return f"{value:,.{nd}f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def fpct(value: Any, nd: int = 1) -> str:
    """Format a 0-1 ratio as a percentage string."""
    if value is None or not isinstance(value, (int, float)) or isinstance(value, bool):
        return "n/a"
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return "n/a"
    return f"{value * 100:.{nd}f}%"


def fgrade(value: Any) -> str:
    """Format a grade level, which may be numeric or an already-formatted range."""
    if value is None:
        return "n/a"
    if isinstance(value, str):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return "n/a"
        return f"{value:.1f}"
    return str(value)


def ftext(value: Any, visible: bool = False) -> str:
    """Clean a token or n-gram for display inside a markdown table.

    With ``visible=True``, spaces become a visible symbol: character n-grams
    otherwise collapse to look identical when they differ only in whitespace.
    """
    if value is None:
        return "n/a"
    text = re.sub(r"\s+", " ", str(value))
    if visible:
        text = text.replace(" ", "\u2423")
    return text.replace("|", "\\|").strip()


def fwords(count: Any, unit: str = "word") -> str:
    """Format a count with a correctly pluralised unit."""
    if not isinstance(count, (int, float)) or isinstance(count, bool):
        return f"{fnum(count)} {unit}s"
    return f"{count:g} {unit if count == 1 else unit + 's'}"


def repair_segmenter_text(text: str) -> str:
    """Undo a segmenter artefact before showing a sentence excerpt.

    The library's sentence splitter turns an in-sentence line break into a
    period, so 'case of\\n      extraordinary' comes back as
    'case of.extraordinary'. This is display-only repair.
    """
    return re.sub(r"(?<=[A-Za-z])\.(?=[a-z])", " ", text)


def display_title(raw: str) -> str:
    """Turn a file stem into something readable in a heading."""
    return re.sub(r"[-_]+", " ", raw).strip()


def has_typographic_quotes(text: str) -> bool:
    """True if the text uses curly quotes, which some counters miss."""
    return "\u201c" in text or "\u201d" in text


class Table:
    """Minimal markdown table builder."""

    def __init__(self, *headers: str) -> None:
        self.headers = list(headers)
        self.rows: list[list[str]] = []

    def row(self, *cells: Any) -> "Table":
        cleaned = []
        for cell in cells:
            text = "" if cell is None else str(cell)
            cleaned.append(re.sub(r"\s*\n\s*", " ", text).replace("|", "\\|"))
        self.rows.append(cleaned)
        return self

    def rows_from(self, data: list[tuple]) -> "Table":
        for entry in data:
            self.row(*entry)
        return self

    def __len__(self) -> int:
        return len(self.rows)

    def render(self) -> str:
        if not self.rows:
            return "_No data._\n"
        out = ["| " + " | ".join(self.headers) + " |"]
        out.append("|" + "|".join("---" for _ in self.headers) + "|")
        for row in self.rows:
            out.append("| " + " | ".join(row) + " |")
        return "\n".join(out) + "\n"


def heading(level: int, text: str) -> str:
    return f"{'#' * level} {text}\n"


def para(text: str | None) -> str:
    return f"{text}\n" if text else ""


# ---------------------------------------------------------------------------
# Interpretations
#
# These are deliberately simple, published bandings applied to the value the
# library returns. They are heuristics for orientation, not verdicts: the
# library computes the metric, this module only labels it.
# ---------------------------------------------------------------------------


def _bands(value: float | None, bands: list[tuple[str, float]], suffix: str = "") -> str:
    """Pick a label from ``bands``, a list of (label, upper-bound) pairs."""
    if value is None or not isinstance(value, (int, float)) or isinstance(value, bool):
        return f"unclassifiable{suffix}"
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return f"unclassifiable{suffix}"
    for label, upper in bands:
        if value < upper:
            return f"{label}{suffix}"
    return f"{bands[-1][0]}{suffix}"


def interp_ttr(ttr: Any) -> str:
    label = _bands(
        ttr.root_ttr,
        [("low", 15.0), ("moderate", 25.0), ("high", 35.0), ("very high", float("inf"))],
    )
    caveats = []
    if ttr.total_words < 2000:
        caveats.append(
            f"At {fwords(ttr.total_words, 'token')} this text is below the length at which "
            f"these ratios stabilise, so the richness bands are not reliable; raw TTR "
            f"in particular is inflated by the short length."
        )
    if ttr.chunk_count <= 1:
        caveats.append(
            "The text fits in a single chunk, so STTR and delta std carry no information: "
            "they measure variation between chunks, and there is only one."
        )
    return (
        f"Raw TTR ({ttr.ttr:.4f}) is length-sensitive and is not comparable across texts of "
        f"different sizes; the length-normalised measures matter more here. Root TTR "
        f"(Guiraud's index) of {ttr.root_ttr:.2f} is {label} vocabulary richness, and log TTR "
        f"(Herdan's C) sits at {ttr.log_ttr:.4f}. STTR of {ttr.sttr:.4f} averages TTR over "
        f"{fwords(ttr.chunk_count, 'chunk')} of {ttr.chunk_size:,} words, which makes it "
        f"comparable to other texts; the chunk-to-chunk spread (delta std "
        f"{ttr.delta_std:.4f}) indicates how evenly that vocabulary is spread."
        + (" " + " ".join(caveats) if caveats else "")
    )


def interp_mtld(mtld: Any) -> str:
    label = _bands(
        mtld.mtld_average,
        [("very low", 30.0), ("low", 50.0), ("moderate", 70.0), ("high", 100.0), ("very high", float("inf"))],
    )
    return (
        f"An MTLD of {mtld.mtld_average:.2f} is {label} lexical diversity. MTLD is length-"
        f"independent, so unlike raw TTR it can be compared directly with other texts. The "
        f"forward and backward passes ({mtld.mtld_forward:.2f} and {mtld.mtld_backward:.2f}) "
        f"agree closely, which means the figure is not an artefact of reading direction."
    )


def interp_yule(yule: Any) -> str:
    label = _bands(
        yule.yule_k,
        [("low", 80.0), ("moderate", 150.0), ("high", 250.0), ("very high", float("inf"))],
    )
    return (
        f"Yule's K of {fnum(yule.yule_k, 2)} indicates {label} vocabulary repetition: it rises "
        f"as words are reused rather than varied. Yule's I, the characteristic constant of the "
        f"vocabulary, is {fnum(yule.yule_i, 4)}."
    )


def interp_hapax(hapax: Any) -> str:
    label = _bands(
        hapax.honore_r,
        [("modest", 1000.0), ("substantial", 1800.0), ("high", float("inf"))],
    )
    return (
        f"Honore's R of {fnum(hapax.honore_r, 2)} points to {label} vocabulary richness. Note "
        f"that these counts are summed over {fwords(hapax.chunk_count, 'chunk')} of "
        f"{hapax.chunk_size:,} words, so they measure how often words appear once *within* a "
        f"chunk, which is a larger number than a whole-document hapax count would be. "
        f"Sichel's S ({fnum(hapax.sichel_s, 4)}) is the dislegomena-to-types ratio and is "
        f"length-sensitive in the opposite direction."
    )


def interp_function_words(fw: Any) -> str:
    classes = [
        ("determiners", fw.determiner_ratio),
        ("prepositions", fw.preposition_ratio),
        ("pronouns", fw.pronoun_ratio),
        ("conjunctions", fw.conjunction_ratio),
        ("auxiliaries", fw.auxiliary_ratio),
        ("particles", fw.particle_ratio),
    ]
    ranked = sorted(classes, key=lambda pair: -pair[1])[:2]
    leaders = " and ".join(f"{name} ({fpct(value)})" for name, value in ranked)
    return (
        f"Function words make up {fpct(fw.total_function_word_ratio)} of tokens. Because they "
        f"are chosen below the level of conscious style, their ratios are among the most "
        f"reliable authorship markers: they survive topic changes better than content words "
        f"do. The largest classes here are {leaders}."
    )


def interp_mattr(mattr: Any) -> str:
    label = _bands(mattr.mattr_score, [("low", 0.6), ("moderate", 0.75), ("high", float("inf"))])
    return (
        f"A MATTR of {mattr.mattr_score:.4f} over a {mattr.window_size}-word window means "
        f"{label} local vocabulary diversity: within any short stretch of text, this much of "
        f"the vocabulary is new. Window TTR ranges from {mattr.min_ttr:.2f} to "
        f"{mattr.max_ttr:.2f}, and the standard deviation ({mattr.ttr_std_dev:.4f}) shows how "
        f"much that varies."
    )


def interp_msttr(msttr: Any) -> str:
    return (
        f"MSTTR of {msttr.msttr_score:.4f} across {msttr.segment_count} segments of "
        f"{msttr.segment_size} words is a coarser, segment-level version of the same idea. "
        f"Segment TTR runs from {msttr.min_ttr:.2f} to {msttr.max_ttr:.2f}."
    )


def interp_freq_soph(fs: Any) -> str:
    return (
        f"The mean frequency rank of {fs.mean_frequency_rank:,.2f} is pulled up by the long "
        f"tail of words that never appear in the reference corpus; the median of "
        f"{fs.median_frequency_rank:,.2f} is the more robust figure. "
        f"{fpct(fs.rare_word_ratio)} of tokens are rare, {fpct(fs.common_word_ratio)} are "
        f"common, and {fpct(fs.advanced_word_ratio)} count as advanced vocabulary. "
        f"Academic Word List items account for {fpct(fs.academic_word_ratio)}, which is the "
        f"clearest signal here about register."
    )


def interp_flesch(flesch: Any) -> str:
    return (
        f"A Flesch Reading Ease score of {flesch.reading_ease:.2f} falls in the "
        f"\"{flesch.difficulty}\" band, and the Flesch-Kincaid grade level is "
        f"{flesch.grade_level:.1f}. Roughly, that is the highest school year at which an "
        f"average reader is expected to cope with the text unaided."
    )


def interp_readability_summary(grades: dict[str, float], average: float | None) -> str:
    if average is None:
        return "Not enough formulas completed to compute an average grade level."
    spread = max(grades.values()) - min(grades.values())
    # Formulas that count syllables or polysyllabic words versus formulas that
    # count characters. A systematic gap between the two groups is informative.
    syllable_based = [grades[k] for k in ("SMOG", "Gunning Fog") if k in grades]
    character_based = [grades[k] for k in ("Coleman-Liau", "ARI") if k in grades]
    driver = ""
    if syllable_based and character_based:
        gap = sum(syllable_based) / len(syllable_based) - sum(character_based) / len(character_based)
        if gap > 1.0:
            driver = (
                f" The syllable-counting formulas read {gap:.1f} grades above the "
                f"character-counting ones, which points to long, Latinate words rather than "
                f"long sentences."
            )
        elif gap < -1.0:
            driver = (
                f" The character-counting formulas read {abs(gap):.1f} grades above the "
                f"syllable-counting ones, which points to long words made of short syllables "
                f"rather than to difficult vocabulary."
            )
        else:
            driver = (
                " The syllable-counting and character-counting formulas agree within a grade, "
                "so word length and sentence length are contributing about equally."
            )
    return (
        f"Averaged over {len(grades)} formulas the text sits at about grade {average:.1f}, "
        f"and the individual estimates span {min(grades.values()):.1f} to "
        f"{max(grades.values()):.1f} (a {spread:.1f}-grade spread). The spread is the useful "
        f"part: each formula weights a different surface feature, so disagreement between "
        f"them says something about which feature dominates.{driver}"
    )


def interp_pos(pos: Any) -> str:
    label = _bands(
        pos.noun_verb_ratio,
        [("verb-leaning", 1.0), ("balanced", 1.5), ("nominal", 2.5), ("heavily nominal", float("inf"))],
    )
    return (
        f"A noun-to-verb ratio of {pos.noun_verb_ratio:.4f} is {label}. Noun-heavy writing "
        f"foregrounds entities and description, verb-heavy writing foregrounds action; the "
        f"balance shifts reliably with genre, which is why it is a standard register marker. "
        f"Lexical density of {pos.lexical_density:.4f} puts {fpct(pos.lexical_density)} of "
        f"tokens in content-word classes."
    )


def interp_sentence_stats(stats: Any) -> str:
    label = _bands(
        stats.mean_sentence_length,
        [("very short", 12.0), ("short-to-moderate", 18.0), ("moderate", 25.0), ("long", float("inf"))],
    )
    return (
        f"Mean sentence length of {stats.mean_sentence_length:.2f} words is {label}, with a "
        f"standard deviation of {stats.sentence_length_std:.2f}. Sentences run from "
        f"{fwords(stats.min_sentence_length)} to {fwords(stats.max_sentence_length)} across "
        f"{fwords(stats.sentence_count, 'sentence')}. If the standard deviation is a large "
        f"fraction of the mean, the text is deliberately varying its sentence lengths rather "
        f"than holding to a rhythm."
    )


def interp_advanced(adv: Any) -> str:
    clausal = _bands(
        adv.clausal_density,
        [("paratactic", 1.5), ("moderate", 2.5), ("hypotactic", 3.5), ("heavily subordinated", float("inf"))],
    )
    voice = _bands(
        adv.passive_voice_ratio,
        [("rarely passive", 0.08), ("moderately passive", 0.15), ("heavily passive", float("inf"))],
    )
    branching = "right-branching" if adv.right_branching_ratio > adv.left_branching_ratio else "left-branching"
    return (
        f"Clausal density of {adv.clausal_density:.4f} clauses per T-unit is {clausal}, with a "
        f"mean parse-tree depth of {adv.mean_parse_tree_depth:.2f} (max "
        f"{adv.max_parse_tree_depth:g}). The text is {voice} at "
        f"{fpct(adv.passive_voice_ratio)} of clauses, and it is predominantly {branching} "
        f"({fpct(adv.right_branching_ratio)} right vs "
        f"{fpct(adv.left_branching_ratio)} left). Mean dependency distance of "
        f"{adv.dependency_distance:.2f} words measures how far modifiers sit from what they "
        f"modify, and tracks working-memory load for a reader."
    )


def interp_sentence_types(types: Any) -> str:
    structural = max(
        [
            ("simple", types.simple_ratio),
            ("compound", types.compound_ratio),
            ("complex", types.complex_ratio),
            ("compound-complex", types.compound_complex_ratio),
        ],
        key=lambda pair: pair[1],
    )
    functional = max(
        [
            ("declarative", types.declarative_ratio),
            ("interrogative", types.interrogative_ratio),
            ("imperative", types.imperative_ratio),
            ("exclamatory", types.exclamatory_ratio),
        ],
        key=lambda pair: pair[1],
    )
    subordination = ""
    if types.complex_ratio + types.compound_complex_ratio > 0.25:
        subordination = (
            f" Complex and compound-complex sentences together account for "
            f"{fpct(types.complex_ratio + types.compound_complex_ratio)} of the total against "
            f"{fpct(types.simple_ratio + types.compound_ratio)} simple and compound, so clauses "
            f"are stacked by subordination rather than chained by coordination."
        )
    elif types.simple_ratio > 0.6:
        subordination = (
            f" Simple sentences are {fpct(types.simple_ratio)} of the total, so the text "
            f"rarely nests clauses at all."
        )
    if types.structural_diversity >= types.functional_diversity:
        diversity = (
            f"the text varies its sentence shapes "
            f"({types.structural_diversity:.4f} bits) more than its sentence purposes "
            f"({types.functional_diversity:.4f} bits)."
        )
    else:
        diversity = (
            f"the text varies its sentence purposes "
            f"({types.functional_diversity:.4f} bits) more than its sentence shapes "
            f"({types.structural_diversity:.4f} bits)."
        )
    return (
        f"The dominant structure is {structural[0]} ({fpct(structural[1])} of "
        f"{fwords(types.total_sentences, 'sentence')}) and the dominant function is "
        f"{functional[0]} ({fpct(functional[1])})."
        + subordination
        + f" Measured as entropy, {diversity}"
    )


def interp_character(chars: Any) -> str:
    top = sorted(chars.letter_frequency.items(), key=lambda kv: -kv[1])[:10]
    letters = [letter for letter, _ in top]
    expected = set("etaoinshrd")
    overlap = len(expected.intersection(letters[:9]))
    if overlap >= 7:
        verdict = (
            "so the character inventory is unremarkable — which is itself worth knowing, "
            "because it means the text carries no obvious cipher or heavy non-English material."
        )
    elif letters:
        verdict = (
            f"which is lower than English prose normally scores ({overlap} of 9 against an "
            f"expected 7 or more). That is weak evidence of non-English material, heavy "
            f"specialist vocabulary, or simply a short text whose letter distribution has not "
            f"settled."
        )
    else:
        verdict = "so there is nothing to compare against the expected English ordering."
    return (
        f"Average word length of {chars.avg_word_length:.2f} characters and "
        f"{chars.punctuation_density:.2f} punctuation marks per 100 words are typical of "
        f"English prose. {overlap} of the nine most common letters here "
        f"({', '.join(letters[:9])}) belong to the standard ETAOIN SHRDLU ordering, {verdict}"
    )


def interp_entropy(char_bi: Any, word_bi: Any) -> str:
    return (
        f"Character bigram entropy of {char_bi.entropy:.4f} bits "
        f"(perplexity {char_bi.perplexity:,.4f}) shows how predictable the orthography is, "
        f"while word bigram entropy of {word_bi.entropy:.4f} bits "
        f"(perplexity {word_bi.perplexity:,.4f}) shows how predictable the collocations are. "
        f"High word-level perplexity relative to character-level means the text is locally "
        f"spellable but not locally formulaic: few fixed phrases, many fresh word pairings."
    )


def interp_markers(markers: Any, typographic_quotes: bool = False) -> str:
    contraction = (
        "no contractions at all, which is a formal, largely expository surface"
        if markers.contraction_ratio == 0
        else f"a contraction ratio of {markers.contraction_ratio:.4f}"
    )
    if markers.hedging_density <= 0 and markers.intensifier_density <= 0:
        balance = (
            "Neither intensifiers nor hedges appear at all, so there is no evidence here "
            "about emphasis versus qualification."
        )
    elif markers.hedging_density <= 0 and markers.intensifier_density > 0:
        balance = (
            f"Hedges do not appear at all, so the voice is emphatic rather than qualifying: "
            f"every intensifier stands unqualified."
        )
    elif markers.hedging_density > 0 and markers.intensifier_density > 1.5 * markers.hedging_density:
        balance = (
            f"Intensifiers outnumber hedges by about "
            f"{markers.intensifier_density / max(markers.hedging_density, 1e-9):.1f} to 1, "
            f"which is an emphatic rather than a qualifying voice."
        )
    elif markers.hedging_density >= markers.intensifier_density:
        balance = (
            "Hedges are at least as frequent as intensifiers, which is the more careful, "
            "qualifying register."
        )
    else:
        balance = (
            "Intensifiers and hedges are within a factor of 1.5 of each other, so neither "
            "emphasis nor qualification dominates."
        )
    modal_sum = markers.epistemic_modal_ratio + markers.deontic_modal_ratio
    modal_note = ""
    if modal_sum > 1.02:
        modal_note = (
            f" (The two modal ratios sum to {modal_sum:.4f}, above 1: the library classifies "
            f"modals into the two categories independently, so some modals count in both.)"
        )
    quote_note = ""
    if typographic_quotes and markers.quotation_density == 0:
        quote_note = (
            " Quotation density reads as zero despite the text containing quotation marks, "
            "because curly quotes are not matched by the counter; treat the quotation and "
            "dialogue figures in this report as lower bounds."
        )
    else:
        quote_note = ""
    modal_sentence = ""
    if modal_sum > 0:
        if markers.epistemic_modal_ratio > markers.deontic_modal_ratio:
            modal_sentence = (
                " Because epistemic modality leads, the writing is more likely to speculate "
                "than to instruct."
            )
        elif markers.deontic_modal_ratio > markers.epistemic_modal_ratio:
            modal_sentence = (
                " Because deontic modality leads, the writing is more likely to instruct than "
                "to speculate."
            )
        else:
            modal_sentence = " The two modal categories are balanced in this text."
    return (
        f"The text shows {contraction}. Intensifier density is "
        f"{markers.intensifier_density:.2f} per 100 words against hedging density of "
        f"{markers.hedging_density:.2f}. {balance} {fpct(markers.epistemic_modal_ratio)} of the "
        f"modals are epistemic (possibility and inference: may, might, could) against "
        f"{fpct(markers.deontic_modal_ratio)} deontic (obligation and permission: must, "
        f"should){modal_note}.{modal_sentence} "
        f"Semicolons run at {markers.semicolon_density:.2f} and exclamation marks at "
        f"{markers.exclamation_density:.2f} per 100 words.{quote_note}"
    )


def interp_genre(genre: Any) -> str:
    caveat = ""
    if genre.register_classification in {"frozen", "formal"} and genre.formality_score < 40:
        caveat = (
            f" The register label and the formality score disagree here — "
            f"\"{genre.register_classification}\" is not usually compatible with a formality "
            f"score of {genre.formality_score:.2f} — so take the label as unreliable for this "
            f"text."
        )
    return (
        f"The register classifier puts this at \"{genre.register_classification}\" with a "
        f"formality score of {genre.formality_score:.2f} out of 100, and predicts the genre "
        f"\"{genre.predicted_genre}\" with confidence {genre.genre_confidence:.2f}. "
        f"Narrative markers ({genre.narrative_marker_density:.2f} per 100 words) run against "
        f"expository markers ({genre.expository_marker_density:.2f}), and estimated dialogue "
        f"covers {fpct(genre.dialogue_ratio)} of the text." + caveat
    )


def interp_dialect(dialect: Any) -> str:
    return (
        f"The marker inventory classifies this as {dialect.dialect} English with confidence "
        f"{dialect.confidence:.2f} (British {dialect.british_score:.4f} vs American "
        f"{dialect.american_score:.4f}). Markedness of {dialect.markedness_score:.4f} measures "
        f"how far the text departs from unmarked standard English; low markedness means few "
        f"diagnostic choices were available to be made. Note the variance across chunks "
        f"(std {dialect.british_score_dist.std:.4f} for British markers) before treating this "
        f"as a single consistent author: dialect markers are sparse, so a mixed score is weak "
        f"evidence, and {fwords(dialect.chunk_count, 'chunk')} is the denominator those means "
        f"rest on."
    )


def interp_drift(drift: Any) -> str:
    if drift.status != "success":
        return (
            f"Drift analysis returned status \"{drift.status}\": {drift.status_message}"
        )
    direction = ""
    if drift.pattern == "gradual_drift":
        if drift.trend >= 0:
            direction = " The trend slope is positive, so the distance rises across the text."
        else:
            direction = (
                " The trend slope is negative, so the distance falls across the text — the "
                "library classifies on the magnitude of the slope, not its sign."
            )
    return (
        f"Over {fwords(drift.window_count, 'window')} of {drift.window_size:,} words with a "
        f"stride of {drift.stride:,} ({fpct(drift.overlap_ratio)} overlap, "
        f"{drift.comparison_mode} comparison), the chi-squared distance between adjacent "
        f"windows averages {fnum(drift.mean_chi_squared, 2)} with a standard deviation of "
        f"{fnum(drift.std_chi_squared, 2)}, peaking at {fnum(drift.max_chi_squared, 2)}. The "
        f"classifier calls the pattern \"{drift.pattern}\" with confidence "
        f"{fnum(drift.pattern_confidence, 2)} and a trend slope of {fnum(drift.trend, 4)}. "
        f"\"Consistent\" means no window stands out from its neighbours; \"gradual_drift\" "
        f"means the distance changes steadily across the text; \"sudden_spike\" means one "
        f"boundary does, which is what pasted or freshly edited material usually looks like."
        + direction
    )


def interp_prosody(rhythm: Any) -> str:
    return (
        f"{rhythm.mean_syllables_per_word:.4f} syllables per word with a standard deviation of "
        f"{rhythm.syllable_std_dev:.4f} gives a rhythmic regularity of "
        f"{rhythm.rhythmic_regularity:.4f}. The stress-pattern entropy of "
        f"{rhythm.stress_pattern_entropy:.4f} bits measures how varied the sound shapes are, "
        f"and alliteration density ({rhythm.alliteration_density:.4f} pairs per 100 words) "
        f"captures deliberate sound repetition. {fpct(rhythm.polysyllabic_ratio)} of words are "
        f"three syllables or longer, which is where prose rhythm usually starts to feel "
        f"weighted."
    )


def interp_cohesion(cohesion: Any) -> str:
    return (
        f"Pronoun density of {cohesion.pronoun_density:.2f} and connective density of "
        f"{cohesion.connective_density:.2f} per 100 words are the two workhorses of cohesion "
        f"here. Adjacent-sentence overlap of {cohesion.adjacent_sentence_overlap:.4f} says how "
        f"much vocabulary carries from one sentence to the next; a low figure with a high "
        f"pronoun density is the signature of reference-by-pronoun rather than reference-by-"
        f"repetition. The composite semantic coherence score is "
        f"{cohesion.semantic_coherence_score:.4f} across {cohesion.paragraph_count} paragraphs "
        f"averaging {cohesion.mean_paragraph_length:.2f} sentences each."
    )


# ---------------------------------------------------------------------------
# Analysis runner
# ---------------------------------------------------------------------------


def _call(fn: Callable, text: str, chunk_size: int) -> Any:
    """Call an analysis function, passing chunk_size only if it accepts one."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        params = {}
    if "chunk_size" in params:
        return fn(text, chunk_size=chunk_size)
    return fn(text)


def run_analysis(text: str, chunk_size: int, want: set[str], log: Callable[[str], None],
                 all_metrics: bool = True) -> dict[str, Any]:
    """Run every requested analysis, collecting failures instead of raising.

    With ``all_metrics`` false, the narrowed categories (see CORE_ANALYSES) run
    only their core measures, which is also most of the runtime saving.
    """
    results: dict[str, Any] = {}
    skipped: list[tuple[str, str]] = []

    def attempt(key: str, label: str, section: str, fn: Callable, *args: Any, **kwargs: Any) -> None:
        if section not in want:
            return
        try:
            results[key] = fn(*args, **kwargs)
        except ImportError as exc:
            skipped.append((f"{section}: {label}", f"missing dependency ({exc})"))
            log(f"  skipped {label}: {exc}")
        except Exception as exc:  # noqa: BLE001 - one bad metric must not kill the report
            skipped.append((f"{section}: {label}", f"{type(exc).__name__}: {exc}"))
            log(f"  failed {label}: {type(exc).__name__}: {exc}")

    def load(module: str, section: str) -> Any:
        """Import a pystylometry submodule, or record the whole section as skipped.

        Some submodules import their optional dependencies at module level, so a
        missing cmudict or spaCy surfaces here rather than at call time.
        """
        try:
            return importlib.import_module(f"pystylometry.{module}")
        except Exception as exc:  # noqa: BLE001
            skipped.append((f"{section}: all", f"import failed ({type(exc).__name__}: {exc})"))
            log(f"  skipped section {section}: {exc}")
            return None

    # -- Lexical ------------------------------------------------------------
    lexical = load("lexical", "lexical")

    if lexical is not None:
        for key, label, fn in [
            ("ttr", "TTR", lexical.compute_ttr),
            ("mtld", "MTLD", lexical.compute_mtld),
            ("yule", "Yule's K/I", lexical.compute_yule),
            ("hapax", "hapax ratios", lexical.compute_hapax_ratios),
            ("function_words", "function words", lexical.compute_function_words),
            ("vocd_d", "VocD-D", lexical.compute_vocd_d),
            ("mattr", "MATTR", lexical.compute_mattr),
            ("hdd", "HD-D", lexical.compute_hdd),
            ("msttr", "MSTTR", lexical.compute_msttr),
            ("freq_soph", "word frequency sophistication", lexical.compute_word_frequency_sophistication),
            ("word_class", "word class distribution", lexical.compute_word_class_distribution),
        ]:
            if not all_metrics and key not in CORE_ANALYSES["lexical"]:
                continue
            attempt(key, label, "lexical", _call, fn, text, chunk_size)

    if "extras" in want:
        if lexical is not None:
            attempt("bnc", "BNC frequency", "extras", _call, lexical.compute_bnc_frequency, text, chunk_size)
            attempt("rep_uni", "repetitive unigrams", "extras", _call, lexical.compute_repetitive_unigrams, text, chunk_size)
            attempt("rep_ng", "repetitive n-grams", "extras", _call, lexical.compute_repetitive_ngrams, text, chunk_size)

    # -- Readability --------------------------------------------------------
    readability = load("readability", "readability") if "readability" in want else None

    if readability is not None:
        for key, label, fn in [
            ("flesch", "Flesch", readability.compute_flesch),
            ("smog", "SMOG", readability.compute_smog),
            ("gunning_fog", "Gunning Fog", readability.compute_gunning_fog),
            ("coleman_liau", "Coleman-Liau", readability.compute_coleman_liau),
            ("ari", "ARI", readability.compute_ari),
            ("dale_chall", "Dale-Chall", readability.compute_dale_chall),
            ("linsear", "Linsear Write", readability.compute_linsear_write),
            ("fry", "Fry", readability.compute_fry),
            ("forcast", "FORCAST", readability.compute_forcast),
            ("psk", "Powers-Sumner-Kearl", readability.compute_powers_sumner_kearl),
        ]:
            if not all_metrics and key not in CORE_ANALYSES["readability"]:
                continue
            attempt(key, label, "readability", _call, fn, text, chunk_size)

    # -- Syntactic ----------------------------------------------------------
    syntactic = load("syntactic", "syntactic") if "syntactic" in want else None

    if syntactic is not None:
        for key, label, fn in [
            ("pos", "POS ratios", syntactic.compute_pos_ratios),
            ("sentence_stats", "sentence statistics", syntactic.compute_sentence_stats),
            ("sentence_types", "sentence types", syntactic.compute_sentence_types),
            ("advanced", "advanced syntax", syntactic.compute_advanced_syntactic),
        ]:
            attempt(key, label, "syntactic", _call, fn, text, chunk_size)

    # -- Character ----------------------------------------------------------
    if "character" in want:
        character_mod = load("character", "character")

        if character_mod is not None:
            attempt("character", "character metrics", "character", _call, character_mod.compute_character_metrics, text, chunk_size)

    # -- N-grams ------------------------------------------------------------
    if "ngrams" in want:
        ngrams = load("ngrams", "ngrams")

        if ngrams is not None:
            attempt("char_bigram", "character bigram entropy", "ngrams", _call, ngrams.compute_character_bigram_entropy, text, chunk_size)
            attempt("word_bigram", "word bigram entropy", "ngrams", _call, ngrams.compute_word_bigram_entropy, text, chunk_size)
            attempt("extended_ngrams", "extended n-grams", "ngrams", ngrams.compute_extended_ngrams, text)

    # -- Style markers ------------------------------------------------------
    if "markers" in want:
        stylistic = load("stylistic", "markers")

        if stylistic is not None:
            attempt("markers", "style markers", "markers", stylistic.compute_stylistic_markers, text)

    # -- Genre / register ---------------------------------------------------
    if "genre" in want:
        stylistic = load("stylistic", "genre")

        if stylistic is not None:
            attempt("genre", "genre and register", "genre", stylistic.compute_genre_register, text)

    # -- Cohesion -----------------------------------------------------------
    if "cohesion" in want:
        stylistic = load("stylistic", "cohesion")

        if stylistic is not None:
            attempt("cohesion", "cohesion and coherence", "cohesion", stylistic.compute_cohesion_coherence, text)

    # -- Dialect ------------------------------------------------------------
    if "dialect" in want:
        dialect_mod = load("dialect", "dialect")

        if dialect_mod is not None:
            attempt("dialect", "dialect", "dialect", _call, dialect_mod.compute_dialect, text, chunk_size)

    # -- Drift --------------------------------------------------------------
    if "drift" in want:
        consistency = load("consistency", "drift")

        if consistency is not None:
            attempt(
                "drift",
                "style drift",
                "drift",
                consistency.compute_kilgarriff_drift,
                text,
                window_size=DRIFT_WINDOW,
                stride=DRIFT_STRIDE,
            )

    # -- Prosody ------------------------------------------------------------
    if "prosody" in want:
        prosody = load("prosody", "prosody")

        if prosody is not None:
            attempt("rhythm", "rhythm and prosody", "prosody", prosody.compute_rhythm_prosody, text)
            attempt("sentence_syllables", "sentence syllable patterns", "prosody", prosody.compute_sentence_syllable_patterns, text)
            if "sentence_syllables" in results:
                attempt(
                    "syllable_patterns",
                    "syllable pattern repetition",
                    "prosody",
                    prosody.analyze_syllable_pattern_repetition,
                    results["sentence_syllables"],
                )

    results["_skipped"] = skipped
    return results


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------


def render_summary(meta: dict[str, Any], results: dict[str, Any], text: str, args: argparse.Namespace) -> str:
    ttr = results.get("ttr")
    out = []
    if meta.get("author") or meta.get("year") or meta.get("genre"):
        out.append(para(f"by {meta.get('author') or 'unknown author'}" + (f" ({meta['year']})" if meta.get("year") else "")))

    table = Table("Property", "Value")
    table.row("**Author**", meta.get("author") or "_not given_")
    table.row("**Title**", meta.get("title") or "_not given_")
    table.row("**Year**", meta.get("year") or "_not given_")
    table.row("**Source file**", f"`{Path(meta['source']).name}`")
    table.row("**Characters**", f"{len(text):,}")
    table.row("**Whitespace tokens**", f"{len(text.split()):,}")
    table.row("**Sentences (segmenter)**", meta.get("sentence_count", "n/a"))
    table.row("**Paragraphs (segmenter)**", meta.get("paragraph_count", "n/a"))
    if ttr is not None:
        table.row("**Types (unique words)**", f"{ttr.unique_words:,}")
        table.row("**Tokens (analysed)**", f"{ttr.total_words:,}")
    table.row("**Genre**", meta.get("genre") or "_not given_")
    table.row("**Chunk size used**", f"{args.chunk_size:,} words")
    out.append(table.render())

    if ttr is not None:
        per_token = 1 / ttr.ttr if ttr.ttr else float("inf")
        out.append(para(
            f"Type-token ratio of {ttr.ttr:.4f} means one distinct word per "
            f"{per_token:.1f} tokens. For reference, that is the headline "
            f"vocabulary-density number, and most of the tables below qualify it in some way."
        ))
    if len(text.split()) < 2000:
        out.append(para(
            f"_This text is short ({len(text.split()):,} tokens). Several metrics — MTLD, "
            f"Yule's K, Honore's R, vocd-D, HD-D — were calibrated on texts of at least a few "
            f"thousand words, and the readability formulas assume at least 100 words and a "
            f"handful of sentences. Treat the numbers below as a smoke test rather than a "
            f"profile._"
        ))
    return "\n".join(out)


def render_summary_table(results: dict[str, Any], text: str, meta: dict[str, Any], args: argparse.Namespace,
                         expanded: bool = True) -> str:
    """One flat table holding every computed metric.

    This is the report in digest form: Category | Metric | Value, with one row
    per metric, grouped by the report section the metric belongs to. Rows whose
    metric was skipped or unsupported are simply absent.
    """
    rows: list[tuple[str, str, str]] = []

    def add(category: str, metric: str, value: Any) -> None:
        if value is None:
            return
        if not args.all_metrics and metric not in CORE_TABLE_ROWS.get(category, frozenset({metric})):
            return
        text_value = value if isinstance(value, str) else fnum(value)
        if text_value in {"", "n/a"}:
            return
        rows.append((category, metric, ftext(text_value)))

    def field(category: str, metric: str, obj: Any, attr: str, nd: int = 4,
              scale: float | None = None, suffix: str = "", integer: bool = False) -> None:
        """Add ``obj.attr`` as a row, skipping missing and unusable values."""
        if obj is None:
            return
        value = getattr(obj, attr, None)
        if value is None:
            return
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return
            if scale is not None:
                value = value * scale
            formatted = f"{value:,.0f}{suffix}" if integer else f"{fnum(value, nd)}{suffix}"
        else:
            formatted = str(value) + suffix
        add(category, metric, formatted)

    # -- Text ---------------------------------------------------------------
    add("Text", "Title", meta.get("title"))
    add("Text", "Author", meta.get("author"))
    add("Text", "Year", meta.get("year"))
    add("Text", "Genre", meta.get("genre"))
    add("Text", "Source file", f"`{Path(meta['source']).name}`")
    add("Text", "Characters", len(text))
    add("Text", "Tokens (whitespace)", len(text.split()))
    add("Text", "Sentences (segmenter)", meta.get("sentence_count"))
    add("Text", "Paragraphs (segmenter)", meta.get("paragraph_count"))
    add("Text", "Types (distinct words)", meta.get("type_count"))
    add("Text", "Chunk size (words)", f"{args.chunk_size:,}")
    add("Text", "Generated", meta.get("generated"))

    # -- Lexical ------------------------------------------------------------
    ttr, mtld = results.get("ttr"), results.get("mtld")
    for metric, attr, nd in [
        ("Raw TTR", "ttr", 4),
        ("Root TTR (Guiraud)", "root_ttr", 4),
        ("Log TTR (Herdan C)", "log_ttr", 4),
        ("STTR", "sttr", 4),
        ("Delta std", "delta_std", 4),
    ]:
        field("Lexical", metric, ttr, attr, nd)
    field("Lexical", "Types", ttr, "unique_words", integer=True)
    field("Lexical", "Tokens (analysed)", ttr, "total_words", integer=True)
    field("Lexical", "Chunks", ttr, "chunk_count", integer=True)
    for metric, attr in [
        ("MTLD forward", "mtld_forward"),
        ("MTLD backward", "mtld_backward"),
        ("MTLD average", "mtld_average"),
    ]:
        field("Lexical", metric, mtld, attr, 2)

    yule = results.get("yule")
    field("Lexical", "Yule's K", yule, "yule_k", 4)
    field("Lexical", "Yule's I", yule, "yule_i", 4)

    hapax = results.get("hapax")
    for metric, attr, nd in [
        ("Hapax count", "hapax_count", 0),
        ("Hapax ratio", "hapax_ratio", 4),
        ("Dislegomena count", "dis_hapax_count", 0),
        ("Dislegomena ratio", "dis_hapax_ratio", 4),
        ("Sichel's S", "sichel_s", 4),
        ("Honore's R", "honore_r", 2),
    ]:
        field("Lexical", metric, hapax, attr, nd, integer=nd == 0)

    fw = results.get("function_words")
    for metric, attr in [
        ("Function word ratio", "total_function_word_ratio"),
        ("Function word diversity", "function_word_diversity"),
        ("Determiner ratio", "determiner_ratio"),
        ("Preposition ratio", "preposition_ratio"),
        ("Conjunction ratio", "conjunction_ratio"),
        ("Pronoun ratio", "pronoun_ratio"),
        ("Auxiliary ratio", "auxiliary_ratio"),
        ("Particle ratio", "particle_ratio"),
    ]:
        field("Lexical", metric, fw, attr, 4)

    vocd = results.get("vocd_d")
    field("Lexical", "vocd-D parameter", vocd, "d_parameter", 2)
    field("Lexical", "vocd-D curve fit R2", vocd, "curve_fit_r_squared", 4)

    mattr, msttr = results.get("mattr"), results.get("msttr")
    field("Lexical", "MATTR", mattr, "mattr_score", 4)
    field("Lexical", "MATTR std dev", mattr, "ttr_std_dev", 4)
    field("Lexical", "MATTR window size", mattr, "window_size", integer=True)
    field("Lexical", "MSTTR", msttr, "msttr_score", 4)
    field("Lexical", "MSTTR std dev", msttr, "ttr_std_dev", 4)
    field("Lexical", "MSTTR segment size", msttr, "segment_size", integer=True)
    field("Lexical", "HD-D", results.get("hdd"), "hdd_score", 2)

    fs = results.get("freq_soph")
    for metric, attr, nd in [
        ("Mean frequency rank", "mean_frequency_rank", 2),
        ("Median frequency rank", "median_frequency_rank", 2),
        ("Rare word ratio", "rare_word_ratio", 4),
        ("Common word ratio", "common_word_ratio", 4),
        ("Academic word ratio", "academic_word_ratio", 4),
        ("Advanced word ratio", "advanced_word_ratio", 4),
    ]:
        field("Lexical", metric, fs, attr, nd)

    wc = results.get("word_class")
    if wc is not None:
        non_lexical = [c for c in wc.classifications if c.label != "lexical"]
        add("Lexical", "Word class labels", wc.unique_labels)
        add("Lexical", "Non-lexical surface forms", sum(c.count for c in non_lexical))
        if non_lexical:
            top = max(non_lexical, key=lambda c: c.count)
            add("Lexical", "Largest non-lexical class", f"{top.label} ({top.count:,})")

    # -- Readability --------------------------------------------------------
    flesch = results.get("flesch")
    field("Readability", "Flesch reading ease", flesch, "reading_ease", 2)
    field("Readability", "Flesch-Kincaid grade", flesch, "grade_level", 2)
    if flesch is not None:
        add("Readability", "Flesch difficulty band", flesch.difficulty)
    field("Readability", "SMOG index", results.get("smog"), "smog_index", 2)
    field("Readability", "SMOG grade", results.get("smog"), "grade_level", 1)
    field("Readability", "Gunning Fog index", results.get("gunning_fog"), "fog_index", 2)
    field("Readability", "Gunning Fog grade", results.get("gunning_fog"), "grade_level", 1)
    field("Readability", "Coleman-Liau index", results.get("coleman_liau"), "cli_index", 2)
    field("Readability", "Coleman-Liau grade", results.get("coleman_liau"), "grade_level", 1)
    field("Readability", "ARI score", results.get("ari"), "ari_score", 2)
    field("Readability", "ARI grade", results.get("ari"), "grade_level", 1)
    field("Readability", "Fry grade", results.get("fry"), "grade_level", 1)
    field("Readability", "Fry syllables per 100 words", results.get("fry"), "avg_syllables_per_100", 2)
    field("Readability", "FORCAST score", results.get("forcast"), "forcast_score", 2)
    field("Readability", "FORCAST grade", results.get("forcast"), "grade_level", 1)
    field("Readability", "Powers-Sumner-Kearl score", results.get("psk"), "psk_score", 2)
    field("Readability", "Powers-Sumner-Kearl grade", results.get("psk"), "grade_level", 2)

    dale = results.get("dale_chall")
    field("Readability", "Dale-Chall score", dale, "dale_chall_score", 2)
    field("Readability", "Dale-Chall difficult word ratio", dale, "difficult_word_ratio", 4)
    if dale is not None:
        add("Readability", "Dale-Chall grade", fgrade(dale.grade_level))
    linsear = results.get("linsear")
    field("Readability", "Linsear Write score", linsear, "linsear_score", 2)
    field("Readability", "Linsear Write grade", linsear, "grade_level", 1)

    grades = [
        getattr(results[k], "grade_level", None)
        for k in ("flesch", "smog", "gunning_fog", "coleman_liau", "ari", "dale_chall", "linsear", "fry", "forcast")
        if results.get(k) is not None
    ]
    grades = [g for g in grades if isinstance(g, (int, float)) and not isinstance(g, bool)
              and not (isinstance(g, float) and math.isnan(g))]
    if grades:
        add("Readability", "Average grade level", f"{sum(grades) / len(grades):.1f} ({len(grades)} formulas)")

    # -- Syntactic ----------------------------------------------------------
    pos = results.get("pos")
    for metric, attr in [
        ("Noun ratio", "noun_ratio"),
        ("Verb ratio", "verb_ratio"),
        ("Adjective ratio", "adjective_ratio"),
        ("Adverb ratio", "adverb_ratio"),
        ("Noun-verb ratio", "noun_verb_ratio"),
        ("Adjective-noun ratio", "adjective_noun_ratio"),
        ("Lexical density", "lexical_density"),
        ("POS function word ratio", "function_word_ratio"),
    ]:
        field("Syntactic", metric, pos, attr, 4)

    stats = results.get("sentence_stats")
    for metric, attr, nd in [
        ("Sentence count", "sentence_count", 0),
        ("Mean sentence length (words)", "mean_sentence_length", 2),
        ("Sentence length std dev", "sentence_length_std", 2),
        ("Min sentence length", "min_sentence_length", 1),
        ("Max sentence length", "max_sentence_length", 1),
        ("Sentence length range", "sentence_length_range", 1),
    ]:
        field("Syntactic", metric, stats, attr, nd, integer=nd == 0)

    adv = results.get("advanced")
    for metric, attr, nd in [
        ("Mean parse tree depth", "mean_parse_tree_depth", 2),
        ("Max parse tree depth", "max_parse_tree_depth", 2),
        ("T-unit count", "t_unit_count", 0),
        ("Mean T-unit length (words)", "mean_t_unit_length", 2),
        ("Clausal density", "clausal_density", 4),
        ("Dependent clause ratio", "dependent_clause_ratio", 4),
        ("Passive voice ratio", "passive_voice_ratio", 4),
        ("Subordination index", "subordination_index", 4),
        ("Coordination index", "coordination_index", 4),
        ("Sentence complexity score", "sentence_complexity_score", 4),
        ("Dependency distance", "dependency_distance", 4),
        ("Left branching ratio", "left_branching_ratio", 4),
        ("Right branching ratio", "right_branching_ratio", 4),
    ]:
        field("Syntactic", metric, adv, attr, nd, integer=nd == 0)

    types = results.get("sentence_types")
    for metric, attr, count_attr in [
        ("Simple sentence ratio", "simple_ratio", "simple_count"),
        ("Compound sentence ratio", "compound_ratio", "compound_count"),
        ("Complex sentence ratio", "complex_ratio", "complex_count"),
        ("Compound-complex sentence ratio", "compound_complex_ratio", "compound_complex_count"),
        ("Declarative ratio", "declarative_ratio", "declarative_count"),
        ("Interrogative ratio", "interrogative_ratio", "interrogative_count"),
        ("Imperative ratio", "imperative_ratio", "imperative_count"),
        ("Exclamatory ratio", "exclamatory_ratio", "exclamatory_count"),
    ]:
        field("Syntactic", metric, types, attr, 4)
        field("Syntactic", metric.replace(" ratio", " count"), types, count_attr, integer=True)
    field("Syntactic", "Structural diversity (entropy)", types, "structural_diversity", 4)
    field("Syntactic", "Functional diversity (entropy)", types, "functional_diversity", 4)
    field("Syntactic", "Sentences classified", types, "total_sentences", integer=True)

    # -- Character ----------------------------------------------------------
    chars = results.get("character")
    for metric, attr, nd, scale in [
        ("Average word length (chars)", "avg_word_length", 2, None),
        ("Average sentence length (chars)", "avg_sentence_length_chars", 2, None),
        ("Punctuation density (per 100 words)", "punctuation_density", 2, None),
        ("Punctuation variety", "punctuation_variety", 0, None),
        ("Vowel-consonant ratio", "vowel_consonant_ratio", 4, None),
        ("Digit count", "digit_count", 0, None),
        ("Digit ratio", "digit_ratio", 6, None),
        ("Uppercase ratio", "uppercase_ratio", 4, None),
        ("Whitespace ratio", "whitespace_ratio", 4, None),
    ]:
        field("Character", metric, chars, attr, nd, integer=nd == 0)
    if chars is not None and chars.letter_frequency:
        letter, freq = max(chars.letter_frequency.items(), key=lambda kv: kv[1])
        add("Character", "Most frequent letter", f"{letter} ({fpct(freq)})")

    # -- N-grams ------------------------------------------------------------
    char_bi, word_bi = results.get("char_bigram"), results.get("word_bigram")
    field("N-grams", "Character bigram entropy (bits)", char_bi, "entropy", 4)
    field("N-grams", "Character bigram perplexity", char_bi, "perplexity", 2)
    field("N-grams", "Word bigram entropy (bits)", word_bi, "entropy", 4)
    field("N-grams", "Word bigram perplexity", word_bi, "perplexity", 2)

    ext = results.get("extended_ngrams")
    field("N-grams", "Word trigram entropy (bits)", ext, "word_trigram_entropy", 4)
    field("N-grams", "Word 4-gram entropy (bits)", ext, "word_4gram_entropy", 4)
    field("N-grams", "Character trigram entropy (bits)", ext, "char_trigram_entropy", 4)
    field("N-grams", "Character 4-gram entropy (bits)", ext, "char_4gram_entropy", 4)
    field("N-grams", "POS trigram entropy (bits)", ext, "pos_trigram_entropy", 4)
    field("N-grams", "Distinct word trigrams", ext, "word_trigram_count", integer=True)
    field("N-grams", "Distinct word 4-grams", ext, "word_4gram_count", integer=True)
    if ext is not None:
        top = _clean_ngrams(ext.top_word_trigrams, 1)
        if top:
            add("N-grams", "Top word trigram", f"{top[0][0]} ({top[0][1]:,})")

    # -- Markers ------------------------------------------------------------
    m = results.get("markers")
    for metric, attr, nd in [
        ("Contraction ratio", "contraction_ratio", 4),
        ("Contraction count", "contraction_count", 0),
        ("Expanded form count", "expanded_form_count", 0),
        ("Intensifier density (per 100 words)", "intensifier_density", 2),
        ("Intensifier count", "intensifier_count", 0),
        ("Hedging density (per 100 words)", "hedging_density", 2),
        ("Hedging count", "hedging_count", 0),
        ("Modal density (per 100 words)", "modal_density", 2),
        ("Epistemic modal ratio", "epistemic_modal_ratio", 4),
        ("Deontic modal ratio", "deontic_modal_ratio", 4),
        ("Negation density (per 100 words)", "negation_density", 2),
        ("Negation count", "negation_count", 0),
        ("Exclamation density (per 100 words)", "exclamation_density", 2),
        ("Question density (per 100 words)", "question_density", 2),
        ("Quotation density (per 100 words)", "quotation_density", 2),
        ("Parenthetical density (per 100 words)", "parenthetical_density", 2),
        ("Ellipsis density (per 100 words)", "ellipsis_density", 2),
        ("Dash density (per 100 words)", "dash_density", 2),
        ("Semicolon density (per 100 words)", "semicolon_density", 2),
        ("Colon density (per 100 words)", "colon_density", 2),
    ]:
        field("Markers", metric, m, attr, nd, integer=nd == 0)

    # -- Genre --------------------------------------------------------------
    g = results.get("genre")
    if g is not None:
        add("Genre", "Register classification", g.register_classification)
        add("Genre", "Predicted genre", g.predicted_genre)
    for metric, attr, nd in [
        ("Genre confidence", "genre_confidence", 4),
        ("Formality score", "formality_score", 2),
        ("Latinate ratio", "latinate_ratio", 4),
        ("Nominalization density", "nominalization_density", 2),
        ("Passive voice density", "passive_voice_density", 2),
        ("First person ratio", "first_person_ratio", 4),
        ("Second person ratio", "second_person_ratio", 4),
        ("Third person ratio", "third_person_ratio", 4),
        ("Impersonal construction density", "impersonal_construction_density", 2),
        ("Abstract noun ratio", "abstract_noun_ratio", 4),
        ("Concrete noun ratio", "concrete_noun_ratio", 4),
        ("Abstractness score", "abstractness_score", 4),
        ("Technical term density", "technical_term_density", 2),
        ("Narrative marker density", "narrative_marker_density", 2),
        ("Expository marker density", "expository_marker_density", 2),
        ("Dialogue ratio", "dialogue_ratio", 4),
        ("Fiction score", "fiction_score", 4),
        ("Academic score", "academic_score", 4),
        ("Journalistic score", "journalistic_score", 4),
        ("Legal score", "legal_score", 4),
        ("Conversational score", "conversational_score", 4),
    ]:
        field("Genre", metric, g, attr, nd)

    # -- Dialect ------------------------------------------------------------
    d = results.get("dialect")
    if d is not None:
        add("Dialect", "Dialect", d.dialect)
    for metric, attr, nd in [
        ("Dialect confidence", "confidence", 4),
        ("British score", "british_score", 4),
        ("American score", "american_score", 4),
        ("Markedness score", "markedness_score", 4),
        ("Eye dialect count", "eye_dialect_count", 0),
        ("Eye dialect ratio (per 1000 words)", "eye_dialect_ratio", 2),
        ("Dialect chunks", "chunk_count", 0),
        ("Dialect chunk size (words)", "chunk_size", 0),
    ]:
        field("Dialect", metric, d, attr, nd, integer=nd == 0)
    if d is not None:
        field("Dialect", "British score std dev", d.british_score_dist, "std", 4)
        field("Dialect", "American score std dev", d.american_score_dist, "std", 4)

    # -- Drift --------------------------------------------------------------
    dr = results.get("drift")
    if dr is not None:
        add("Drift", "Status", dr.status)
        add("Drift", "Pattern", dr.pattern)
    for metric, attr, nd in [
        ("Pattern confidence", "pattern_confidence", 4),
        ("Mean chi-squared", "mean_chi_squared", 2),
        ("Std chi-squared", "std_chi_squared", 2),
        ("Max chi-squared", "max_chi_squared", 2),
        ("Min chi-squared", "min_chi_squared", 2),
        ("Trend slope", "trend", 4),
        ("Drift windows", "window_count", 0),
        ("Drift window size (words)", "window_size", 0),
        ("Drift stride (words)", "stride", 0),
        ("Drift overlap ratio", "overlap_ratio", 4),
    ]:
        field("Drift", metric, dr, attr, nd, integer=nd == 0)

    # -- Prosody ------------------------------------------------------------
    rhythm = results.get("rhythm")
    for metric, attr, nd in [
        ("Mean syllables per word", "mean_syllables_per_word", 4),
        ("Syllable std dev", "syllable_std_dev", 4),
        ("Rhythmic regularity", "rhythmic_regularity", 4),
        ("Syllable CV", "syllable_cv", 4),
        ("Stress pattern entropy (bits)", "stress_pattern_entropy", 4),
        ("Polysyllabic ratio", "polysyllabic_ratio", 4),
        ("Monosyllabic ratio", "monosyllabic_ratio", 4),
        ("Alliteration density", "alliteration_density", 4),
        ("Assonance density", "assonance_density", 4),
        ("Consonance density", "consonance_density", 4),
        ("Sentence length alternation", "sentence_length_alternation", 4),
        ("Sentence rhythm score", "sentence_rhythm_score", 4),
        ("Iambic ratio", "iambic_ratio", 4),
        ("Trochaic ratio", "trochaic_ratio", 4),
    ]:
        field("Prosody", metric, rhythm, attr, nd)

    sent = results.get("sentence_syllables")
    for metric, attr, nd in [
        ("Sentences analysed (syllables)", "mean_syllables_per_sentence", 2),
        ("Std syllables per sentence", "std_syllables_per_sentence", 2),
        ("Sentence syllable CV", "sentence_syllable_cv", 4),
        ("Mean sentence complexity", "mean_sentence_complexity", 4),
        ("Std sentence complexity", "std_sentence_complexity", 4),
        ("Complexity uniformity score", "complexity_uniformity_score", 4),
    ]:
        if metric == "Sentences analysed (syllables)":
            if sent is not None:
                add("Prosody", metric, len(sent.sentences))
            continue
        field("Prosody", metric, sent, attr, nd)

    patterns = results.get("syllable_patterns")
    for metric, attr, nd in [
        ("Syllable patterns: unique", "total_unique_patterns", 0),
        ("Syllable patterns: instances", "total_pattern_instances", 0),
        ("Pattern diversity ratio", "pattern_diversity_ratio", 3),
        ("Repeated pattern count", "repeated_pattern_count", 0),
        ("Repetition ratio", "repetition_ratio", 3),
        ("Pattern entropy (bits)", "pattern_entropy", 3),
        ("Starting pattern repetition", "starting_pattern_repetition_rate", 3),
        ("Ending pattern repetition", "ending_pattern_repetition_rate", 3),
    ]:
        field("Prosody", metric, patterns, attr, nd, integer=nd == 0)

    # -- Cohesion -----------------------------------------------------------
    c = results.get("cohesion")
    for metric, attr, nd in [
        ("Pronoun density (per 100 words)", "pronoun_density", 2),
        ("Demonstrative density (per 100 words)", "demonstrative_density", 2),
        ("Anaphora count", "anaphora_count", 0),
        ("Anaphora resolution ratio", "anaphora_resolution_ratio", 4),
        ("Word repetition ratio", "word_repetition_ratio", 4),
        ("Content word overlap", "content_word_overlap", 4),
        ("Connective density (per 100 words)", "connective_density", 2),
        ("Additive connective ratio", "additive_connective_ratio", 4),
        ("Adversative connective ratio", "adversative_connective_ratio", 4),
        ("Causal connective ratio", "causal_connective_ratio", 4),
        ("Temporal connective ratio", "temporal_connective_ratio", 4),
        ("Adjacent sentence overlap", "adjacent_sentence_overlap", 4),
        ("Mean sentence similarity", "mean_sentence_similarity", 4),
        ("Paragraph topic consistency", "paragraph_topic_consistency", 4),
        ("Semantic coherence score", "semantic_coherence_score", 4),
        ("Discourse structure score", "discourse_structure_score", 4),
        ("Paragraph count", "paragraph_count", 0),
        ("Mean paragraph length (sentences)", "mean_paragraph_length", 2),
    ]:
        field("Cohesion", metric, c, attr, nd, integer=nd == 0)

    # -- Extras -------------------------------------------------------------
    bnc = results.get("bnc")
    field("Extras", "BNC total tokens", bnc, "total_tokens", integer=True)
    field("Extras", "BNC unique tokens", bnc, "unique_tokens", integer=True)
    if bnc is not None:
        add("Extras", "BNC overused words", len(bnc.overused))
        add("Extras", "BNC underused words", len(bnc.underused))
        add("Extras", "Words not in BNC", len(bnc.not_in_bnc))
        if bnc.overused:
            top = bnc.overused[0]
            add("Extras", "Most overused word", f"{top.word} ({top.ratio:,.0f}x expected)")

    uni = results.get("rep_uni")
    for metric, attr, nd in [
        ("Slop score", "slop_score", 4),
        ("Flagged repetitive words", "flagged_count", 0),
        ("Flagged words per 10,000", "flagged_words_per_10k", 2),
        ("Mean repetition score", "mean_repetition_score", 4),
        ("Content words", "total_content_words", 0),
    ]:
        field("Extras", metric, uni, attr, nd, integer=nd == 0)

    ng = results.get("rep_ng")
    field("Extras", "Flagged repeated n-grams", ng, "flagged_count", integer=True)
    field("Extras", "Flagged n-grams per 10,000", ng, "flagged_per_10k", 2)
    field("Extras", "Repeated n-gram candidates", ng, "total_ngrams", integer=True)

    if not rows:
        return "_No metrics were computed._\n"

    table = Table("Category", "Metric", "Value")
    table.rows_from(rows)
    if expanded:
        note = (
            "The findings for each category follow, in the same order as the categories "
            "here. Use `--with-detail` to expand each category into its own metric tables."
        )
    else:
        note = "This is the whole report in one table."
    return (
        para(f"Every metric computed for this text, in one table ({len(rows)} rows). {note}")
        + "\n"
        + table.render()
    )


def render_lexical(results: dict[str, Any], top_n: int) -> str:
    out: list[str] = []

    if (ttr := results.get("ttr")) is not None:
        out.append(heading(3, "Type-Token Ratio (TTR)"))
        out.append(para(
            "The type-token ratio compares unique words (types) to total words (tokens). "
            "Raw TTR falls as a text gets longer, so the normalised variants are the ones to "
            "compare across texts."
        ))
        table = Table("Metric", "Value", "Description")
        table.row("**Raw TTR**", fnum(ttr.ttr), "Direct ratio of types to tokens")
        table.row("**Root TTR (Guiraud's Index)**", fnum(ttr.root_ttr), "Types / sqrt(tokens)")
        table.row("**Log TTR (Herdan's C)**", fnum(ttr.log_ttr), "log(types) / log(tokens)")
        table.row("**STTR (Standardized)**", fnum(ttr.sttr), "Mean TTR across fixed-size chunks")
        table.row("**Delta Std**", fnum(ttr.delta_std), "Chunk-to-chunk vocabulary consistency")
        table.row("**Total Types**", fnum(ttr.unique_words, 0), "Unique words")
        table.row("**Total Tokens**", fnum(ttr.total_words, 0), "Total words")
        table.row("**Chunks**", f"{ttr.chunk_count:,} x {ttr.chunk_size:,} words", "Analysis windows")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_ttr(ttr)}"))

    if (mtld := results.get("mtld")) is not None:
        out.append(heading(3, "MTLD (Measure of Textual Lexical Diversity)"))
        table = Table("Metric", "Value")
        table.row("**MTLD Forward**", fnum(mtld.mtld_forward, 2))
        table.row("**MTLD Backward**", fnum(mtld.mtld_backward, 2))
        table.row("**MTLD Average**", fnum(mtld.mtld_average, 2))
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_mtld(mtld)}"))

    if (yule := results.get("yule")) is not None:
        out.append(heading(3, "Yule's K and I"))
        out.append(para(
            "Both are derived from the word-frequency distribution rather than from a running "
            "word count, which makes them more stable for long texts."
        ))
        table = Table("Metric", "Value", "Description")
        table.row("**Yule's K**", fnum(yule.yule_k), "Higher = more repetitive vocabulary")
        table.row("**Yule's I**", fnum(yule.yule_i), "Characteristic constant of the vocabulary")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_yule(yule)}"))

    if (hapax := results.get("hapax")) is not None:
        out.append(heading(3, "Hapax Legomena"))
        out.append(para(
            "Hapax legomena are words appearing exactly once, dislegomena exactly twice. "
            "The library computes these per chunk and sums them, so they describe within-chunk "
            "rarity rather than whole-document rarity."
        ))
        table = Table("Metric", "Value", "Description")
        table.row("**Hapax Legomena Count**", fnum(hapax.hapax_count, 0), "Summed over chunks")
        table.row("**Hapax Ratio**", fnum(hapax.hapax_ratio), "Mean ratio across chunks")
        table.row("**Hapax Dislegomena Count**", fnum(hapax.dis_hapax_count, 0), "Summed over chunks")
        table.row("**Hapax Dislegomena Ratio**", fnum(hapax.dis_hapax_ratio), "Mean ratio across chunks")
        table.row("**Sichel's S**", fnum(hapax.sichel_s), "Dislegomena / types")
        table.row("**Honore's R**", fnum(hapax.honore_r, 2), "Vocabulary richness statistic")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_hapax(hapax)}"))

    if (fw := results.get("function_words")) is not None:
        out.append(heading(3, "Function Word Analysis"))
        out.append(para(
            "Function words (determiners, prepositions, pronouns, auxiliaries) carry little "
            "meaning but a great deal of authorial signal."
        ))
        table = Table("Category", "Ratio", "Share", "Description")
        table.row("**Total Function Word Ratio**", fnum(fw.total_function_word_ratio), fpct(fw.total_function_word_ratio), "Share of tokens in function-word classes")
        table.row("**Function Word Diversity**", fnum(fw.function_word_diversity), "", "Unique function words / total function words")
        table.row("**Determiner Ratio**", fnum(fw.determiner_ratio), fpct(fw.determiner_ratio), "the, a, an, this, ...")
        table.row("**Preposition Ratio**", fnum(fw.preposition_ratio), fpct(fw.preposition_ratio), "in, on, at, by, ...")
        table.row("**Conjunction Ratio**", fnum(fw.conjunction_ratio), fpct(fw.conjunction_ratio), "and, but, or, ...")
        table.row("**Pronoun Ratio**", fnum(fw.pronoun_ratio), fpct(fw.pronoun_ratio), "I, he, she, it, ...")
        table.row("**Auxiliary Ratio**", fnum(fw.auxiliary_ratio), fpct(fw.auxiliary_ratio), "be, have, do, will, ...")
        table.row("**Particle Ratio**", fnum(fw.particle_ratio), fpct(fw.particle_ratio), "up, down, out, ...")
        out.append(table.render())

        frequent = list(fw.most_frequent_function_words)[:top_n]
        if frequent:
            out.append(para(f"**Top {len(frequent)} function words:**"))
            table = Table("Rank", "Word", "Count")
            table.rows_from([(i, ftext(word), fnum(count, 0)) for i, (word, count) in enumerate(frequent, 1)])
            out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_function_words(fw)}"))

    advanced = [k for k in ("vocd_d", "mattr", "hdd", "msttr") if k in results]
    if advanced:
        out.append(heading(3, "Advanced Lexical Diversity"))
        if (vocd := results.get("vocd_d")) is not None:
            out.append(heading(4, "VocD (Vocabulary Diversity)"))
            table = Table("Metric", "Value")
            table.row("**D Parameter**", fnum(vocd.d_parameter, 2))
            table.row("**Curve Fit R-squared**", fnum(vocd.curve_fit_r_squared, 4))
            table.row("**Sample Count**", fnum(vocd.sample_count, 0))
            table.row("**Optimal Sample Size**", fnum(vocd.optimal_sample_size, 0))
            out.append(table.render())
            if isinstance(vocd.curve_fit_r_squared, float) and vocd.curve_fit_r_squared < 0:
                out.append(para(
                    f"**Interpretation:** the curve fit R-squared is negative "
                    f"({vocd.curve_fit_r_squared:.4f}), which means the theoretical sampling curve "
                    f"is a worse description of this text than a flat line. Disregard the D "
                    f"parameter of {vocd.d_parameter:.2f} here; vocd-D is calibrated for samples "
                    f"far smaller than this text."
                ))
            elif isinstance(vocd.curve_fit_r_squared, float) and vocd.curve_fit_r_squared < 0.9:
                out.append(para(
                    f"**Interpretation:** the curve fit R-squared of "
                    f"{vocd.curve_fit_r_squared:.4f} is low, so treat the D parameter as "
                    f"indicative only — the theoretical sampling curve does not describe this "
                    f"text well. This is common for very long texts, where the curve is fitted "
                    f"over samples far smaller than the text itself."
                ))
            else:
                out.append(para(
                    f"**Interpretation:** D of {vocd.d_parameter:.2f} is the diversity parameter "
                    f"that best reproduces the observed type-token curve; higher means richer."
                ))

        if (mattr := results.get("mattr")) is not None:
            out.append(heading(4, "MATTR (Moving-Average Type-Token Ratio)"))
            table = Table("Metric", "Value")
            table.row("**MATTR Score**", fnum(mattr.mattr_score))
            table.row("**MATTR Std Dev**", fnum(mattr.ttr_std_dev))
            table.row("**Window Size**", fnum(mattr.window_size, 0))
            table.row("**Window Count**", fnum(mattr.window_count, 0))
            table.row("**Min TTR**", fnum(mattr.min_ttr, 2))
            table.row("**Max TTR**", fnum(mattr.max_ttr, 2))
            out.append(table.render())
            out.append(para(f"**Interpretation:** {interp_mattr(mattr)}"))

        if (hdd := results.get("hdd")) is not None:
            out.append(heading(4, "HD-D (Hypergeometric Distribution D)"))
            table = Table("Metric", "Value")
            table.row("**HD-D Score**", fnum(hdd.hdd_score, 2))
            table.row("**Sample Size**", fnum(hdd.sample_size, 0))
            table.row("**Type Count**", fnum(hdd.type_count, 0))
            table.row("**Token Count**", fnum(hdd.token_count, 0))
            out.append(table.render())

        if (msttr := results.get("msttr")) is not None:
            out.append(heading(4, "MSTTR (Mean Segmental Type-Token Ratio)"))
            table = Table("Metric", "Value")
            table.row("**MSTTR Score**", fnum(msttr.msttr_score))
            table.row("**MSTTR Std Dev**", fnum(msttr.ttr_std_dev))
            table.row("**Segment Size**", f"{msttr.segment_size:,} words")
            table.row("**Segment Count**", fnum(msttr.segment_count, 0))
            table.row("**Min TTR**", fnum(msttr.min_ttr, 2))
            table.row("**Max TTR**", fnum(msttr.max_ttr, 2))
            out.append(table.render())
            out.append(para(f"**Interpretation:** {interp_msttr(msttr)}"))

    if (fs := results.get("freq_soph")) is not None:
        out.append(heading(3, "Word Frequency Sophistication"))
        out.append(para(
            "Ranks every token against a reference frequency corpus. Because the long tail "
            "contains many words the corpus has never seen, the median matters more than the mean."
        ))
        table = Table("Metric", "Value", "Description")
        table.row("**Mean Frequency Rank**", fnum(fs.mean_frequency_rank, 2), "Average rank, tail-sensitive")
        table.row("**Median Frequency Rank**", fnum(fs.median_frequency_rank, 2), "Middle rank, robust")
        table.row("**Rare Word Ratio**", fnum(fs.rare_word_ratio), "Low-frequency words")
        table.row("**Common Word Ratio**", fnum(fs.common_word_ratio), "High-frequency words")
        table.row("**Academic Word Ratio**", fnum(fs.academic_word_ratio), "Academic Word List terms")
        table.row("**Advanced Word Ratio**", fnum(fs.advanced_word_ratio), "Sophisticated vocabulary")
        out.append(table.render())

        if fs.frequency_band_distribution:
            out.append(para("**Frequency band distribution:**"))
            table = Table("Band", "Ratio")
            for band, ratio in fs.frequency_band_distribution.items():
                table.row(band.replace("_", " ").title(), fnum(ratio))
            out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_freq_soph(fs)}"))

    if (wc := results.get("word_class")) is not None:
        out.append(heading(3, "Word Class Distribution"))
        plain_entry = next((c for c in wc.classifications if c.label == "lexical"), None)
        interesting = [c for c in wc.classifications if c.label != "lexical"]
        if plain_entry is not None:
            plain_share = fpct(plain_entry.percentage / 100 if plain_entry.percentage else 0)
            plain_detail = (
                f"{fwords(plain_entry.count, 'token')}, {fwords(plain_entry.unique, 'type')}"
            )
        else:
            plain_share = "0.0%"
            plain_detail = "none"
        out.append(para(
            f"This classifier resolves the surface forms that ordinary word counts mishandle: "
            f"contractions, possessives, hyphenated compounds, elisions, numerals, and "
            f"non-ASCII tokens. Of {fwords(wc.total_words, 'token')}, {plain_share} are plain "
            f"lexical words ({plain_detail}) and the rest fall into {len(interesting)} "
            f"morphological classes, listed below. Percentages sum to {wc.percentage_sum:.4f}%."
        ))
        if interesting:
            ranked = sorted(interesting, key=lambda c: -c.count)[:top_n]
            table = Table("Class", "Count", "Unique", "Share", "Max run")
            for entry in ranked:
                stats = entry.run_stats
                table.row(
                    ftext(entry.label),
                    fnum(entry.count, 0),
                    fnum(entry.unique, 0),
                    fpct(entry.percentage / 100 if entry.percentage else 0),
                    fnum(stats.max, 0) if stats else "n/a",
                )
            out.append(table.render())
            run_max = max((e.run_stats.max for e in interesting if e.run_stats), default=0)
            out.append(para(
                f"**Interpretation:** the longest run of consecutive tokens in a single non-lexical "
                f"class is {run_max}. Long runs are unusual and usually mean a quoted block, a "
                f"list, or a stretch of dialogue rather than ordinary prose. The contraction and "
                f"possessive classes are the ones worth tracking across an author's texts: they "
                f"are stable habits, and they are exactly the forms a corpus tagger splits and "
                f"therefore fails to count."
            ))
        else:
            out.append(para("_No non-lexical surface forms detected._"))

    return "\n".join(out)


def render_readability(results: dict[str, Any]) -> str:
    out: list[str] = []
    out.append(para(
        "Grade-level formulas estimate reading difficulty. They disagree with each other by "
        "design: some count syllables, some count characters, some count words on a "
        "memorised familiar-word list."
    ))

    if (flesch := results.get("flesch")) is not None:
        out.append(heading(3, "Flesch Reading Ease"))
        table = Table("Metric", "Value")
        table.row("**Reading Ease Score**", fnum(flesch.reading_ease, 2))
        table.row("**Grade Level (Flesch-Kincaid)**", fnum(flesch.grade_level, 2))
        table.row("**Difficulty**", flesch.difficulty)
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_flesch(flesch)}"))

    if (smog := results.get("smog")) is not None:
        out.append(heading(3, "SMOG Index"))
        table = Table("Metric", "Value")
        table.row("**SMOG Index**", fnum(smog.smog_index, 2))
        table.row("**Grade Level**", fgrade(smog.grade_level))
        out.append(table.render())
        out.append(para(
            "**Interpretation:** SMOG counts polysyllabic words and is calibrated on health "
            "communication, so it is conservative — it typically reads a grade or two above "
            "Flesch on the same text."
        ))

    if (fog := results.get("gunning_fog")) is not None:
        out.append(heading(3, "Gunning Fog Index"))
        table = Table("Metric", "Value")
        table.row("**Fog Index**", fnum(fog.fog_index, 2))
        table.row("**Grade Level**", fgrade(fog.grade_level))
        out.append(table.render())
        out.append(para(
            "**Interpretation:** the Fog index combines sentence length with the share of "
            "words of three syllables or more. It is the formula most sensitive to long "
            "Latinate vocabulary."
        ))

    if (cli := results.get("coleman_liau")) is not None:
        out.append(heading(3, "Coleman-Liau Index"))
        table = Table("Metric", "Value")
        table.row("**CLI Index**", fnum(cli.cli_index, 2))
        table.row("**Grade Level**", fgrade(cli.grade_level))
        out.append(table.render())
        out.append(para(
            "**Interpretation:** Coleman-Liau uses characters rather than syllables, so it is "
            "the one formula here that is insensitive to pronunciation and syllable counting "
            "choices."
        ))

    if (ari := results.get("ari")) is not None:
        out.append(heading(3, "Automated Readability Index (ARI)"))
        table = Table("Metric", "Value")
        table.row("**ARI Score**", fnum(ari.ari_score, 2))
        table.row("**Grade Level**", fgrade(ari.grade_level))
        table.row("**Age Range**", ari.age_range)
        out.append(table.render())

    if (dale := results.get("dale_chall")) is not None:
        out.append(heading(3, "Dale-Chall Readability Score"))
        table = Table("Metric", "Value")
        table.row("**Dale-Chall Score**", fnum(dale.dale_chall_score, 2))
        table.row("**Difficult Word Count**", fnum(dale.difficult_word_count, 0))
        table.row("**Difficult Word Ratio**", fnum(dale.difficult_word_ratio))
        table.row("**Grade Level**", fgrade(dale.grade_level))
        out.append(table.render())
        out.append(para(
            f"**Interpretation:** {fpct(dale.difficult_word_ratio)} of words are absent from "
            f"the Dale-Chall list of words familiar to fourth-grade readers. This formula is "
            f"less sensitive to sentence length than the others and more sensitive to everyday "
            f"vocabulary."
        ))

    if (linsear := results.get("linsear")) is not None:
        out.append(heading(3, "Linsear Write Formula"))
        table = Table("Metric", "Value")
        table.row("**Linsear Write Score**", fnum(linsear.linsear_score, 2))
        table.row("**Grade Level**", fgrade(linsear.grade_level))
        table.row("**Easy Words**", fnum(linsear.easy_word_count, 0))
        table.row("**Hard Words**", fnum(linsear.hard_word_count, 0))
        out.append(table.render())

    if (fry := results.get("fry")) is not None:
        out.append(heading(3, "Fry Readability Graph"))
        table = Table("Metric", "Value")
        table.row("**Fry Grade Level**", fgrade(fry.grade_level))
        table.row("**Avg Sentence Length**", f"{fry.avg_sentence_length:.2f} words")
        table.row("**Avg Syllables per 100 Words**", f"{fry.avg_syllables_per_100:.2f}")
        table.row("**Graph Zone**", fry.graph_zone)
        out.append(table.render())

    if (forcast := results.get("forcast")) is not None:
        out.append(heading(3, "FORCAST Index"))
        table = Table("Metric", "Value")
        table.row("**FORCAST Score**", fnum(forcast.forcast_score, 2))
        table.row("**Grade Level**", fgrade(forcast.grade_level))
        table.row("**Single Syllable Ratio**", fnum(forcast.single_syllable_ratio))
        out.append(table.render())
        out.append(para(
            "**Interpretation:** FORCAST ignores sentence length entirely and uses only the "
            "share of monosyllabic words. It is the formula of choice for text where sentence "
            "boundaries are unreliable."
        ))

    if (psk := results.get("psk")) is not None:
        out.append(heading(3, "Powers-Sumner-Kearl Readability"))
        table = Table("Metric", "Value")
        table.row("**PSK Score**", fnum(psk.psk_score, 2))
        table.row("**Grade Level**", fgrade(psk.grade_level))
        table.row("**Avg Sentence Length**", f"{psk.avg_sentence_length:.2f} words")
        table.row("**Avg Syllables per Word**", f"{psk.avg_syllables_per_word:.2f}")
        out.append(table.render())
        if psk.grade_level < 1:
            out.append(para(
                "**Note:** a negative score means the text falls below the primary-grade range "
                "this formula was designed for, so the number should be read as 'very easy' "
                "rather than as a meaningful grade."
            ))

    # -- Summary table ------------------------------------------------------
    grades: dict[str, float] = {}
    for key, label in [
        ("flesch", "Flesch-Kincaid"),
        ("smog", "SMOG"),
        ("gunning_fog", "Gunning Fog"),
        ("coleman_liau", "Coleman-Liau"),
        ("ari", "ARI"),
        ("dale_chall", "Dale-Chall"),
        ("linsear", "Linsear Write"),
        ("fry", "Fry"),
        ("forcast", "FORCAST"),
    ]:
        result = results.get(key)
        if result is None:
            continue
        value = getattr(result, "grade_level", None)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if isinstance(value, float) and math.isnan(value):
                continue
            grades[label] = float(value)

    if grades:
        out.append(heading(3, "Readability Summary"))
        table = Table("Formula", "Grade Level")
        for label, value in grades.items():
            table.row(label, f"{value:.1f}")
        average = sum(grades.values()) / len(grades)
        table.row("**Average**", f"**{average:.1f}**")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_readability_summary(grades, average)}"))

    return "\n".join(out)


def render_syntactic(results: dict[str, Any]) -> str:
    out: list[str] = []

    if (pos := results.get("pos")) is not None:
        out.append(heading(3, "Part-of-Speech Ratios"))
        table = Table("POS Category", "Ratio", "Description")
        table.row("**Noun Ratio**", fnum(pos.noun_ratio), "Nouns / all POS-tagged tokens")
        table.row("**Verb Ratio**", fnum(pos.verb_ratio), "Verbs / all POS-tagged tokens")
        table.row("**Adjective Ratio**", fnum(pos.adjective_ratio), "Adjectives / all tokens")
        table.row("**Adverb Ratio**", fnum(pos.adverb_ratio), "Adverbs / all tokens")
        table.row("**Noun-Verb Ratio**", fnum(pos.noun_verb_ratio), "Above 1 means a nominal style")
        table.row("**Adjective-Noun Ratio**", fnum(pos.adjective_noun_ratio), "Modification density")
        table.row("**Lexical Density**", fnum(pos.lexical_density), "Content words / all tokens")
        table.row("**Function Word Ratio**", fnum(pos.function_word_ratio), "Function words / all tokens")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_pos(pos)}"))

    if (stats := results.get("sentence_stats")) is not None:
        out.append(heading(3, "Sentence Statistics"))
        table = Table("Metric", "Value")
        table.row("**Sentence Count**", fnum(stats.sentence_count, 0))
        table.row("**Mean Sentence Length**", f"{stats.mean_sentence_length:.2f} words")
        table.row("**Sentence Length Std Dev**", f"{stats.sentence_length_std:.2f} words")
        table.row("**Sentence Length Range**", fwords(stats.sentence_length_range))
        table.row("**Min Sentence Length**", fwords(stats.min_sentence_length))
        table.row("**Max Sentence Length**", fwords(stats.max_sentence_length))
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_sentence_stats(stats)}"))

    if (adv := results.get("advanced")) is not None:
        out.append(heading(3, "Advanced Syntactic Analysis"))
        out.append(para(
            "These metrics come from dependency parsing: how deeply sentences nest, how many "
            "clauses they carry, and where modifiers attach relative to their heads."
        ))
        table = Table("Metric", "Value", "Description")
        table.row("**Mean Parse Tree Depth**", fnum(adv.mean_parse_tree_depth, 2), "Average syntactic nesting")
        table.row("**Max Parse Tree Depth**", fnum(adv.max_parse_tree_depth, 2), "Deepest structure")
        table.row("**T-Unit Count**", fnum(adv.t_unit_count, 0), "Minimal terminable units")
        table.row("**Mean T-Unit Length**", fnum(adv.mean_t_unit_length, 2), "Words per T-unit")
        table.row("**Clausal Density**", fnum(adv.clausal_density), "Clauses per T-unit")
        table.row("**Dependent Clause Ratio**", fnum(adv.dependent_clause_ratio), "Share of clauses that are dependent")
        table.row("**Subordination Index**", fnum(adv.subordination_index), "Subordination degree")
        table.row("**Coordination Index**", fnum(adv.coordination_index), "Coordination degree")
        table.row("**Passive Voice Ratio**", fnum(adv.passive_voice_ratio), "Share of passive constructions")
        table.row("**Sentence Complexity Score**", fnum(adv.sentence_complexity_score), "Composite complexity")
        table.row("**Dependency Distance**", fnum(adv.dependency_distance), "Mean head-to-dependent distance")
        table.row("**Left Branching Ratio**", fnum(adv.left_branching_ratio), "Modifiers before the head")
        table.row("**Right Branching Ratio**", fnum(adv.right_branching_ratio), "Modifiers after the head")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_advanced(adv)}"))

    if (types := results.get("sentence_types")) is not None:
        out.append(heading(3, "Sentence Type Classification"))

        def count_for(name: str) -> str:
            value = getattr(types, f"{name}_count", None)
            return fnum(value, 0) if value is not None else "n/a"

        out.append(heading(4, "Structural Types"))
        table = Table("Type", "Ratio", "Count", "Description")
        table.row("**Simple**", fnum(types.simple_ratio), count_for("simple"), "One independent clause")
        table.row("**Compound**", fnum(types.compound_ratio), count_for("compound"), "Multiple independent clauses")
        table.row("**Complex**", fnum(types.complex_ratio), count_for("complex"), "Independent + dependent clauses")
        table.row("**Compound-Complex**", fnum(types.compound_complex_ratio), count_for("compound_complex"), "Multiple independent + dependent")
        out.append(table.render())

        out.append(heading(4, "Functional Types"))
        table = Table("Type", "Ratio", "Count", "Description")
        table.row("**Declarative**", fnum(types.declarative_ratio), count_for("declarative"), "Statements")
        table.row("**Interrogative**", fnum(types.interrogative_ratio), count_for("interrogative"), "Questions")
        table.row("**Exclamatory**", fnum(types.exclamatory_ratio), count_for("exclamatory"), "Exclamations")
        table.row("**Imperative**", fnum(types.imperative_ratio), count_for("imperative"), "Commands")
        out.append(table.render())

        out.append(heading(4, "Diversity Metrics"))
        table = Table("Metric", "Value", "Description")
        table.row("**Structural Diversity**", fnum(types.structural_diversity), "Shannon entropy of structure types")
        table.row("**Functional Diversity**", fnum(types.functional_diversity), "Shannon entropy of function types")
        table.row("**Total Sentences**", fnum(types.total_sentences, 0), "Sentences classified")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_sentence_types(types)}"))

    return "\n".join(out)


def render_character(results: dict[str, Any], top_n: int) -> str:
    chars = results.get("character")
    if chars is None:
        return ""
    out = [heading(3, "Basic Character Metrics")]
    table = Table("Metric", "Value", "Description")
    table.row("**Average Word Length**", f"{chars.avg_word_length:.2f} characters", "Mean word length")
    table.row("**Average Sentence Length**", f"{chars.avg_sentence_length_chars:.2f} characters", "Mean sentence length")
    table.row("**Punctuation Density**", fnum(chars.punctuation_density, 2), "Punctuation per 100 words")
    table.row("**Punctuation Variety**", fnum(chars.punctuation_variety, 0), "Unique punctuation marks")
    table.row("**Vowel-Consonant Ratio**", fnum(chars.vowel_consonant_ratio), "Vowels / consonants")
    table.row("**Digit Count**", fnum(chars.digit_count, 0), "Numeric characters")
    table.row("**Digit Ratio**", fnum(chars.digit_ratio, 6), "Digits / total characters")
    table.row("**Uppercase Ratio**", fnum(chars.uppercase_ratio), "Uppercase / total letters")
    table.row("**Whitespace Ratio**", fnum(chars.whitespace_ratio), "Whitespace / total characters")
    out.append(table.render())

    if chars.letter_frequency:
        ranked = sorted(chars.letter_frequency.items(), key=lambda kv: -kv[1])[:top_n]
        out.append(heading(3, "Letter Frequency Distribution"))
        table = Table("Rank", "Letter", "Frequency")
        table.rows_from([(i, letter, fnum(freq)) for i, (letter, freq) in enumerate(ranked, 1)])
        out.append(table.render())
    out.append(para(f"**Interpretation:** {interp_character(chars)}"))
    return "\n".join(out)


def _clean_ngrams(entries: Any, top_n: int, visible: bool = False) -> list[tuple[str, int]]:
    """Drop whitespace-only n-grams, which dominate character n-gram tables."""
    cleaned: list[tuple[str, int]] = []
    for entry in entries or []:
        if isinstance(entry, (list, tuple)) and len(entry) == 2:
            gram, count = entry
        else:
            continue
        display = ftext(gram, visible=visible)
        if not display or display == "\u2423":
            continue
        cleaned.append((display, count))
        if len(cleaned) >= top_n:
            break
    return cleaned


def render_ngrams(results: dict[str, Any], top_n: int) -> str:
    out: list[str] = []
    char_bi = results.get("char_bigram")
    word_bi = results.get("word_bigram")

    if char_bi is not None:
        out.append(heading(3, "Character Bigram Entropy"))
        table = Table("Metric", "Value", "Description")
        table.row("**Entropy**", f"{char_bi.entropy:.4f} bits", "Information per bigram")
        table.row("**Perplexity**", fnum(char_bi.perplexity, 4), "Prediction difficulty")
        table.row("**N-gram Type**", char_bi.ngram_type, "Unit counted")
        out.append(table.render())

    if word_bi is not None:
        out.append(heading(3, "Word Bigram Entropy"))
        table = Table("Metric", "Value", "Description")
        table.row("**Entropy**", f"{word_bi.entropy:.4f} bits", "Information per bigram")
        table.row("**Perplexity**", fnum(word_bi.perplexity, 2), "Prediction difficulty")
        table.row("**N-gram Type**", word_bi.ngram_type, "Unit counted")
        out.append(table.render())

    if char_bi is not None and word_bi is not None:
        out.append(para(f"**Interpretation:** {interp_entropy(char_bi, word_bi)}"))

    ext = results.get("extended_ngrams")
    if ext is not None:
        out.append(heading(3, "Extended N-grams"))

        def gram_table(title: str, entries: Any, count_label: str, count: Any, visible: bool = False) -> None:
            rows = _clean_ngrams(entries, top_n, visible=visible)
            if not rows:
                return
            of_total = f" (of {fnum(count, 0)} distinct)" if count is not None else ""
            out.append(para(f"**Top {len(rows)} {title}**{of_total}:"))
            table = Table(title.title(), count_label)
            table.rows_from(rows)
            out.append(table.render())

        gram_table("word trigrams", ext.top_word_trigrams, "Count", ext.word_trigram_count)
        gram_table("word 4-grams", ext.top_word_4grams, "Count", ext.word_4gram_count)
        gram_table("2-skipgrams (gap of 1)", ext.top_skipgrams_2_1, "Count", ext.skipgram_2_1_count)
        gram_table("3-skipgrams (gap of 1)", ext.top_skipgrams_3_1, "Count", ext.skipgram_3_1_count)
        gram_table("character trigrams", ext.top_char_trigrams, "Count", None, visible=True)
        gram_table("character 4-grams", ext.top_char_4grams, "Count", None, visible=True)
        out.append(para(
            f"_In the character tables, `\u2423` marks a space, so that n-grams differing only "
            f"in whitespace stay distinguishable._"
        ))

        out.append(para("**N-gram diversity and entropy:**"))
        table = Table("Metric", "Value")
        table.row("Word trigram entropy", f"{ext.word_trigram_entropy:.4f} bits")
        table.row("Word 4-gram entropy", f"{ext.word_4gram_entropy:.4f} bits")
        table.row("Character trigram entropy", f"{ext.char_trigram_entropy:.4f} bits")
        table.row("Character 4-gram entropy", f"{ext.char_4gram_entropy:.4f} bits")
        if ext.pos_trigram_count:
            table.row("POS trigram entropy", f"{ext.pos_trigram_entropy:.4f} bits")
        out.append(table.render())

        if ext.top_word_trigrams:
            top = _clean_ngrams(ext.top_word_trigrams, 1)
            if top:
                gram, count = top[0]
                out.append(para(
                    f"**Interpretation:** the most repeated word trigram is \"{gram}\" at "
                    f"{fnum(count, 0)} occurrences. Repeated trigrams are the fingerprint of "
                    f"formulaic phrasing: stock descriptions, habitual connectives, and set "
                    f"scene-setting. A low count at the top of this table means the text rarely "
                    f"reuses the same three-word sequence. Skipgrams expose looser versions of "
                    f"the same habits, where a fixed collocation tolerates anything in the "
                    f"middle slot."
                ))

    return "\n".join(out)


def render_markers(results: dict[str, Any], top_n: int, text: str) -> str:
    m = results.get("markers")
    if m is None:
        return ""
    out: list[str] = []

    out.append(heading(3, "Contraction Use"))
    table = Table("Metric", "Value", "Description")
    table.row("**Contraction Ratio**", fnum(m.contraction_ratio), "Contractions / (contractions + full forms)")
    table.row("**Contraction Count**", fnum(m.contraction_count, 0), "Total contractions")
    table.row("**Expanded Form Count**", fnum(m.expanded_form_count, 0), "Full forms where a contraction was possible")
    out.append(table.render())
    if m.top_contractions:
        table = Table("Contraction", "Count")
        table.rows_from([(ftext(word), fnum(count, 0)) for word, count in m.top_contractions[:top_n]])
        out.append(table.render())

    out.append(heading(3, "Intensifiers and Hedges"))
    table = Table("Metric", "Value", "Description")
    table.row("**Intensifier Density**", f"{m.intensifier_density:.2f}", "Intensifiers per 100 words")
    table.row("**Intensifier Count**", fnum(m.intensifier_count, 0), "Total intensifiers")
    table.row("**Hedging Density**", f"{m.hedging_density:.2f}", "Hedges per 100 words")
    table.row("**Hedging Count**", fnum(m.hedging_count, 0), "Total hedges")
    out.append(table.render())
    for label, entries in (("Intensifier", m.top_intensifiers), ("Hedge", m.top_hedges)):
        if entries:
            table = Table(label, "Count")
            table.rows_from([(ftext(word), fnum(count, 0)) for word, count in entries[:top_n]])
            out.append(table.render())

    out.append(heading(3, "Modal Auxiliaries and Negation"))
    table = Table("Metric", "Value")
    table.row("**Modal Density**", f"{m.modal_density:.2f} per 100 words")
    table.row("**Epistemic Modal Ratio**", fnum(m.epistemic_modal_ratio))
    table.row("**Deontic Modal Ratio**", fnum(m.deontic_modal_ratio))
    table.row("**Negation Density**", f"{m.negation_density:.2f} per 100 words")
    table.row("**Negation Count**", fnum(m.negation_count, 0))
    out.append(table.render())
    if m.modal_distribution:
        table = Table("Modal", "Count")
        table.rows_from(
            [(ftext(w), fnum(c, 0)) for w, c in sorted(m.modal_distribution.items(), key=lambda kv: -kv[1])]
        )
        out.append(table.render())
    if m.negation_types:
        table = Table("Negation", "Count")
        table.rows_from(
            [(ftext(w), fnum(c, 0)) for w, c in sorted(m.negation_types.items(), key=lambda kv: -kv[1])]
        )
        out.append(table.render())

    out.append(heading(3, "Punctuation Style"))
    table = Table("Mark", "Per 100 words")
    table.row("Exclamation marks", fnum(m.exclamation_density, 2))
    table.row("Question marks", fnum(m.question_density, 2))
    table.row("Quotation marks", fnum(m.quotation_density, 2))
    table.row("Parentheses", fnum(m.parenthetical_density, 2))
    table.row("Ellipses", fnum(m.ellipsis_density, 2))
    table.row("Dashes (em/en)", fnum(m.dash_density, 2))
    table.row("Semicolons", fnum(m.semicolon_density, 2))
    table.row("Colons", fnum(m.colon_density, 2))
    out.append(table.render())
    out.append(para(f"**Interpretation:** {interp_markers(m, has_typographic_quotes(text))}"))
    return "\n".join(out)


def render_genre(results: dict[str, Any], text: str = "") -> str:
    g = results.get("genre")
    if g is None:
        return ""
    out = [para(
        "Register is a rough formality band; genre is the classifier's best single guess. "
        "The per-genre scores underneath show how close the runner-up was."
    )]
    table = Table("Metric", "Value")
    table.row("**Register Classification**", g.register_classification)
    table.row("**Predicted Genre**", g.predicted_genre)
    table.row("**Genre Confidence**", fnum(g.genre_confidence))
    table.row("**Formality Score**", fnum(g.formality_score, 2))
    table.row("**Latinate Ratio**", fnum(g.latinate_ratio))
    table.row("**Nominalization Density**", fnum(g.nominalization_density, 2))
    table.row("**Passive Voice Density**", fnum(g.passive_voice_density, 2))
    table.row("**First Person Ratio**", fnum(g.first_person_ratio))
    table.row("**Second Person Ratio**", fnum(g.second_person_ratio))
    table.row("**Third Person Ratio**", fnum(g.third_person_ratio))
    table.row("**Impersonal Constructions**", fnum(g.impersonal_construction_density, 2))
    table.row("**Abstract Noun Ratio**", fnum(g.abstract_noun_ratio))
    table.row("**Concrete Noun Ratio**", fnum(g.concrete_noun_ratio))
    table.row("**Abstractness Score**", fnum(g.abstractness_score))
    table.row("**Technical Term Density**", fnum(g.technical_term_density, 2))
    table.row("**Narrative Marker Density**", fnum(g.narrative_marker_density, 2))
    table.row("**Expository Marker Density**", fnum(g.expository_marker_density, 2))
    table.row("**Dialogue Ratio**", fnum(g.dialogue_ratio))
    out.append(table.render())

    out.append(para("**Genre scores (0-1):**"))
    table = Table("Genre", "Score")
    for label, value in [
        ("Academic", g.academic_score),
        ("Journalistic", g.journalistic_score),
        ("Fiction", g.fiction_score),
        ("Legal", g.legal_score),
        ("Conversational", g.conversational_score),
    ]:
        table.row(label, fnum(value))
    out.append(table.render())
    if has_typographic_quotes(text) and g.dialogue_ratio == 0:
        out.append(para(
            "_Dialogue ratio is reported as zero even though the text contains quoted speech: "
            "the detector matches straight quotation marks, and this text uses curly ones. "
            "Read every dialogue-dependent figure here as a lower bound._"
        ))
    out.append(para(f"**Interpretation:** {interp_genre(g)}"))
    return "\n".join(out)


def render_dialect(results: dict[str, Any], top_n: int) -> str:
    d = results.get("dialect")
    if d is None:
        return ""
    out: list[str] = []
    table = Table("Metric", "Value")
    table.row("**Dialect**", d.dialect)
    table.row("**Confidence**", fnum(d.confidence))
    table.row("**British Score**", fnum(d.british_score))
    table.row("**American Score**", fnum(d.american_score))
    table.row("**Markedness Score**", fnum(d.markedness_score))
    table.row("**British Score Std Dev**", fnum(d.british_score_dist.std))
    table.row("**American Score Std Dev**", fnum(d.american_score_dist.std))
    table.row("**Eye Dialect Count**", fnum(d.eye_dialect_count, 0))
    table.row("**Eye Dialect Ratio**", f"{d.eye_dialect_ratio:.2f} per 1000 words")
    table.row("**Chunks**", f"{d.chunk_count:,} x {d.chunk_size:,} words")
    out.append(table.render())

    if d.markers_by_level:
        table = Table("Linguistic Level", "Marker Types", "Occurrences")
        for level, markers in d.markers_by_level.items():
            occurrences = sum(markers.values()) if isinstance(markers, dict) else 0
            table.row(level.title(), fnum(len(markers) if isinstance(markers, dict) else 0, 0), fnum(occurrences, 0))
        out.append(table.render())

    for label, markers in (("Spelling", d.spelling_markers), ("Vocabulary", d.vocabulary_markers), ("Grammar", d.grammar_markers)):
        if markers:
            shown = sorted(markers.items(), key=lambda kv: -kv[1])[:top_n]
            out.append(para(f"**{label} markers observed:**"))
            table = Table("Marker", "Count")
            table.rows_from([(ftext(k), fnum(v, 0)) for k, v in shown])
            out.append(table.render())

    out.append(para(f"**Interpretation:** {interp_dialect(d)}"))
    return "\n".join(out)


def render_drift(results: dict[str, Any], top_n: int) -> str:
    d = results.get("drift")
    if d is None:
        return ""
    out: list[str] = []
    table = Table("Metric", "Value")
    table.row("**Status**", d.status)
    table.row("**Status Message**", d.status_message)
    table.row("**Pattern**", d.pattern)
    table.row("**Pattern Confidence**", fnum(d.pattern_confidence))
    table.row("**Mean Chi-squared**", fnum(d.mean_chi_squared, 2))
    table.row("**Std Chi-squared**", fnum(d.std_chi_squared, 2))
    table.row("**Max Chi-squared**", fnum(d.max_chi_squared, 2))
    table.row("**Min Chi-squared**", fnum(d.min_chi_squared, 2))
    table.row("**Max Location**", fnum(d.max_location, 0))
    table.row("**Trend Slope**", fnum(d.trend, 4))
    table.row("**Comparison Mode**", d.comparison_mode)
    table.row("**Windows**", fnum(d.window_count, 0))
    table.row("**Window Size**", fnum(d.window_size, 0))
    table.row("**Stride**", fnum(d.stride, 0))
    table.row("**Overlap Ratio**", fnum(d.overlap_ratio))
    out.append(table.render())

    if d.status == "success" and d.pairwise_scores:
        ranked = sorted(d.pairwise_scores, key=lambda p: -p.get("chi_squared", 0))[:top_n]
        out.append(para(f"**The {len(ranked)} most divergent window boundaries:**"))
        table = Table("Window pair", "Chi-squared", "Most distinctive words")
        for entry in ranked:
            pair = entry.get("chunk_pair", ("?", "?"))
            words = ", ".join(ftext(w) for w, _ in list(entry.get("top_words", []))[:6])
            table.row(f"{pair[0]} -> {pair[1]}", fnum(entry.get("chi_squared"), 2), words or "_none_")
        out.append(table.render())

    out.append(para(f"**Interpretation:** {interp_drift(d)}"))
    return "\n".join(out)


def render_prosody(results: dict[str, Any], top_n: int, text: str) -> str:
    out: list[str] = []
    rhythm = results.get("rhythm")
    if rhythm is not None:
        out.append(heading(3, "Rhythm and Prosody"))
        table = Table("Metric", "Value", "Description")
        table.row("**Mean Syllables per Word**", f"{rhythm.mean_syllables_per_word:.4f}", "Lexical weight")
        table.row("**Syllable Std Dev**", f"{rhythm.syllable_std_dev:.4f}", "Spread of word weight")
        table.row("**Rhythmic Regularity**", fnum(rhythm.rhythmic_regularity), "1 / CV of syllable counts")
        table.row("**Syllable CV**", fnum(rhythm.syllable_cv), "Coefficient of variation")
        table.row("**Stress Pattern Entropy**", fnum(rhythm.stress_pattern_entropy), "Variety of stress shapes")
        table.row("**Polysyllabic Ratio**", fnum(rhythm.polysyllabic_ratio), "Words of 3+ syllables")
        table.row("**Monosyllabic Ratio**", fnum(rhythm.monosyllabic_ratio), "Single-syllable words")
        table.row("**Alliteration Density**", fnum(rhythm.alliteration_density), "Alliterative pairs per 100 words")
        table.row("**Assonance Density**", fnum(rhythm.assonance_density), "Assonant pairs per 100 words")
        table.row("**Consonance Density**", fnum(rhythm.consonance_density), "Consonant pairs per 100 words")
        table.row("**Sentence Length Alternation**", fnum(rhythm.sentence_length_alternation), "Long/short alternation")
        table.row("**Sentence Rhythm Score**", fnum(rhythm.sentence_rhythm_score), "Composite rhythm score")
        table.row("**Iambic Ratio**", fnum(rhythm.iambic_ratio), "unstressed-stressed")
        table.row("**Trochaic Ratio**", fnum(rhythm.trochaic_ratio), "stressed-unstressed")
        out.append(table.render())
        out.append(para(f"**Interpretation:** {interp_prosody(rhythm)}"))

    sent = results.get("sentence_syllables")
    if sent is not None:
        out.append(heading(3, "Sentence Syllable Patterns"))
        table = Table("Metric", "Value")
        table.row("**Sentences Analysed**", fnum(len(sent.sentences), 0))
        table.row("**Mean Syllables per Sentence**", f"{sent.mean_syllables_per_sentence:.2f}")
        table.row("**Std Syllables per Sentence**", f"{sent.std_syllables_per_sentence:.2f}")
        table.row("**Sentence Syllable CV**", fnum(sent.sentence_syllable_cv))
        table.row("**Mean Sentence Complexity**", fnum(sent.mean_sentence_complexity))
        table.row("**Std Sentence Complexity**", fnum(sent.std_sentence_complexity))
        table.row("**Complexity Uniformity Score**", fnum(sent.complexity_uniformity_score))
        out.append(table.render())
        out.append(para(
            "**Interpretation:** the complexity uniformity score is a machine-text tell rather "
            "than a quality measure. Values above about 0.8 mean sentences are unusually "
            "alike in length and lexical weight, which is what template-generated prose tends "
            "to look like. This text sits at "
            f"{sent.complexity_uniformity_score:.2f}."
        ))

        if sent.sentences:
            # Very short sentences top a syllables-per-word ranking on noise alone
            # ("Oh!" scores 3.0), so require a minimum length before ranking.
            min_words = 10
            heavy = [s for s in sent.sentences if s.word_count >= min_words]
            heaviest = sorted(heavy, key=lambda s: -s.mean_syllables)[:top_n]
            if heaviest:
                sentence_text: dict[int, str] = {}
                try:
                    from pystylometry._utils import split_sentences

                    sentence_text = {i: s for i, s in enumerate(split_sentences(text))}
                except Exception:  # noqa: BLE001
                    pass
                out.append(para(f"**Heaviest sentences of {min_words} words or more, by syllables per word:**"))
                table = Table("Sentence #", "Words", "Syllables", "Syllables/word", "Text")
                for s in heaviest:
                    excerpt = ftext(repair_segmenter_text(sentence_text.get(s.sentence_index, "")))
                    if len(excerpt) > 90:
                        excerpt = excerpt[:87].rstrip() + "..."
                    table.row(
                        fnum(s.sentence_index, 0),
                        fnum(s.word_count, 0),
                        fnum(s.syllable_count, 0),
                        f"{s.mean_syllables:.3f}",
                        excerpt,
                    )
                out.append(table.render())

    patterns = results.get("syllable_patterns")
    if patterns is not None:
        out.append(heading(3, "Syllable Pattern Repetition"))
        table = Table("Metric", "Value")
        table.row("**Total Unique Patterns**", fnum(patterns.total_unique_patterns, 0))
        table.row("**Total Pattern Instances**", fnum(patterns.total_pattern_instances, 0))
        table.row("**Pattern Diversity Ratio**", fnum(patterns.pattern_diversity_ratio, 3))
        table.row("**Repeated Pattern Count**", fnum(patterns.repeated_pattern_count, 0))
        table.row("**Repetition Ratio**", fnum(patterns.repetition_ratio, 3))
        table.row("**Pattern Entropy**", fnum(patterns.pattern_entropy, 3))
        table.row("**Starting Pattern Repetition**", fnum(patterns.starting_pattern_repetition_rate, 3))
        table.row("**Ending Pattern Repetition**", fnum(patterns.ending_pattern_repetition_rate, 3))
        out.append(table.render())

        if patterns.top_repeated_patterns:
            out.append(para("**Most repeated syllable patterns:**"))
            table = Table("Pattern", "Occurrences", "Sentences")
            for pattern in patterns.top_repeated_patterns[:top_n]:
                table.row(
                    " ".join(str(x) for x in pattern.pattern),
                    fnum(pattern.count, 0),
                    fnum(len(pattern.sentence_indices), 0),
                )
            out.append(table.render())
        out.append(para(
            f"**Interpretation:** a repetition ratio of {patterns.repetition_ratio:.3f} means "
            f"{fpct(patterns.repetition_ratio)} of syllable n-grams occur more than once. "
            f"{fpct(patterns.starting_pattern_repetition_rate)} of sentence openings repeat a "
            f"pattern, which is the number to watch for formulaic phrasing."
        ))
    return "\n".join(out)


def render_cohesion(results: dict[str, Any]) -> str:
    c = results.get("cohesion")
    if c is None:
        return ""
    table = Table("Metric", "Value", "Description")
    table.row("**Pronoun Density**", fnum(c.pronoun_density, 2), "Pronouns per 100 words")
    table.row("**Demonstrative Density**", fnum(c.demonstrative_density, 2), "this, that, these, those per 100 words")
    table.row("**Anaphora Count**", fnum(c.anaphora_count, 0), "Anaphoric references detected")
    table.row("**Anaphora Resolution Ratio**", fnum(c.anaphora_resolution_ratio), "Resolved / total")
    table.row("**Word Repetition Ratio**", fnum(c.word_repetition_ratio), "Repeated content words")
    table.row("**Content Word Overlap**", fnum(c.content_word_overlap), "Overlap between sentences")
    table.row("**Connective Density**", fnum(c.connective_density, 2), "Discourse connectives per 100 words")
    table.row("**Additive Connectives**", fnum(c.additive_connective_ratio), "and, also, furthermore")
    table.row("**Adversative Connectives**", fnum(c.adversative_connective_ratio), "but, however, nevertheless")
    table.row("**Causal Connectives**", fnum(c.causal_connective_ratio), "because, therefore, thus")
    table.row("**Temporal Connectives**", fnum(c.temporal_connective_ratio), "then, after, before")
    table.row("**Adjacent Sentence Overlap**", fnum(c.adjacent_sentence_overlap), "Semantic overlap, neighbouring sentences")
    table.row("**Mean Sentence Similarity**", fnum(c.mean_sentence_similarity), "All sentence pairs")
    table.row("**Paragraph Topic Consistency**", fnum(c.paragraph_topic_consistency), "Topic stability within paragraphs")
    table.row("**Semantic Coherence Score**", fnum(c.semantic_coherence_score), "Composite coherence (0-1)")
    table.row("**Discourse Structure Score**", fnum(c.discourse_structure_score), "Intro/body/conclusion structure")
    table.row("**Paragraph Count**", fnum(c.paragraph_count, 0), "Paragraphs detected")
    table.row("**Mean Paragraph Length**", fnum(c.mean_paragraph_length, 2), "Sentences per paragraph")
    out = [table.render(), para(f"**Interpretation:** {interp_cohesion(c)}")]
    return "\n".join(out)


def render_extras(results: dict[str, Any], top_n: int) -> str:
    out: list[str] = []

    if (bnc := results.get("bnc")) is not None:
        out.append(heading(3, "BNC Frequency Profile"))
        out.append(para(
            "Compares token frequencies against British National Corpus expectations. "
            "Overused items are words this text leans on relative to general English; "
            "underused items are words it avoids."
        ))
        table = Table("Metric", "Value")
        table.row("**Total Tokens**", fnum(bnc.total_tokens, 0))
        table.row("**Unique Tokens**", fnum(bnc.unique_tokens, 0))
        table.row("**Overuse Threshold**", fnum(bnc.overuse_threshold, 2))
        table.row("**Underuse Threshold**", fnum(bnc.underuse_threshold, 2))
        table.row("**Not in BNC**", fnum(len(bnc.not_in_bnc), 0))
        out.append(table.render())

        for label, entries in (("Overused", bnc.overused), ("Underused", bnc.underused)):
            if not entries:
                continue
            out.append(para(f"**Top {min(top_n, len(entries))} {label.lower()} words:**"))
            table = Table("Word", "Observed", "Expected", "Ratio")
            for entry in entries[:top_n]:
                table.row(
                    ftext(entry.word),
                    fnum(entry.observed, 0),
                    fnum(entry.expected, 2),
                    fnum(entry.ratio, 2),
                )
            out.append(table.render())

    if (uni := results.get("rep_uni")) is not None:
        out.append(heading(3, "Repetition / Slop Detection"))
        out.append(para(
            "Flags content words used more often than their corpus frequency predicts. A high "
            "slop score means the text leans on the same words across the whole document "
            "rather than only locally."
        ))
        table = Table("Metric", "Value")
        table.row("**Slop Score**", fnum(uni.slop_score, 4))
        table.row("**Flagged Words**", fnum(uni.flagged_count, 0))
        table.row("**Flagged per 10,000 Words**", fnum(uni.flagged_words_per_10k, 2))
        table.row("**Mean Repetition Score**", fnum(uni.mean_repetition_score, 4))
        table.row("**Content Words**", fnum(uni.total_content_words, 0))
        out.append(table.render())
        if uni.repetitive_words:
            table = Table("Word", "Count", "Expected", "Score", "BNC Band")
            for entry in uni.repetitive_words[:top_n]:
                table.row(
                    ftext(entry.word),
                    fnum(entry.count, 0),
                    fnum(entry.expected_count, 2),
                    fnum(entry.repetition_score, 2),
                    ftext(entry.bnc_bucket),
                )
            out.append(table.render())

    if (ng := results.get("rep_ng")) is not None:
        orders = ng.n if isinstance(ng.n, tuple) else (ng.n,)
        out.append(para(
            f"**Repeated n-grams** (orders {', '.join(str(o) for o in orders)}): "
            f"{fnum(ng.flagged_count, 0)} flagged out of {fnum(ng.total_ngrams, 0)} "
            f"({fnum(ng.flagged_per_10k, 2)} per 10,000)."
        ))
        if ng.repetitive_ngrams:
            table = Table("N-gram", "Count", "Per 10k")
            for entry in ng.repetitive_ngrams[:top_n]:
                gram = entry.ngram
                gram = " ".join(gram) if isinstance(gram, (list, tuple)) else str(gram)
                table.row(ftext(gram), fnum(entry.count, 0), fnum(entry.frequency_per_10k, 2))
            out.append(table.render())

    return "\n".join(out)


def _join_paragraphs(paragraphs: list[str | None]) -> str:
    """Join narrative paragraphs, dropping the ones that are not applicable."""
    kept = [p.strip() for p in paragraphs if p and p.strip()]
    return "\n\n".join(kept) + "\n" if kept else ""


def _grades_line(results: dict[str, Any]) -> str | None:
    """One sentence listing every readability grade level that was computed."""
    parts: list[str] = []
    for key, label in [
        ("flesch", "Flesch-Kincaid"),
        ("smog", "SMOG"),
        ("gunning_fog", "Fog"),
        ("coleman_liau", "Coleman-Liau"),
        ("ari", "ARI"),
        ("dale_chall", "Dale-Chall"),
        ("linsear", "Linsear Write"),
        ("fry", "Fry"),
        ("forcast", "FORCAST"),
    ]:
        result = results.get(key)
        if result is None:
            continue
        grade = getattr(result, "grade_level", None)
        if isinstance(grade, bool) or grade is None:
            continue
        if isinstance(grade, str):
            parts.append(f"{label} {grade}")
        elif isinstance(grade, float) and math.isnan(grade):
            continue
        else:
            parts.append(f"{label} {grade:.1f}")
    if not parts:
        return None
    return "Grade levels by formula: " + ", ".join(parts[:-1]) + f", and {parts[-1]}." if len(parts) > 1 else f"Grade level: {parts[0]}."


def _advanced_diversity_line(results: dict[str, Any]) -> str | None:
    """One sentence covering vocd-D, MATTR, MSTTR, and HD-D."""
    pieces: list[str] = []
    if (vocd := results.get("vocd_d")) is not None:
        fit = vocd.curve_fit_r_squared
        if isinstance(fit, float) and (math.isnan(fit) or fit < 0):
            pieces.append(
                f"vocd-D reports D = {vocd.d_parameter:.2f} but its curve fit is unusable "
                f"(R-squared {fnum(fit, 2)}), so disregard it here"
            )
        else:
            pieces.append(f"vocd-D reports D = {vocd.d_parameter:.2f} (curve fit R-squared {fnum(fit, 3)})")
    if (mattr := results.get("mattr")) is not None:
        pieces.append(
            f"MATTR averages {mattr.mattr_score:.4f} over {mattr.window_size}-word windows "
            f"(std {mattr.ttr_std_dev:.4f})"
        )
    if (msttr := results.get("msttr")) is not None:
        pieces.append(
            f"MSTTR averages {msttr.msttr_score:.4f} over {msttr.segment_size}-word segments"
        )
    if (hdd := results.get("hdd")) is not None:
        pieces.append(f"HD-D scores {hdd.hdd_score:,.2f} on {hdd.sample_size}-token samples")
    if not pieces:
        return None
    return "The other length-normalised diversity measures: " + "; ".join(pieces) + "."


def _word_class_line(wc: Any) -> str | None:
    if wc is None:
        return None
    non_lexical = [c for c in wc.classifications if c.label != "lexical"]
    plain = next((c for c in wc.classifications if c.label == "lexical"), None)
    share = fpct(plain.percentage / 100) if plain is not None and plain.percentage else "0.0%"
    if not non_lexical:
        return (
            f"Word classes: nearly all {wc.total_words:,} tokens are plain lexical words, "
            f"with no contractions, possessives, or compounds to classify."
        )
    top = max(non_lexical, key=lambda c: c.count)
    detail = ", ".join(
        f"{c.label} ({c.count:,})"
        for c in sorted(non_lexical, key=lambda c: -c.count)[:3]
    )
    return (
        f"Word classes: {share} of {wc.total_words:,} tokens are plain lexical words; the "
        f"remaining {sum(c.count for c in non_lexical):,} surface forms split across "
        f"{len(non_lexical)} morphological classes, led by {detail}. The largest single class "
        f"is {top.label}."
    )


def _rare_word_line(fs: Any) -> str | None:
    """Vocabularly sophistication, told through the rare-word share alone."""
    if fs is None:
        return None
    return (
        f"Rare-word ratio: {fpct(fs.rare_word_ratio)} of tokens sit beyond rank 10,000 in the "
        f"reference corpus, against {fpct(fs.common_word_ratio)} inside the top 1,000. The "
        f"median token sits at rank {fnum(fs.median_frequency_rank, 0)}. This is a "
        f"vocabulary-sophistication measure, not a diversity one: it says how unusual the "
        f"words are, where MTLD and MATTR say how much they vary."
    )


def _core_readability_paragraph(results: dict[str, Any]) -> str | None:
    """Flesch-Kincaid against Dale-Chall, and what the gap between them means."""
    flesch = results.get("flesch")
    dale = results.get("dale_chall")
    if flesch is None and dale is None:
        return None
    pieces: list[str] = []
    fk: float | None = None
    if flesch is not None and isinstance(flesch.grade_level, (int, float)):
        fk = float(flesch.grade_level)
        pieces.append(f"Flesch-Kincaid puts the text at grade {fk:.1f}")
    dc: float | None = None
    if dale is not None:
        first_number = re.search(r"\d+(?:\.\d+)?", str(dale.grade_level))
        if first_number:
            dc = float(first_number.group())
        pieces.append(
            f"Dale-Chall scores {fnum(dale.dale_chall_score, 2)} "
            f"(grade {fgrade(dale.grade_level)}), on the strength of "
            f"{fpct(dale.difficult_word_ratio)} of words being outside its familiar-word list"
        )
    gap = ""
    if fk is not None and dc is not None:
        delta = dc - fk
        if delta >= 2:
            gap = (
                f" Dale-Chall reads {delta:.1f} grades above Flesch-Kincaid. Flesch-Kincaid "
                f"weights sentence length heavily and Dale-Chall weights unfamiliar vocabulary, "
                f"so the gap points at vocabulary rather than sentence construction — though "
                f"Dale-Chall is calibrated on texts for young readers and always runs high on "
                f"adult prose."
            )
        elif delta <= -2:
            gap = (
                f" Flesch-Kincaid reads {abs(delta):.1f} grades above Dale-Chall, which points "
                f"at long sentences rather than unfamiliar vocabulary."
            )
        else:
            gap = (
                f" The two formulas agree within {abs(delta):.1f} grades, so sentence length "
                f"and word familiarity are pulling in the same direction here."
            )
    return "; ".join(pieces) + "." + gap if pieces else None


def findings_lexical(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    if not args.all_metrics:
        return _join_paragraphs([
            interp_mtld(results["mtld"]) if results.get("mtld") else None,
            interp_mattr(results["mattr"]) if results.get("mattr") else None,
            _rare_word_line(results.get("freq_soph")),
        ])
    return _join_paragraphs([
        interp_ttr(results["ttr"]) if results.get("ttr") else None,
        interp_mtld(results["mtld"]) if results.get("mtld") else None,
        interp_yule(results["yule"]) if results.get("yule") else None,
        interp_hapax(results["hapax"]) if results.get("hapax") else None,
        interp_function_words(results["function_words"]) if results.get("function_words") else None,
        _advanced_diversity_line(results),
        interp_freq_soph(results["freq_soph"]) if results.get("freq_soph") else None,
        _word_class_line(results.get("word_class")),
    ])


def findings_readability(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    if not args.all_metrics:
        return _join_paragraphs([_core_readability_paragraph(results)])
    flesch = results.get("flesch")
    return _join_paragraphs([
        interp_flesch(flesch) if flesch else None,
        _grades_line(results),
        interp_readability_summary(*_grade_summary(results)),
    ])


def _grade_summary(results: dict[str, Any]) -> tuple[dict[str, float], float | None]:
    grades: dict[str, float] = {}
    for key, label in [
        ("flesch", "Flesch-Kincaid"),
        ("smog", "SMOG"),
        ("gunning_fog", "Gunning Fog"),
        ("coleman_liau", "Coleman-Liau"),
        ("ari", "ARI"),
        ("dale_chall", "Dale-Chall"),
        ("linsear", "Linsear Write"),
        ("fry", "Fry"),
        ("forcast", "FORCAST"),
    ]:
        result = results.get(key)
        if result is None:
            continue
        value = getattr(result, "grade_level", None)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if isinstance(value, float) and math.isnan(value):
            continue
        grades[label] = float(value)
    average = sum(grades.values()) / len(grades) if grades else None
    return grades, average


def findings_syntactic(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    return _join_paragraphs([
        interp_pos(results["pos"]) if results.get("pos") else None,
        interp_sentence_stats(results["sentence_stats"]) if results.get("sentence_stats") else None,
        interp_advanced(results["advanced"]) if results.get("advanced") else None,
        interp_sentence_types(results["sentence_types"]) if results.get("sentence_types") else None,
    ])


def findings_character(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    chars = results.get("character")
    return _join_paragraphs([interp_character(chars) if chars else None])


def findings_ngrams(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    char_bi, word_bi = results.get("char_bigram"), results.get("word_bigram")
    ext = results.get("extended_ngrams")
    top = _clean_ngrams(ext.top_word_trigrams, 1) if ext is not None else []
    return _join_paragraphs([
        interp_entropy(char_bi, word_bi) if char_bi is not None and word_bi is not None else None,
        (
            f"The most repeated word trigram is \"{top[0][0]}\" at "
            f"{fwords(top[0][1], 'occurrence')}, out of {ext.word_trigram_count:,} distinct "
            f"trigrams; word trigram entropy is {ext.word_trigram_entropy:.4f} bits."
            if top and ext is not None
            else None
        ),
    ])


def findings_markers(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    m = results.get("markers")
    return _join_paragraphs([interp_markers(m, has_typographic_quotes(text)) if m else None])


def findings_genre(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    g = results.get("genre")
    if g is None:
        return ""
    note = ""
    if has_typographic_quotes(text) and g.dialogue_ratio == 0:
        note = (
            " Dialogue ratio reads as zero despite the text containing quoted speech, because "
            "curly quotes are not matched by the counter."
        )
    return _join_paragraphs([interp_genre(g) + note])


def findings_dialect(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    d = results.get("dialect")
    return _join_paragraphs([interp_dialect(d) if d else None])


def findings_drift(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    d = results.get("drift")
    if d is None:
        return ""
    extra = ""
    if d.status == "success" and d.pairwise_scores:
        worst = max(d.pairwise_scores, key=lambda p: p.get("chi_squared", 0))
        words = ", ".join(ftext(w) for w, _ in list(worst.get("top_words", []))[:5])
        pair = worst.get("chunk_pair", ("?", "?"))
        extra = (
            f" The single most divergent boundary sits between windows {pair[0]} and {pair[1]} "
            f"({fnum(worst.get('chi_squared'), 2)}), where the words driving the distance are "
            f"{words or 'none listed'}."
        )
    return _join_paragraphs([interp_drift(d) + extra])


def findings_prosody(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    rhythm = results.get("rhythm")
    sent = results.get("sentence_syllables")
    patterns = results.get("syllable_patterns")
    return _join_paragraphs([
        interp_prosody(rhythm) if rhythm else None,
        (
            f"Across {len(sent.sentences):,} sentences the average is "
            f"{sent.mean_syllables_per_sentence:.2f} syllables with a standard deviation of "
            f"{sent.std_syllables_per_sentence:.2f}. The complexity uniformity score is "
            f"{sent.complexity_uniformity_score:.2f}; above about 0.80 is the band where "
            f"sentences look machine-uniform rather than hand-varied."
            if sent is not None and sent.sentences
            else None
        ),
        (
            f"Syllable-pattern repetition is {patterns.repetition_ratio:.3f} "
            f"({fpct(patterns.repetition_ratio)} of syllable n-grams recur), with "
            f"{fpct(patterns.starting_pattern_repetition_rate)} of sentence openings repeating "
            f"a known pattern."            if patterns is not None
            else None
        ),
    ])


def findings_cohesion(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    c = results.get("cohesion")
    return _join_paragraphs([interp_cohesion(c) if c else None])


def findings_extras(results: dict[str, Any], args: argparse.Namespace, text: str) -> str:
    paragraphs: list[str | None] = []

    if (bnc := results.get("bnc")) is not None:
        top = ", ".join(f"{ftext(w.word)} ({w.ratio:,.0f}x)" for w in bnc.overused[:5])
        paragraphs.append(
            f"Against BNC frequencies, {len(bnc.overused):,} words are overused, "
            f"{len(bnc.underused):,} are underused, and {len(bnc.not_in_bnc):,} do not appear in "
            f"the corpus at all. The most overused are {top or 'none'}; the extreme ratios are "
            f"proper nouns and coinages the reference corpus has never seen, so read them as "
            f"topic words rather than as style."
        )
    if (uni := results.get("rep_uni")) is not None:
        top = ", ".join(f"{ftext(w.word)} ({w.count:,} uses)" for w in uni.repetitive_words[:5])
        paragraphs.append(
            f"Repetition detection flags {uni.flagged_count:,} content words "
            f"({fnum(uni.flagged_words_per_10k, 1)} per 10,000) with a slop score of "
            f"{fnum(uni.slop_score, 1)}. Ranked by how far they exceed corpus expectations, "
            f"the highest-scoring are {top or 'none'}."
        )
    if (ng := results.get("rep_ng")) is not None:
        top = ""
        if ng.repetitive_ngrams:
            gram = ng.repetitive_ngrams[0].ngram
            gram = " ".join(gram) if isinstance(gram, (list, tuple)) else str(gram)
            top = f" The top repeated collocation is \"{ftext(gram)}\" ({ng.repetitive_ngrams[0].count:,})."
        paragraphs.append(
            f"{ng.flagged_count:,} repeated n-grams were flagged out of "
            f"{ng.total_ngrams:,} candidates ({fnum(ng.flagged_per_10k, 1)} per 10,000).{top}"
        )
    return _join_paragraphs(paragraphs)


FINDINGS_RENDERERS: dict[str, Callable[[dict[str, Any], argparse.Namespace, str], str]] = {
    "lexical": findings_lexical,
    "readability": findings_readability,
    "syntactic": findings_syntactic,
    "character": findings_character,
    "ngrams": findings_ngrams,
    "markers": findings_markers,
    "genre": findings_genre,
    "dialect": findings_dialect,
    "drift": findings_drift,
    "prosody": findings_prosody,
    "cohesion": findings_cohesion,
    "extras": findings_extras,
}


SECTION_TITLES = {
    "summary": "Text Summary",
    "summary-table": "Consolidated Metrics",
    "lexical": "Lexical Metrics",
    "readability": "Readability Metrics",
    "syntactic": "Syntactic Metrics",
    "character": "Character-Level Metrics",
    "ngrams": "N-gram Entropy Metrics",
    "markers": "Style Markers",
    "genre": "Genre and Register",
    "dialect": "Dialect",
    "drift": "Style Drift",
    "prosody": "Rhythm and Prosody",
    "cohesion": "Cohesion and Coherence",
    "extras": "Additional Lexical Profile",
    "appendix": "Appendix",
}


def render_summary_narrative(meta: dict[str, Any], results: dict[str, Any], text: str, args: argparse.Namespace) -> str:
    """The handful of context lines that precede the consolidated table.

    The metadata itself lives in the table; this only sets up how to read it.
    """
    ttr = results.get("ttr")
    lead = f"by {meta.get('author')}" if meta.get("author") else "No author recorded"
    if meta.get("year"):
        lead += f" ({meta['year']})"
    if meta.get("genre"):
        lead += f", {meta['genre']}"
    lead += f". Source file: `{Path(meta['source']).name}`."

    parts = [para(lead)]
    if ttr is not None and ttr.ttr:
        parts.append(para(
            f"{len(text.split()):,} whitespace tokens, {ttr.unique_words:,} of them distinct "
            f"(one new word per {1 / ttr.ttr:.1f} tokens). Every number below is computed at a "
            f"chunk size of {args.chunk_size:,} words; metrics that aggregate across chunks "
            f"change if that changes."
        ))
    if len(text.split()) < 2000:
        parts.append(para(
            f"**Caveat:** at {len(text.split()):,} tokens this text is short. MTLD, Yule's K, "
            f"Honore's R, vocd-D, and HD-D were calibrated on texts of at least a few thousand "
            f"words, and the readability formulas assume a handful of sentences. Read the "
            f"numbers as a smoke test rather than a profile."
        ))
    return "\n".join(parts)


def render_appendix(results: dict[str, Any], args: argparse.Namespace, meta: dict[str, Any], elapsed: float) -> str:
    """Provenance for the single table above, as prose and bullets rather than tables."""
    versions = [f"Python {platform.python_version()}"]
    try:
        from importlib.metadata import distribution as _distribution
        from importlib.metadata import version as _version

        source = ""
        try:
            direct = _distribution("pystylometry").read_text("direct_url.json")
            if direct:
                source = json.loads(direct).get("url", "")
        except Exception:  # noqa: BLE001
            source = ""
        versions.append(f"pystylometry {_version('pystylometry')}" + (f" ({source})" if source else ""))
    except Exception:  # noqa: BLE001
        versions.append("pystylometry unknown")
    for package in ("spacy", "cmudict", "bnc-lookup", "openpyxl"):
        try:
            import importlib as _importlib
            from importlib.metadata import version as _version2

            _importlib.import_module(package.replace("-", "_"))
            versions.append(f"{package} {_version2(package)}")
        except Exception:  # noqa: BLE001
            versions.append(f"{package} not installed")

    out = [para(
        f"Every figure in the table above comes from the pystylometry library; this report "
        f"only formats the values and applies the published bandings in the findings. "
        f"Generated {meta.get('generated', '')} from `{meta['source']}` in {elapsed:.1f} s, "
        f"with `--chunk-size {args.chunk_size}` and drift windows of {DRIFT_WINDOW:,} words "
        f"striding {DRIFT_STRIDE:,}. Environment: {', '.join(versions)}."
    )]
    if not args.all_metrics:
        out.insert(0, para(
            "**Focused profile.** Readability is represented by Flesch-Kincaid and Dale-Chall, "
            "and lexical diversity by MTLD, MATTR, and rare-word ratio. The other readability "
            "formulas correlate 0.92-0.99 with Flesch-Kincaid, and the other diversity "
            "measures duplicate MTLD, MATTR, or the hapax/TTR pair; `--all-metrics` restores "
            "them. The evidence is in `evidence/metric-redundancy.md` next to this skill."
        ))

    skipped = results.get("_skipped") or []
    if skipped:
        out.append(para("**Skipped metrics:**"))
        out.append("\n".join(f"- **{ftext(label)}** — {ftext(reason)}" for label, reason in skipped) + "\n")
    else:
        out.append(para("**Skipped metrics:** none."))

    out.append(para("**References**"))
    out.append("\n".join(
        f"- {reference}"
        for reference in [
            "Guiraud, P. (1960). *Problemes et methodes de la statistique linguistique*.",
            "Flesch, R. (1948). A new readability yardstick. *Journal of Applied Psychology*.",
            "McCarthy, P. M., & Jarvis, S. (2010). MTLD, vocd-D and HD-D: a validation study. *Behavior Research Methods*.",
            "Kilgarriff, A. (2001). Comparing corpora. *International Journal of Corpus Linguistics*.",
            "Burrows, J. (2002). Delta: a measure of stylistic difference. *Literary and Linguistic Computing*.",
        ]
    ) + "\n")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def strip_markdown(text: str) -> str:
    """Reduce markdown to prose so structural syntax does not skew the metrics."""
    text = text.lstrip("\ufeff\n\r\t ")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            text = parts[2]
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s{0,3}>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*([^*]*)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"^\|.*\|\s*$", " ", text, flags=re.MULTILINE)
    return text


def load_text(path: Path, strip_md: bool) -> str:
    """Read the input, tolerating encodings that are not UTF-8."""
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            if encoding in {"cp1252", "latin-1"}:
                print(
                    f"warning: {path.name} is not valid UTF-8; decoded as {encoding}",
                    file=sys.stderr,
                )
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - latin-1 decodes anything, so this is unreachable
        text = raw.decode("utf-8", errors="replace")
    if strip_md and path.suffix.lower() in {".md", ".markdown"}:
        text = strip_markdown(text)
    return text


def text_meta(text: str) -> dict[str, Any]:
    """Sentence, paragraph, and word counts, using the library's own segmenter."""
    meta: dict[str, Any] = {}
    try:
        from pystylometry._utils import split_paragraphs, split_sentences

        meta["sentence_count"] = f"{len(split_sentences(text)):,}"
        meta["paragraph_count"] = f"{len(split_paragraphs(text)):,}"
    except Exception:  # noqa: BLE001
        meta["sentence_count"] = "n/a"
        meta["paragraph_count"] = "n/a"
    try:
        from pystylometry._utils import tokenize

        words = [t for t in tokenize(text) if any(ch.isalnum() for ch in t)]
        meta["type_count"] = f"{len({w.lower() for w in words}):,}"
        meta["token_count"] = f"{len(words):,}"
    except Exception:  # noqa: BLE001
        pass
    return meta


def build_report(
    text: str,
    results: dict[str, Any],
    args: argparse.Namespace,
    meta: dict[str, Any],
    elapsed: float,
) -> str:
    title = args.title or meta.get("title") or "Text"
    parts: list[str] = []

    included = [
        SECTION_TITLES.get(name, name)
        for name in SECTION_ORDER
        if name in args.sections and name not in {"summary-table", "appendix"}
    ]
    parts.append(f"# Stylometric Analysis: {title}\n")
    intro = (
        f"A stylometric profile of {title}, produced with "
        f"[pystylometry](https://github.com/craigtrim/pystylometry) at a chunk size of "
        f"{args.chunk_size:,} words."
    )
    if "summary-table" in args.sections:
        intro += " One table holds every metric."
    if not args.all_metrics:
        intro += (
            " Focused profile: readability is limited to Flesch-Kincaid and Dale-Chall, and "
            "lexical diversity to MTLD, MATTR, and rare-word ratio; `--all-metrics` reports "
            "the full set."
        )
    if included:
        intro += f" Findings follow for {', '.join(included)}."
    parts.append(para(intro))

    renderers: list[tuple[str, Callable[[], str]]] = [
        (
            "summary",
            lambda: "## Text Summary\n\n" + (
                render_summary(meta, results, text, args)
                if args.with_detail
                else render_summary_narrative(meta, results, text, args)
            ),
        ),
        ("summary-table", lambda: "## Consolidated Metrics\n\n" + render_summary_table(
            results, text, meta, args,
            expanded=bool(args.sections - {"summary", "summary-table", "appendix"}),
        )),
        ("lexical", lambda: "## Lexical Metrics\n\n" + render_lexical(results, args.top_n)),
        ("readability", lambda: "## Readability Metrics\n\n" + render_readability(results)),
        ("syntactic", lambda: "## Syntactic Metrics\n\n" + render_syntactic(results)),
        ("character", lambda: "## Character-Level Metrics\n\n" + render_character(results, args.top_n)),
        ("ngrams", lambda: "## N-gram Entropy Metrics\n\n" + render_ngrams(results, args.top_n)),
        ("markers", lambda: "## Style Markers\n\n" + render_markers(results, args.top_n, text)),
        ("genre", lambda: "## Genre and Register\n\n" + render_genre(results, text)),
        ("dialect", lambda: "## Dialect\n\n" + render_dialect(results, args.top_n)),
        ("drift", lambda: "## Style Drift\n\n" + render_drift(results, args.top_n)),
        ("prosody", lambda: "## Rhythm and Prosody\n\n" + render_prosody(results, args.top_n, text)),
        ("cohesion", lambda: "## Cohesion and Coherence\n\n" + render_cohesion(results)),
        ("extras", lambda: "## Additional Lexical Profile\n\n" + render_extras(results, args.top_n)),
        ("appendix", lambda: "## Appendix\n\n" + render_appendix(results, args, meta, elapsed)),
    ]

    for name, render in renderers:
        if name not in args.sections:
            continue
        if not args.with_detail and name in FINDINGS_RENDERERS:
            body = render_findings_section(name, results, args, text).strip()
            if not body:
                continue
            parts.append("---\n")
            parts.append(f"## {SECTION_TITLES[name]}\n\n{body}\n")
            continue
        body = render().strip()
        if not body:
            continue
        parts.append("---\n")
        parts.append(body + "\n")

    return "\n".join(parts)


def render_findings_section(
    name: str, results: dict[str, Any], args: argparse.Namespace, text: str
) -> str:
    """Narrative findings for one category, or an empty string if none."""
    renderer = FINDINGS_RENDERERS.get(name)
    if renderer is None:
        return ""
    body = renderer(results, args, text).strip()
    if not body and results.get("_skipped"):
        return "_No metrics for this category were computed._"
    return body


def to_jsonable(value: Any) -> Any:
    """Recursively convert results (dataclasses, tuples, dicts) to JSON-safe data."""
    if hasattr(value, "__dataclass_fields__"):
        return {k: to_jsonable(v) for k, v in value.__dict__.items()}
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_sections(raw: str) -> set[str]:
    if raw.strip().lower() in {"all", "*"}:
        return set(SECTION_ORDER)
    available = set(SECTION_ORDER)
    requested = {part.strip() for part in raw.split(",") if part.strip()}
    unknown = requested - available
    if unknown:
        raise SystemExit(
            f"Unknown section(s): {', '.join(sorted(unknown))}. "
            f"Available: {', '.join(SECTION_ORDER)}"
        )
    return requested


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="stylometry-report",
        description=(
            "Generate a markdown stylometric report for one text using pystylometry. "
            "Modelled on pystylometry's metrics showcase document."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  stylometry-report chapter.md\n"
            "  stylometry-report novel.txt -o novel-stylometry.md --author 'Arthur Conan Doyle' \\\n"
            "      --year 1902 --genre 'detective fiction'\n"
            "  stylometry-report draft.md --sections lexical,readability,markers\n"
            "  stylometry-report draft.md --list-sections\n"
        ),
    )
    parser.add_argument("input", nargs="?", type=Path, help="Text or markdown file to analyse")
    parser.add_argument("-o", "--output", type=Path, default=None, help="Report path (default: <input>.stylometry.md)")
    parser.add_argument("--title", default=None, help="Title used in the report heading")
    parser.add_argument("--author", default=None, help="Author, recorded in the text summary")
    parser.add_argument("--year", default=None, help="Year of composition or publication")
    parser.add_argument("--genre", default=None, help="Genre label, recorded in the text summary")
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1000,
        help="Words per analysis chunk for metrics that aggregate across chunks (default: 1000)",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Entries shown in ranked tables such as top function words (default: 10)",
    )
    parser.add_argument(
        "--sections",
        default="all",
        help="Comma-separated sections to include, or 'all' (default: all)",
    )
    parser.add_argument(
        "--skip",
        default="",
        help="Comma-separated sections to drop after applying --sections",
    )
    parser.add_argument("--json", type=Path, default=None, help="Also dump raw metric values as JSON")
    parser.add_argument(
        "--strip-markdown",
        action="store_true",
        default=True,
        help="Strip markdown syntax before analysis (default: on)",
    )
    parser.add_argument(
        "--no-strip-markdown",
        dest="strip_markdown",
        action="store_false",
        help="Analyse markdown files verbatim, syntax included",
    )
    parser.add_argument(
        "--with-detail",
        action="store_true",
        help="Also emit the per-metric tables for each category (default: findings only)",
    )
    parser.add_argument(
        "--all-metrics",
        action="store_true",
        help=(
            "Report every metric instead of the focused set (default keeps Flesch-Kincaid and "
            "Dale-Chall for readability, MTLD, MATTR and rare-word ratio for lexical diversity)"
        ),
    )
    parser.add_argument(
        "--table-only",
        action="store_true",
        help="Emit only the text summary, the consolidated metrics table, and the appendix",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output on stderr")
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Do not silence the analysis libraries' own log and progress output",
    )
    parser.add_argument("--list-sections", action="store_true", help="List section names and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Held separately because the analysis libraries write to stderr too, and
    # progress messages must survive the redirection that silences them.
    real_stderr = sys.stderr

    if args.list_sections:
        for name in SECTION_ORDER:
            print(f"{name:<12} {SECTION_DESCRIPTIONS[name]}")
        return 0

    if args.input is None:
        parser.error("an input file is required (use --list-sections to see section names)")
    if not args.input.is_file():
        parser.error(f"input file not found: {args.input}")

    args.sections = parse_sections(args.sections)
    if args.skip.strip():
        args.sections -= parse_sections(args.skip)
    if args.table_only:
        args.sections = {"summary", "summary-table", "appendix"} - set(
            parse_sections(args.skip) if args.skip.strip() else set()
        )

    # The consolidated table reports every metric, so ask for all of them even
    # when only that table is going to be rendered.
    compute_sections = set(args.sections)
    if "summary-table" in args.sections:
        compute_sections = set(SECTION_ORDER)

    def log(message: str) -> None:
        if not args.quiet:
            print(message, file=real_stderr, flush=True)

    text = load_text(args.input, args.strip_markdown)
    if not text.strip():
        parser.error(f"input file is empty after preprocessing: {args.input}")

    try:
        import pystylometry  # noqa: F401 - presence check, for a readable error
    except ImportError as exc:
        print(f"error: pystylometry is not importable in {sys.executable}", file=real_stderr)
        print(f"       ({exc})", file=real_stderr)
        print("       rebuild the environment with:", file=real_stderr)
        print(f"       {Path(__file__).with_name('setup_env.sh')}", file=real_stderr)
        return 1

    output = args.output or args.input.with_name(args.input.stem + ".stylometry.md")
    started = _dt.datetime.now()
    log(f"analysing {args.input} ({len(text):,} chars, {len(text.split()):,} tokens)")
    import time as _time

    t0 = _time.monotonic()
    if args.verbose:
        results = run_analysis(text, args.chunk_size, compute_sections, log, args.all_metrics)
    else:
        # pystylometry's dependencies log progress through logging and print()
        # (fast-sentence-segment is the loud one). Silence both while leaving
        # our own progress messages visible on the real stderr.
        import contextlib
        import logging
        import os

        logging.disable(logging.WARNING)
        logging.getLogger().setLevel(logging.ERROR)
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            results = run_analysis(text, args.chunk_size, compute_sections, log, args.all_metrics)
    elapsed = _time.monotonic() - t0
    log(f"analysis complete in {elapsed:.1f}s; writing {output}")

    meta = {
        "source": str(args.input),
        "output": str(output),
        "title": args.title or display_title(args.input.stem),
        "author": args.author,
        "year": args.year,
        "genre": args.genre,
        "generated": started.strftime("%Y-%m-%d %H:%M"),
    }
    meta.update(text_meta(text))

    report = build_report(text, results, args, meta, elapsed)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(report, encoding="utf-8")

    if args.json:
        payload = {
            "meta": meta,
            "metrics": {k: to_jsonable(v) for k, v in results.items() if k != "_skipped"},
            "skipped": results.get("_skipped", []),
        }
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log(f"raw metrics written to {args.json}")

    skipped = results.get("_skipped") or []
    log(f"done: {output} ({len(report):,} chars, {len(skipped)} metric(s) skipped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
