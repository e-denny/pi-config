import json, itertools, math
import numpy as np
from scipy.stats import spearmanr

d = json.load(open("measurements.json"))["texts"]
names = list(d["11"]["metrics"])
docval, nseries = {}, {}
for n in names:
    vals = []
    for t in d:
        v = [x for x in d[t]["metrics"].get(n, []) if isinstance(x, (int, float)) and not math.isnan(x)]
        if v: vals.append(float(np.mean(v)))
    docval[n] = vals
    nseries[n] = min((len([x for x in d[t]["metrics"].get(n, []) if isinstance(x,(int,float))])
                      for t in d), default=0)

print("metric                         texts  per-chunk series?")
for n in names:
    print(f"  {n:28} {len(docval[n]):5}  {'yes (min %d chunks)' % nseries[n] if nseries[n] > 1 else 'NO - document value only'}")

LEX = ["ttr_raw","mtld","yule_k","hapax_ratio","mattr","msttr","vocd_d","hdd",
       "rare_word_ratio","advanced_word_ratio"]
print("\n=== LEXICAL, between-text (document means, n=%d) ===" % len(docval["ttr_raw"]))
rows = []
for a, b in itertools.combinations(LEX, 2):
    r = spearmanr(docval[a], docval[b]).statistic
    rows.append((a, b, r))
rows.sort(key=lambda x: -abs(x[2]))
for a, b, r in rows:
    print(f"  {r:+.2f}  {a:22} {b}")
mx = {n: max(abs(r) for a,b,r in rows if n in (a,b)) for n in LEX}
print("\n  max |rho| with any other lexical measure:")
for n, v in sorted(mx.items(), key=lambda kv: -kv[1]):
    print(f"    {v:.2f}  {n}")
