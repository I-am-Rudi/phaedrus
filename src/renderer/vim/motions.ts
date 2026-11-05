// Vim motions over plain text. Lines are separated by "\n" (paragraph
// boundaries and hard line breaks both appear as "\n" in the editor's text index).
// All functions take and return UTF-16 offsets; ranges are [from, to).

export type CharClass = 0 | 1 | 2; // whitespace, word, punctuation

export function charClass(c: string | undefined, big = false): CharClass {
  if (c === undefined || /\s/.test(c)) return 0;
  if (big) return 1;
  return /[\p{L}\p{N}_]/u.test(c) ? 1 : 2;
}

export function lineStart(t: string, i: number): number {
  return t.lastIndexOf('\n', Math.max(0, i) - 1) + 1;
}

/** Index of the "\n" ending the line (or text length). */
export function lineEnd(t: string, i: number): number {
  const k = t.indexOf('\n', i);
  return k === -1 ? t.length : k;
}

export function firstNonBlank(t: string, i: number): number {
  let k = lineStart(t, i);
  const end = lineEnd(t, i);
  while (k < end && /[ \t]/.test(t[k]!)) k++;
  return k;
}

/** Last valid cursor position on the line (vim's normal-mode cursor sits on a character). */
export function lastCol(t: string, i: number): number {
  const s = lineStart(t, i);
  const e = lineEnd(t, i);
  return e > s ? e - 1 : s;
}

export function clampCursor(t: string, i: number): number {
  const k = Math.max(0, Math.min(i, t.length));
  return Math.min(k, lastCol(t, k));
}

export function wordForward(t: string, i: number, big = false): number {
  let k = i;
  const cls = charClass(t[k], big);
  if (cls !== 0) while (k < t.length && charClass(t[k], big) === cls) k++;
  // Stop at an empty line, like vim.
  while (k < t.length && charClass(t[k], big) === 0) {
    if (t[k] === '\n' && t[k + 1] === '\n') return k + 1;
    k++;
  }
  return k;
}

export function wordBackward(t: string, i: number, big = false): number {
  let k = i - 1;
  while (k > 0 && charClass(t[k], big) === 0) k--;
  const cls = charClass(t[k], big);
  while (k > 0 && charClass(t[k - 1], big) === cls && cls !== 0) k--;
  return Math.max(0, k);
}

export function wordEnd(t: string, i: number, big = false): number {
  let k = i + 1;
  while (k < t.length && charClass(t[k], big) === 0) k++;
  const cls = charClass(t[k], big);
  while (k + 1 < t.length && charClass(t[k + 1], big) === cls) k++;
  return Math.min(k, Math.max(0, t.length - 1));
}

/** f/F/t/T within the current line. Returns the new index or -1. */
export function findChar(t: string, i: number, ch: string, kind: 'f' | 'F' | 't' | 'T', count = 1): number {
  const s = lineStart(t, i);
  const e = lineEnd(t, i);
  let k = i;
  for (let n = 0; n < count; n++) {
    if (kind === 'f' || kind === 't') {
      k = t.indexOf(ch, k + (kind === 't' && n === 0 ? 2 : 1));
      if (k === -1 || k >= e) return -1;
    } else {
      k = t.lastIndexOf(ch, k - (kind === 'T' && n === 0 ? 2 : 1));
      if (k < s) return -1;
    }
  }
  if (kind === 't') return k - 1;
  if (kind === 'T') return k + 1;
  return k;
}

/** Start of the next / previous line block in `starts` (sorted line-block starts, e.g. paragraphs). */
export function paragraphForward(t: string, i: number, starts: number[]): number {
  return starts.find((s) => s > i) ?? t.length;
}

export function paragraphBackward(i: number, starts: number[]): number {
  for (let k = starts.length - 1; k >= 0; k--) if (starts[k]! < i) return starts[k]!;
  return 0;
}

export type TextObject = 'iw' | 'aw' | 'iW' | 'aW' | 'ip' | 'ap' | 'is' | 'as';

export function textObject(t: string, i: number, obj: TextObject, starts: number[]): [number, number] {
  const kind = obj[1]!;
  const around = obj[0] === 'a';
  if (kind === 'w' || kind === 'W') {
    const big = kind === 'W';
    const cls = charClass(t[i], big);
    let from = i;
    let to = i;
    while (from > 0 && charClass(t[from - 1], big) === cls && t[from - 1] !== '\n') from--;
    while (to < t.length && charClass(t[to], big) === cls && t[to] !== '\n') to++;
    if (around) {
      if (cls !== 0) {
        let k = to;
        while (k < t.length && /[ \t]/.test(t[k]!)) k++;
        if (k > to) to = k;
        else while (from > 0 && /[ \t]/.test(t[from - 1]!)) from--;
      } else {
        const c2 = charClass(t[to], big);
        while (to < t.length && charClass(t[to], big) === c2 && c2 !== 0) to++;
      }
    }
    return [from, to];
  }
  if (kind === 's') {
    const s = lineStart(t, i);
    const e = lineEnd(t, i);
    let from = s;
    for (let k = i - 1; k >= s; k--) {
      if (/[.!?]/.test(t[k]!) && /\s/.test(t[k + 1] ?? ' ')) {
        from = k + 1;
        break;
      }
    }
    while (from < e && /\s/.test(t[from]!)) from++;
    let to = e;
    for (let k = Math.max(i, from); k < e; k++) {
      if (/[.!?]/.test(t[k]!) && (k + 1 === e || /\s/.test(t[k + 1]!))) {
        to = k + 1;
        break;
      }
    }
    if (around) while (to < e && /[ \t]/.test(t[to]!)) to++;
    return [from, to];
  }
  // paragraph: from its start to its end; "ap" includes the following separator
  const from = paragraphBackward(i + 1, starts);
  let to = paragraphForward(t, i, starts);
  if (to > from && t[to - 1] === '\n' && !around) to--;
  return [from, to];
}

/** Next occurrence of `q` after (or before) `i`, wrapping. Smart case: case-insensitive unless q has capitals. */
export function search(t: string, i: number, q: string, backward = false): number {
  if (!q) return -1;
  const hay = /[A-Z]/.test(q) ? t : t.toLowerCase();
  const needle = /[A-Z]/.test(q) ? q : q.toLowerCase();
  if (!backward) {
    const k = hay.indexOf(needle, i + 1);
    return k !== -1 ? k : hay.indexOf(needle);
  }
  const k = i > 0 ? hay.lastIndexOf(needle, i - 1) : -1;
  return k !== -1 ? k : hay.lastIndexOf(needle);
}
