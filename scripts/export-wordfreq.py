#!/usr/bin/env python3
# Regenerates src/shared/spelling/wordfreq/*.txt from the wordfreq package
# (pip install wordfreq). Usage: python3 scripts/export-wordfreq.py src/shared/spelling/wordfreq 40000

# Export the most frequent words per language from wordfreq, grouped by Zipf
# frequency (log10 of occurrences per billion words) in steps of 0.1:
#   "<zipf>\t<word> <word> ..." one line per step, most frequent first.
import re, sys, os, collections
from wordfreq import top_n_list, zipf_frequency
out_dir, n = sys.argv[1], int(sys.argv[2])
LANGS = ['en','de','fr','es','pt','nl','ca','uk','pl','ru','it','sv','da','el']
word_re = re.compile(r"^[^\W\d_]+(?:['’-][^\W\d_]+)*$")
os.makedirs(out_dir, exist_ok=True)
for lang in LANGS:
    buckets = collections.OrderedDict()
    kept = 0
    for w in top_n_list(lang, n, wordlist='best'):
        if not word_re.match(w): continue
        z = zipf_frequency(w, lang, wordlist='best')
        if z < 2.0: continue
        buckets.setdefault(round(z, 1), []).append(w)
        kept += 1
    path = os.path.join(out_dir, f'{lang}.txt')
    with open(path, 'w', encoding='utf-8') as f:
        for z, ws in buckets.items():
            f.write(f'{z:.1f}\t{" ".join(ws)}\n')
    print(lang, kept, os.path.getsize(path)//1024, 'KB')
