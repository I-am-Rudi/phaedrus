// Word frequencies per language, loaded only when a document in that language
// is checked. Data and licence: wordfreq/README.md.

export interface WordList {
  lang: string;
  /** Zipf frequency (log10 of occurrences per billion words) of a lower-case word; undefined if not listed. */
  zipf(word: string): number | undefined;
  /** Letters common in the language, for generating candidates. */
  alphabet: string[];
}

const files = import.meta.glob<string>('./wordfreq/*.txt', { query: '?raw', import: 'default' });
const loaded = new Map<string, Promise<WordList | null>>();

/** Parses "<zipf>\t<word> <word> ..." lines. */
export function parseWordList(lang: string, raw: string): WordList {
  const freq = new Map<string, number>();
  const letters = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const z = Number(line.slice(0, tab));
    for (const w of line.slice(tab + 1).split(' ')) {
      if (!w || freq.has(w)) continue;
      freq.set(w, z);
      if (z >= 4) for (const c of w) letters.set(c, (letters.get(c) ?? 0) + 1);
    }
  }
  // Letters that only turn up in a few loanwords would just slow generation down.
  const alphabet = [...letters].filter(([c, n]) => n >= 20 && /\p{L}/u.test(c)).map(([c]) => c);
  return { lang, zipf: (w) => freq.get(w), alphabet };
}

/** "de-AT" -> the German list. Null when the language has no list or is "auto". */
export function loadWordList(language: string | undefined): Promise<WordList | null> {
  const lang = (language ?? '').split('-')[0]!.toLowerCase();
  const file = files[`./wordfreq/${lang}.txt`];
  if (!lang || !file) return Promise.resolve(null);
  let p = loaded.get(lang);
  if (!p) {
    p = file().then(
      (raw) => parseWordList(lang, raw),
      () => null,
    );
    loaded.set(lang, p);
  }
  return p;
}
