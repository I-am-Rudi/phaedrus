// LaTeX-aware text for the checks. Turns a paragraph containing LaTeX (or
// Markdown math) into plain prose, and keeps a map from every character of
// that prose back to the original, so issues found in the prose can be placed
// on the original text.
//
//   inline math  $..$, \(..\)            -> "X"         (a word, so sentences stay grammatical)
//   display math $$..$$, \[..\], math environments -> "X"
//   \emph{w} \textbf{w} \section{w} ...    -> w          (the argument is prose)
//   \ref{..} \eqref{..} \cref{..}          -> "1"
//   \citet{..} \textcite{..}               -> "Smith"    (they print an author name)
//   \cite{..} \label{..} \footnote{..} other commands, % comments -> removed
//   \% \$ \& \# \_ \{ \}  ~  `` ''          -> the character they stand for
//
// In "prose" mode (for extraction) inline math is kept verbatim and display
// math becomes "[equation]", so the model sees how authors weave equations in.

import type { Range } from './spans';

export type MaskMode = 'check' | 'prose';
export type RegionKind = 'math' | 'ref' | 'command' | 'comment';

export interface LatexRegion extends Range {
  kind: RegionKind;
}

export interface Masked {
  /** Prose to check. */
  text: string;
  /** For each character of `text`, its index in the original. */
  map: number[];
  /** For each character of `text`, true if it was inserted (placeholder), not copied. */
  synthetic: boolean[];
  /** Original ranges that are LaTeX markup rather than prose. */
  regions: LatexRegion[];
}

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*',
  'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*', 'dmath', 'dmath*',
]);
const SKIP_ENVS = new Set(['verbatim', 'lstlisting', 'minted', 'tikzpicture', 'comment', 'tabular', 'table', 'thebibliography']);
const TEXT_ARG = new Set([
  'emph', 'textbf', 'textit', 'textsc', 'texttt', 'textrm', 'textsf', 'textup', 'textsl', 'textnormal', 'underline', 'mbox',
  'text', 'enquote', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'caption', 'title',
  'emph*', 'section*', 'subsection*', 'subsubsection*', 'chapter*',
]);
const REF = new Set(['ref', 'eqref', 'cref', 'Cref', 'autoref', 'pageref', 'vref', 'nameref']);
const AUTHOR_CITE = new Set(['citet', 'textcite', 'citeauthor', 'Citet', 'Textcite']);
const REMOVE_WITH_ARGS = new Set([
  'cite', 'citep', 'citealp', 'parencite', 'autocite', 'footcite', 'nocite', 'label', 'footnote', 'footnotemark', 'footnotetext',
  'vspace', 'hspace', 'includegraphics', 'bibliography', 'bibliographystyle', 'usepackage', 'documentclass', 'input', 'include',
  'newcommand', 'renewcommand', 'providecommand', 'DeclareMathOperator', 'setlength', 'addbibresource', 'index', 'url',
]);
const ESCAPES: Record<string, string> = { '%': '%', $: '$', '&': '&', '#': '#', _: '_', '{': '{', '}': '}', ' ': ' ' };

class Builder {
  text = '';
  map: number[] = [];
  synthetic: boolean[] = [];
  regions: LatexRegion[] = [];

  copy(from: number, to: number, src: string) {
    for (let i = from; i < to; i++) {
      this.text += src[i];
      this.map.push(i);
      this.synthetic.push(false);
    }
  }

  /** Replace src[from, to) with `out`; the inserted characters map to `from`. */
  replace(from: number, to: number, out: string, kind: RegionKind | null) {
    if (kind && to > from) this.regions.push({ from, to, kind });
    for (const ch of out) {
      this.text += ch;
      this.map.push(from);
      this.synthetic.push(true);
    }
  }

  get lastChar(): string {
    return this.text[this.text.length - 1] ?? '';
  }
}

/** Index after the brace group starting at `i` (src[i] === '{'), or -1. */
function skipGroup(src: string, i: number, open = '{', close = '}'): number {
  if (src[i] !== open) return -1;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return src.length;
}

function skipSpaces(src: string, i: number): number {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  return i;
}

/** Skip optional [..] groups and up to `n` {..} groups after a command. */
function skipArgs(src: string, i: number, n = Infinity): number {
  let j = i;
  let groups = 0;
  for (;;) {
    const k = skipSpaces(src, j);
    if (src[k] === '[') j = skipGroup(src, k, '[', ']');
    else if (src[k] === '{' && groups < n) {
      j = skipGroup(src, k);
      groups++;
    } else return j;
  }
}

function findEnd(src: string, from: number, token: string): number {
  const k = src.indexOf(token, from);
  return k === -1 ? src.length : k + token.length;
}

/** Pandoc's rule: opening $ not followed by space, closing $ not preceded by space nor followed by a digit. */
function inlineDollarEnd(src: string, i: number): number {
  if (!src[i + 1] || /\s/.test(src[i + 1]!)) return -1;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n' && src[j + 1] === '\n') return -1;
    if (c === '$') {
      if (/\s/.test(src[j - 1]!) || /\d/.test(src[j + 1] ?? '')) return -1;
      return j + 1;
    }
  }
  return -1;
}

export function maskLatex(src: string, mode: MaskMode = 'check'): Masked {
  const b = new Builder();
  const mathOut = (display: boolean, from: number, to: number) => {
    if (mode === 'prose') {
      if (display) b.replace(from, to, ' [equation] ', 'math');
      else {
        b.regions.push({ from, to, kind: 'math' });
        b.copy(from, to, src);
      }
    } else {
      b.replace(from, to, 'X', 'math');
    }
  };
  /** Remove src[from,to); swallow a following space if that would leave two in a row. */
  const remove = (from: number, to: number, kind: RegionKind): number => {
    let end = to;
    if ((b.lastChar === ' ' || b.lastChar === '' || b.lastChar === '\n') && (src[end] === ' ' || src[end] === '\t')) {
      end = skipSpaces(src, end);
    }
    b.replace(from, end, '', kind);
    return end;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (c === '%') {
      const nl = src.indexOf('\n', i);
      i = remove(i, nl === -1 ? src.length : nl, 'comment');
      continue;
    }

    if (c === '$') {
      if (src[i + 1] === '$') {
        const end = findEnd(src, i + 2, '$$');
        mathOut(true, i, end);
        i = end;
        continue;
      }
      const end = inlineDollarEnd(src, i);
      if (end !== -1) {
        mathOut(false, i, end);
        i = end;
        continue;
      }
      b.copy(i, i + 1, src);
      i++;
      continue;
    }

    if (c === '~') {
      b.replace(i, i + 1, ' ', null);
      i++;
      continue;
    }
    if ((c === '`' && src[i + 1] === '`') || (c === "'" && src[i + 1] === "'")) {
      b.replace(i, i + 2, '"', null);
      i += 2;
      continue;
    }

    if (c !== '\\') {
      b.copy(i, i + 1, src);
      i++;
      continue;
    }

    // ---- backslash
    const next = src[i + 1] ?? '';
    if (next === '\\') {
      b.replace(i, skipArgs(src, i + 2, 0), ' ', 'command');
      i = skipArgs(src, i + 2, 0);
      continue;
    }
    if (next in ESCAPES) {
      b.replace(i, i + 2, ESCAPES[next]!, null);
      i += 2;
      continue;
    }
    if (next === '(' || next === '[') {
      const end = findEnd(src, i + 2, next === '(' ? '\\)' : '\\]');
      mathOut(next === '[', i, end);
      i = end;
      continue;
    }
    const m = /^\\([a-zA-Z@]+\*?)/.exec(src.slice(i, i + 40));
    if (!m) {
      // Accent or symbol command like \' or \,: drop it.
      i = remove(i, i + 2, 'command');
      continue;
    }
    const name = m[1]!;
    const afterName = i + m[0].length;

    if (name === 'begin' || name === 'end') {
      const k = skipSpaces(src, afterName);
      const argEnd = skipGroup(src, k);
      const env = argEnd > k ? src.slice(k + 1, argEnd - 1).trim() : '';
      if (name === 'begin' && MATH_ENVS.has(env)) {
        const end = findEnd(src, argEnd, `\\end{${env}}`);
        mathOut(true, i, end);
        i = end;
      } else if (name === 'begin' && SKIP_ENVS.has(env)) {
        i = remove(i, findEnd(src, argEnd, `\\end{${env}}`), 'command');
      } else {
        i = remove(i, argEnd > k ? skipArgs(src, argEnd, 0) : afterName, 'command');
      }
      continue;
    }

    if (TEXT_ARG.has(name)) {
      const k = skipArgs(src, afterName, 0);
      const open = skipSpaces(src, k);
      const close = skipGroup(src, open);
      if (close === -1) {
        i = remove(i, k, 'command');
        continue;
      }
      // Drop "\cmd{", keep the argument (it may contain more markup), drop "}".
      b.replace(i, open + 1, '', 'command');
      const inner = maskLatex(src.slice(open + 1, close - 1), mode);
      for (let j = 0; j < inner.text.length; j++) {
        b.text += inner.text[j];
        b.map.push(open + 1 + inner.map[j]!);
        b.synthetic.push(inner.synthetic[j]!);
      }
      for (const r of inner.regions) b.regions.push({ from: r.from + open + 1, to: r.to + open + 1, kind: r.kind });
      b.replace(close - 1, close, '', 'command');
      i = close;
      continue;
    }

    if (name === 'href') {
      const urlEnd = skipGroup(src, skipSpaces(src, afterName));
      const open = skipSpaces(src, urlEnd);
      const close = skipGroup(src, open);
      if (urlEnd !== -1 && close !== -1) {
        b.replace(i, open + 1, '', 'command');
        b.copy(open + 1, close - 1, src);
        b.replace(close - 1, close, '', 'command');
        i = close;
        continue;
      }
    }

    const argsEnd = skipArgs(src, afterName);
    if (REF.has(name)) {
      b.replace(i, argsEnd, mode === 'prose' ? '[ref]' : '1', 'ref');
      i = argsEnd;
    } else if (AUTHOR_CITE.has(name)) {
      b.replace(i, argsEnd, mode === 'prose' ? '[author]' : 'Smith', 'ref');
      i = argsEnd;
    } else if (REMOVE_WITH_ARGS.has(name) || name === 'item' || argsEnd > afterName) {
      i = remove(i, argsEnd, name.startsWith('cite') || name === 'label' ? 'ref' : 'command');
    } else {
      // Argument-less macro (\LaTeX, \eg, \noindent): drop it, and a following "{}".
      const end = src.startsWith('{}', afterName) ? afterName + 2 : afterName;
      i = remove(i, end, 'command');
    }
  }
  return { text: b.text, map: b.map, synthetic: b.synthetic, regions: b.regions };
}

/** True if the text contains anything the masker would change. */
export function hasLatex(text: string): boolean {
  return /[\\$%~]|``|''/.test(text);
}

/**
 * Run a checker on masked prose and map its findings back. Findings that touch
 * a placeholder or LaTeX markup are dropped: they are about the markup, not the prose.
 */
export function mapBack<T extends { from: number; to: number }>(masked: Masked, original: string, issues: T[]): (T & { text: string })[] {
  const out: (T & { text: string })[] = [];
  for (const issue of issues) {
    if (issue.to <= issue.from || issue.to > masked.text.length) continue;
    let touchesMarkup = false;
    for (let k = issue.from; k < issue.to; k++) if (masked.synthetic[k]) touchesMarkup = true;
    if (touchesMarkup) continue;
    const from = masked.map[issue.from]!;
    const to = masked.map[issue.to - 1]! + 1;
    if (masked.regions.some((r) => r.kind !== 'comment' && from < r.to && r.from < to)) continue;
    out.push({ ...issue, from, to, text: original.slice(from, to) });
  }
  return out;
}

/** Math and references in a passage, which a rewrite of it has to keep. */
export function protectedTokens(passage: string): string[] {
  const m = maskLatex(passage);
  return m.regions.filter((r) => r.kind === 'math' || r.kind === 'ref').map((r) => passage.slice(r.from, r.to));
}

const squash = (s: string) => s.replace(/\s+/g, '');

/** True if `rewrite` keeps every math and reference token of `original` verbatim (ignoring whitespace). */
export function rewriteKeepsLatex(original: string, rewrite: string): boolean {
  const target = squash(rewrite);
  return protectedTokens(original).every((t) => target.includes(squash(t)));
}

/** Prose with LaTeX removed, for measuring and length checks. */
export function proseOf(text: string): string {
  return hasLatex(text) ? maskLatex(text).text : text;
}
