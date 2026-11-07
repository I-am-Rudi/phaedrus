# Word frequency lists

One file per language: the 40,000 most frequent words, grouped by Zipf
frequency (the base-10 logarithm of occurrences per billion words) in steps of
0.1, one line per step:

```
7.4	to and of a
```

Phaedrus uses them to rank spelling suggestions and to find candidates the
spelling engine did not offer. A candidate is only shown if the spelling
engine accepts it as a word, so misspellings that are common enough to appear
here ("teh", "alot") are never suggested.

Regenerate with `python3 scripts/export-wordfreq.py src/shared/spelling/wordfreq 40000`.

## Source and licence

The lists are exported from [wordfreq](https://github.com/rspeer/wordfreq)
3.1.1 by Robyn Speer. Its data is licensed under the
[Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
licence, and so are these lists.

wordfreq's data comes from, and these lists therefore contain data derived from:

- Google Books Ngrams (<http://books.google.com/ngrams>) and Google Books
  Syntactic Ngrams
- The Leeds Internet Corpus, University of Leeds Centre for Translation Studies
  (<http://corpus.leeds.ac.uk/list.html>)
- Wikipedia (<http://www.wikipedia.org>)
- ParaCrawl (<https://paracrawl.eu>)
- OPUS OpenSubtitles 2018 (<http://opus.nlpl.eu/OpenSubtitles.php>), from the
  OpenSubtitles project (<http://www.opensubtitles.org/>)
- The SUBTLEX word lists (SUBTLEX-US, SUBTLEX-UK, SUBTLEX-CH, SUBTLEX-DE,
  SUBTLEX-NL) by Marc Brysbaert et al., freely available at
  <http://crr.ugent.be/programs-data/subtitle-frequencies>
- Word counts from the Twitter streaming API, as collected by
  wordfreq

Robyn Speer (2022). rspeer/wordfreq: v3.0 (v3.0.2). Zenodo.
<https://doi.org/10.5281/zenodo.7199437>
