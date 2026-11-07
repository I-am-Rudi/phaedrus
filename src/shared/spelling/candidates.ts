// Adds the corrections a spelling engine missed. Engines rank by edit
// distance and offer three to five words: for "papre" Harper offers "pa pre",
// not "paper". Words one or two edits away that are common in the language are
// added, but only those the engine itself accepts, because frequency lists
// also contain common misspellings ("teh", "alot").

import type { GrammarIssue } from '../types';
import { loadWordList, type WordList } from './wordlist';

/** Generated words rarer than this (once per ~3 million words) are not offered. */
const MIN_ZIPF = 2.5;
const MAX_GENERATED = 6;
/** Engine suggestions plus generated ones, before ranking. */
const MAX_CANDIDATES = 10;

const WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;

function edits1(word: string, alphabet: string[]): Set<string> {
  const out = new Set<string>();
  const chars = [...word];
  for (let i = 0; i <= chars.length; i++) {
    const a = chars.slice(0, i).join('');
    const rest = chars.slice(i);
    if (rest.length) out.add(a + rest.slice(1).join('')); // delete
    if (rest.length > 1) out.add(a + rest[1] + rest[0] + rest.slice(2).join('')); // transpose
    if (rest.length > 2) {
      // a letter two places off: "fomr" -> "from"
      out.add(a + rest[2] + rest[0] + rest[1] + rest.slice(3).join(''));
      out.add(a + rest[1] + rest[2] + rest[0] + rest.slice(3).join(''));
    }
    for (const c of alphabet) {
      if (rest.length) out.add(a + c + rest.slice(1).join('')); // replace
      out.add(a + c + rest.join('')); // insert
    }
  }
  out.delete(word);
  return out;
}

/** Listed words one edit away (two if none is one away), most frequent first. */
export function generateCandidates(typo: string, list: WordList): string[] {
  const t = typo.toLowerCase();
  if (!WORD.test(t) || [...t].length < 2) return [];
  const known = (words: Iterable<string>) => {
    const found = new Map<string, number>();
    for (const w of words) {
      const z = list.zipf(w);
      if (z !== undefined && z >= MIN_ZIPF && w !== t) found.set(w, z);
    }
    return found;
  };
  const one = edits1(t, list.alphabet);
  let found = known(one);
  if (!found.size && [...t].length >= 5) {
    const two = new Set<string>();
    for (const e of one) for (const e2 of edits1(e, list.alphabet)) two.add(e2);
    found = known(two);
  }
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, MAX_GENERATED).map(([w]) => w);
}

/** Give `word` the capitalisation of `typo`: "Teh" -> "The", "TEH" -> "THE". */
export function matchCase(typo: string, word: string): string {
  if (typo.length > 1 && typo === typo.toUpperCase() && typo !== typo.toLowerCase()) return word.toUpperCase();
  const first = typo.charAt(0);
  if (first !== first.toLowerCase() && word.charAt(0) === word.charAt(0).toLowerCase()) return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

/**
 * For each spelling issue: engine suggestions first, then generated words the
 * engine accepts, each with its frequency. `validate` returns the words (lower
 * case) the engine does not flag.
 */
export async function expandSpelling(
  issues: GrammarIssue[],
  language: string | undefined,
  validate: (words: string[]) => Promise<Set<string>>,
): Promise<GrammarIssue[]> {
  const spelling = issues.filter((i) => i.category === 'spelling');
  if (!spelling.length) return issues;
  const list = await loadWordList(language);
  if (!list) return issues;
  const generated = new Map<GrammarIssue, string[]>();
  const ask = new Set<string>();
  for (const issue of spelling) {
    const offered = new Set(issue.replacements.map((r) => r.toLowerCase()));
    const extra = generateCandidates(issue.text, list).filter((w) => !offered.has(w));
    generated.set(issue, extra);
    for (const w of extra) ask.add(w);
  }
  let valid = new Set<string>();
  if (ask.size) {
    try {
      valid = await validate([...ask]);
    } catch {
      valid = new Set(); // without the engine's word, offer only its own suggestions
    }
  }
  return issues.map((issue) => {
    const extra = generated.get(issue);
    if (!extra) return issue;
    const replacements = [...issue.replacements, ...extra.filter((w) => valid.has(w)).map((w) => matchCase(issue.text, w))].slice(0, MAX_CANDIDATES);
    return {
      ...issue,
      replacements,
      engineCount: issue.replacements.length,
      zipf: replacements.map((r) => list.zipf(r.toLowerCase()) ?? null),
    };
  });
}
