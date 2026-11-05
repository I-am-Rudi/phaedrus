const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'as', 'is', 'are',
  'be', 'it', 'its', 'that', 'this', 'from', 'into', 'over', 'than', 'then', 'use', 'uses', 'using',
]);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOP.has(w) || w.length < 2) continue;
    // crude stemming so "sentences"/"sentence" and "opening"/"openers" meet
    out.add(w.replace(/(ings?|ers?|es|s)$/, '') || w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity of two moves by title, with a little help from the description. */
export function moveSimilarity(a: { title: string; description: string }, b: { title: string; description: string }): number {
  const t = jaccard(tokens(a.title), tokens(b.title));
  const d = jaccard(tokens(a.description), tokens(b.description));
  return Math.max(t, 0.7 * t + 0.3 * d, d > 0.6 ? d : 0);
}

export const SIMILAR = 0.5;
