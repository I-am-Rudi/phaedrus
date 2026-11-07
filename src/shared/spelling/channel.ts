// How costly it is to have typed `typo` when `word` was meant: an edit
// distance whose steps cost less when they are common slips. A missing letter
// costs 1; a stray letter or a wrong key away from the right one costs a
// little more, a neighbouring key or two swapped letters a lot less.

import { areNeighbours, isLayoutSwap, type KeyboardLayout } from './keyboard';

export interface ChannelOptions {
  layout: KeyboardLayout;
  /**
   * Slips this writer has made before, "intended>typed" -> times seen (from
   * the corrections they chose). Seen at least twice, they cost half.
   */
  pairs?: Map<string, number>;
}

export const COST = {
  /** A letter typed for another one away from it on the keyboard. */
  substitute: 1.2,
  /** A neighbouring key. */
  neighbour: 0.6,
  /** A letter and its accented form (a, ä; e, é). */
  accent: 0.3,
  /** y and z on a German layout used as if it were US English, and similar. */
  layoutSwap: 0.25,
  /** Two letters in the wrong order. */
  transpose: 0.6,
  /** A letter typed two places early or late ("fomr" for "from"). */
  moved: 0.9,
  /** A letter left out. */
  omit: 1,
  /** One of a pair of double letters left out ("hapen"). */
  omitDouble: 0.5,
  /** An extra letter that is neither a double nor next to its neighbours on the keyboard. */
  extra: 1.3,
  /** A letter typed twice ("untill"). */
  extraDouble: 0.5,
  /** An extra key next to the one meant, hit at the same time. */
  extraNeighbour: 0.7,
} as const;

const base = (c: string) => c.normalize('NFD').charAt(0);

function substitutionCost(intended: string, typed: string, opts: ChannelOptions): number {
  if (intended === typed) return 0;
  let cost: number;
  if (base(intended) === base(typed)) cost = COST.accent;
  else if (isLayoutSwap(intended, typed, opts.layout)) cost = COST.layoutSwap;
  else if (areNeighbours(intended, typed, opts.layout)) cost = COST.neighbour;
  else cost = COST.substitute;
  if ((opts.pairs?.get(`${intended}>${typed}`) ?? 0) >= 2) cost = Math.max(0.15, cost / 2);
  return cost;
}

/** Weighted edit distance from `word` (meant) to `typo` (typed), case-insensitive. */
export function typoCost(typo: string, word: string, opts: ChannelOptions): number {
  const t = [...typo.toLowerCase()];
  const w = [...word.toLowerCase()];
  const rows = w.length + 1;
  const cols = t.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i++) d[i]![0] = d[i - 1]![0]! + (w[i - 1] === w[i - 2] ? COST.omitDouble : COST.omit);
  for (let j = 1; j < cols; j++) d[0]![j] = d[0]![j - 1]! + extraCost(t, j - 1, opts);
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const wi = w[i - 1]!;
      const tj = t[j - 1]!;
      let best = Math.min(
        d[i - 1]![j]! + (wi === w[i - 2] ? COST.omitDouble : COST.omit), // the meant letter is missing
        d[i]![j - 1]! + extraCost(t, j - 1, opts), // an extra letter was typed
        d[i - 1]![j - 1]! + substitutionCost(wi, tj, opts),
      );
      if (i > 1 && j > 1 && wi === t[j - 2] && w[i - 2] === tj && wi !== tj) best = Math.min(best, d[i - 2]![j - 2]! + COST.transpose);
      if (i > 2 && j > 2 && isMove(w.slice(i - 3, i), t.slice(j - 3, j))) best = Math.min(best, d[i - 3]![j - 3]! + COST.moved);
      d[i]![j] = best;
    }
  }
  return d[w.length]![t.length]!;
}

/** "abc" typed as "bca" or "cab": one letter two places off. */
function isMove(w: string[], t: string[]): boolean {
  const [a, b, c] = w;
  const [x, y, z] = t;
  if (a === b && b === c) return false;
  return (x === b && y === c && z === a) || (x === c && y === a && z === b);
}

/** Cost of the extra letter t[k]: cheaper when it doubles its neighbour or sits next to it on the keyboard. */
function extraCost(t: string[], k: number, opts: ChannelOptions): number {
  const c = t[k]!;
  const prev = t[k - 1];
  const next = t[k + 1];
  if (c === prev || c === next) return COST.extraDouble;
  if ((prev && areNeighbours(c, prev, opts.layout)) || (next && areNeighbours(c, next, opts.layout))) return COST.extraNeighbour;
  return COST.extra;
}
