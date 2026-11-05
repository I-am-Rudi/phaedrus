// LLM suggestions point at text by quoting it; offsets drift while the user
// types, quotes don't. These helpers turn a quote back into offsets.

export interface Range {
  from: number;
  to: number;
}

const QUOTE_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '−': '-', ' ': ' ',
};

/** Normalise text for fuzzy matching and keep a map back to original indices. */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!;
    ch = QUOTE_MAP[ch] ?? ch;
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      ch = ' ';
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

/**
 * Locate `quote` in `text`. Tries an exact match, then a match that ignores
 * case, whitespace runs and typographic quotes/dashes. When the quote occurs
 * several times, the occurrence closest to `near` wins.
 */
export function findQuote(text: string, quote: string, near = 0): Range | null {
  const q = quote.trim();
  if (!q) return null;

  const exact = allIndexes(text, q);
  if (exact.length) {
    const from = closest(exact, near);
    return { from, to: from + q.length };
  }

  const t = normalizeWithMap(text);
  const n = normalizeWithMap(q).norm.trim();
  if (!n) return null;
  const hits = allIndexes(t.norm, n);
  if (!hits.length) return null;
  const start = closest(hits, near);
  const from = t.map[start]!;
  const lastIdx = t.map[start + n.length - 1]!;
  return { from, to: lastIdx + 1 };
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

function closest(xs: number[], target: number): number {
  return xs.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), xs[0]!);
}

/** Convert offsets counted in Unicode code points (Rust/Harper) to UTF-16 offsets (JS). */
export function codePointToUtf16(text: string, cp: number): number {
  let units = 0;
  let count = 0;
  for (const ch of text) {
    if (count === cp) return units;
    units += ch.length;
    count++;
  }
  return units;
}

/** Short stable hash for cache keys. */
export function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 31) + c) | 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
