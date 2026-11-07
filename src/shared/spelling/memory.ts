// Corrections the writer chose, kept in Settings: the next time the same typo
// turns up, the same word comes first, and slips the writer keeps making (y for
// z, say) count as cheap for other words too.

export type SpellingMemory = Record<string, Record<string, number>>;

/** Typos remembered; the least used are forgotten first. */
export const MEMORY_LIMIT = 2000;

export function rememberChoice(memory: SpellingMemory, typo: string, word: string): SpellingMemory {
  const t = typo.toLowerCase();
  const w = word.toLowerCase();
  if (!t || !w || t === w || /\s/.test(t)) return memory;
  const next: SpellingMemory = { ...memory, [t]: { ...(memory[t] ?? {}), [w]: (memory[t]?.[w] ?? 0) + 1 } };
  const keys = Object.keys(next);
  if (keys.length > MEMORY_LIMIT) {
    const total = (k: string) => Object.values(next[k]!).reduce((a, b) => a + b, 0);
    keys
      .filter((k) => k !== t)
      .sort((a, b) => total(a) - total(b))
      .slice(0, keys.length - MEMORY_LIMIT)
      .forEach((k) => delete next[k]);
  }
  return next;
}

/**
 * Single-letter slips in the remembered corrections, "intended>typed" ->
 * times: "zou" corrected to "you" counts "y>z".
 */
export function learnedPairs(memory: SpellingMemory | undefined): Map<string, number> {
  const pairs = new Map<string, number>();
  for (const [typo, words] of Object.entries(memory ?? {})) {
    const t = [...typo];
    for (const [word, times] of Object.entries(words)) {
      const w = [...word];
      if (w.length !== t.length) continue;
      const diff = w.flatMap((c, i) => (c !== t[i] ? [i] : []));
      if (diff.length !== 1) continue;
      const key = `${w[diff[0]!]}>${t[diff[0]!]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + times);
    }
  }
  return pairs;
}
