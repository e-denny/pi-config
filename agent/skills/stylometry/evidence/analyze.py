import json, itertools, math
import numpy as np
from scipy.stats import spearmanr

d = json.load(open("measurements.json"))["texts"]
LEX = ["ttr_raw", "mtld", "yule_k", "hapax_ratio"]
READ = ["flesch_reading_ease", "flesch_kincaid_grade", "smog", "gunning_fog",
        "coleman_liau", "ari", "dale_chall", "linsear_write", "forcast", "psk",
        "fry_avg_sent_len", "fry_syll_per_100"]

def series(text, name):
    v = d[text]["metrics"].get(name, [])
    return [(i, x) for i, x in enumerate(v) if isinstance(x, (int, float)) and not math.isnan(x)]

def pairwise(names, label):
    """Per-text Spearman, averaged with Fisher z (equal weight per text)."""
    rows = []
    for a, b in itertools.combinations(names, 2):
        rhos = []
        for t in d:
            ia = dict(series(t, a)); ib = dict(series(t, b))
            common = sorted(set(ia) & set(ib))
            if len(common) < 8: continue
            x = [ia[i] for i in common]; y = [ib[i] for i in common]
            if len(set(x)) < 3 or len(set(y)) < 3: continue
            r = spearmanr(x, y).statistic
            if not math.isnan(r) and abs(r) < 0.9999:
                rhos.append(math.atanh(max(min(r, 0.9999), -0.9999)))
        if rhos:
            z = sum(rhos) / len(rhos)
            rows.append((a, b, math.tanh(z), len(rhos)))
    rows.sort(key=lambda r: -abs(r[2]))
    print(f"\n=== {label}: top pairs (median-per-text Spearman via Fisher z, n_texts) ===")
    for a, b, r, n in rows[:14]:
        print(f"  {r:+.2f}  {a:24} {b:24} n_texts={n}")
    print(f"  ... {len(rows)} pairs total | near-duplicates |r|>=0.90: "
          f"{sum(1 for _,_,r,_ in rows if abs(r)>=0.90)} | independent |r|<0.50: "
          f"{sum(1 for _,_,r,_ in rows if abs(r)<0.50)}")
    weak = [(a,b,r) for a,b,r,_ in rows if abs(r) < 0.60]
    print("  pairs that are NOT strongly coupled (|r|<0.60):")
    for a, b, r in weak:
        print(f"    {r:+.2f}  {a} vs {b}")
    return rows

r_lex = pairwise(LEX, "LEXICAL per-chunk")
r_read = pairwise(READ, "READABILITY per-chunk")

# between-text: document-level means, n = 16
print("\n=== BETWEEN-TEXT (document means, n=16) ===")
names = list(d["11"]["metrics"])
means = {}
for n in names:
    vals = []
    for t in d:
        v = series(t, n)
        if len(v) >= 3: vals.append(float(np.mean([x for _, x in v])))
    means[n] = vals
print("metric coverage:", {n: len(v) for n, v in means.items() if len(v) != 16} or "all 16 texts")
print("\n  Readability grade-level cluster (document means):")
for a, b in [("flesch_kincaid_grade","gunning_fog"),("flesch_kincaid_grade","smog"),
             ("flesch_kincaid_grade","coleman_liau"),("flesch_kincaid_grade","ari"),
             ("flesch_kincaid_grade","dale_chall"),("gunning_fog","smog"),
             ("gunning_fog","dale_chall"),("smog","dale_chall"),("coleman_liau","ari"),
             ("coleman_liau","dale_chall"),("ari","dale_chall"),("flesch_kincaid_grade","linsear_write"),
             ("flesch_kincaid_grade","forcast"),("gunning_fog","forcast")]:
    r = spearmanr(means[a], means[b]).statistic
    print(f"    {r:+.2f}  {a} vs {b}")
print("\n  Lexical cluster (document means):")
for a, b in [("ttr_raw","mtld"),("ttr_raw","yule_k"),("ttr_raw","hapax_ratio"),
             ("mtld","yule_k"),("mtld","hapax_ratio"),("yule_k","hapax_ratio"),
             ("mtld","mattr"),("mtld","msttr"),("mtld","vocd_d"),("mtld","hdd"),
             ("mattr","msttr"),("mattr","vocd_d"),("hdd","vocd_d"),("hdd","mattr"),
             ("rare_word_ratio","advanced_word_ratio"),("hapax_ratio","rare_word_ratio"),
             ("yule_k","rare_word_ratio"),("ttr_raw","advanced_word_ratio")]:
    r = spearmanr(means[a], means[b]).statistic
    print(f"    {r:+.2f}  {a} vs {b}")
print("\n  Independent of the lexical-diversity cluster (expect low):")
for a, b in [("ttr_raw","flesch_kincaid_grade"),("mtld","flesch_kincaid_grade"),
             ("flesch_kincaid_grade","rare_word_ratio"),("flesch_kincaid_grade","ttr_raw")]:
    r = spearmanr(means[a], means[b]).statistic
    print(f"    {r:+.2f}  {a} vs {b}")
