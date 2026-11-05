// Modal (vim) editing for the TipTap editor.
//
// Normal mode: counts, motions (h j k l w b e W B E 0 ^ $ gg G { } f F t T ; , n N),
// operators (d c y with a motion, a text object iw aw iW aW is as ip ap, or doubled),
// x X D C s S r J ~ p P u Ctrl-r i a I A o O v V / ? : Ctrl-d Ctrl-u zz.
// Phaedrus keys: ]s [s next/previous issue, z= open it (then 1-9 to pick),
// zg add word, za accept, zd dismiss, zr not for me, zc check my revision,
// Ctrl-w l suggestion panel, gt gT next/previous view.

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  clampCursor, findChar, firstNonBlank, lastCol, lineEnd, lineStart, paragraphBackward, paragraphForward, search, textObject,
  wordBackward, wordEnd, wordForward, type TextObject,
} from './motions';
import { textIndex, type TextIndex } from './textIndex';

export type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line';
export type IssueAction = 'next' | 'prev' | 'open' | 'pick' | 'accept' | 'dismiss' | 'reject' | 'check' | 'addword';

export interface VimActions {
  prompt(prefix: string, onSubmit: (value: string) => void): void;
  command(line: string): void;
  issue(action: IssueAction, n?: number): void;
  panel(): void;
  view(dir: 1 | -1): void;
  leader(): void;
  /** Keys for the open suggestion popover; returns true if it consumed the key. */
  popoverKey(key: string): boolean;
  /** True if the cursor is on an underlined passage. */
  onIssue(): boolean;
}

type Op = 'd' | 'c' | 'y';
interface Motion {
  to: number;
  inclusive?: boolean;
  linewise?: boolean;
}

const vimKey = new PluginKey('vim');

export class Vim {
  enabled = false;
  mode: VimMode = 'normal';
  focused = false;
  private count = '';
  private op: Op | null = null;
  private opCount = '';
  private prefix: string | null = null;
  private picking = false;
  private register = { text: '', linewise: false };
  private lastFind: { ch: string; kind: 'f' | 'F' | 't' | 'T' } | null = null;
  private lastSearch: { q: string; backward: boolean } | null = null;
  private anchor = 0;
  private head = 0;
  private goalX: number | null = null;
  private listeners = new Set<() => void>();
  private escape = { sequence: '', timeoutMs: 300, ctrlC: true };
  private typed: { ch: string; t: number }[] = [];

  /** Remapped Escape: an insert-mode key sequence (jk, jj, ...) and/or Ctrl-c. */
  setEscape(opts: { sequence: string; timeoutMs: number; ctrlC: boolean }) {
    this.escape = { ...opts, sequence: [...opts.sequence.trim()].slice(0, 4).join('') };
    this.typed = [];
  }

  /** Insert mode: does this key complete the escape sequence? Removes the already-typed part. */
  private escapeSequence(e: KeyboardEvent): boolean {
    const seq = this.escape.sequence;
    if (seq.length < 2 || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
      this.typed = [];
      return false;
    }
    const now = performance.now();
    const last = this.typed[this.typed.length - 1];
    if (last && now - last.t > this.escape.timeoutMs) this.typed = [];
    this.typed.push({ ch: e.key, t: now });
    if (this.typed.length > seq.length) this.typed = this.typed.slice(-seq.length);
    if (this.typed.map((x) => x.ch).join('') !== seq) return false;
    const before = seq.slice(0, -1);
    const { state } = this.editor;
    const head = state.selection.head;
    const from = head - before.length;
    if (from < 0 || state.doc.textBetween(from, head, '\n') !== before) {
      this.typed = [];
      return false;
    }
    this.editor.view.dispatch(state.tr.delete(from, head));
    this.typed = [];
    return true;
  }

  private editor!: Editor;

  constructor(private actions: VimActions) {}

  attach(editor: Editor) {
    this.editor = editor;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Keys typed so far in a pending command, for the status line. */
  get pending(): string {
    return `${this.count}${this.op ?? ''}${this.opCount}${this.prefix ?? ''}${this.picking ? 'z=' : ''}`;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.reset();
    this.setMode(on ? 'normal' : 'insert');
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private refresh() {
    if (this.editor && !this.editor.isDestroyed) this.editor.view.dispatch(this.editor.state.tr.setMeta(vimKey, true));
  }

  private setMode(mode: VimMode) {
    this.mode = mode;
    this.goalX = null;
    this.refresh();
    this.emit();
  }

  private reset() {
    this.count = '';
    this.op = null;
    this.opCount = '';
    this.prefix = null;
    this.picking = false;
  }

  // ------------------------------------------------------------ helpers

  private get ti(): TextIndex {
    return textIndex(this.editor.state.doc);
  }

  private get cursor(): number {
    if (this.mode === 'visual' || this.mode === 'visual-line') return this.head;
    return this.ti.indexAt(this.editor.state.selection.head);
  }

  private setCursor(i: number, clamp = true) {
    const ti = this.ti;
    const k = clamp ? clampCursor(ti.text, i) : Math.max(0, Math.min(i, ti.text.length));
    const pos = ti.posAt(k);
    const tr = this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, pos)).scrollIntoView();
    this.editor.view.dispatch(tr);
  }

  private setVisualSelection() {
    const ti = this.ti;
    const t = ti.text;
    let a = Math.min(this.anchor, this.head);
    let b = Math.max(this.anchor, this.head) + 1;
    if (this.mode === 'visual-line') {
      a = lineStart(t, a);
      b = lineEnd(t, b - 1);
    }
    b = Math.min(b, t.length);
    const doc = this.editor.state.doc;
    const tr = this.editor.state.tr.setSelection(TextSelection.create(doc, ti.posAt(a), ti.posAt(b))).scrollIntoView();
    this.editor.view.dispatch(tr);
  }

  private n(): number {
    return (parseInt(this.count || '1', 10) || 1) * (parseInt(this.opCount || '1', 10) || 1);
  }

  private yankToClipboard(text: string) {
    try {
      void navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      /* clipboard unavailable */
    }
  }

  // ------------------------------------------------------------ keys

  /** Returns true if the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.enabled || e.isComposing) return false;
    const key = tokenize(e);
    if (!key) return false;

    if (key === '<C-c>' && !this.escape.ctrlC) return false;
    if (this.mode === 'insert') {
      if (key === '<Esc>' || key === '<C-[>' || key === '<C-c>' || this.escapeSequence(e)) {
        const t = this.ti.text;
        const i = this.cursor;
        this.setMode('normal');
        this.setCursor(i > lineStart(t, i) ? i - 1 : i);
        return true;
      }
      return false;
    }
    if (this.mode === 'normal' && !this.pending && this.actions.popoverKey(key)) return true;

    if (this.picking) {
      this.picking = false;
      if (/^[1-9]$/.test(key)) {
        this.actions.issue('pick', Number(key));
        this.emit();
        return true;
      }
    }
    try {
      this.process(key);
    } finally {
      this.emit();
    }
    return true;
  }

  private process(key: string) {
    if (key === '<Esc>' || key === '<C-[>' || key === '<C-c>') {
      const wasVisual = this.mode !== 'normal';
      this.reset();
      if (wasVisual) this.exitVisual();
      return;
    }
    const visual = this.mode === 'visual' || this.mode === 'visual-line';

    if (this.prefix) {
      const p = this.prefix;
      this.prefix = null;
      this.withPrefix(p, key, visual);
      return;
    }

    // counts
    if (/^[1-9]$/.test(key) || (key === '0' && (this.op ? this.opCount : this.count))) {
      if (this.op) this.opCount += key;
      else this.count += key;
      return;
    }

    if (!this.op && !this.count && !visual) {
      if (key === ' ') return this.actions.leader();
      if (key === 'Tab') return this.actions.issue('next', 1);
      if (key === '<S-Tab>') return this.actions.issue('prev', 1);
      if (key === 'K' || ((key === 'Enter' || key === '<CR>') && this.actions.onIssue())) return this.actions.issue('open');
    }
    if (key === 'Tab' || key === '<S-Tab>') return;

    if (['g', 'z', ']', '[', 'f', 'F', 't', 'T', 'r', '<C-w>'].includes(key) && !(visual && key === 'r')) {
      this.prefix = key;
      return;
    }

    if (this.op) {
      if (key === this.op) return this.applyLines(this.op, this.cursor, this.n() - 1);
      if (key === 'i' || key === 'a') {
        this.prefix = key;
        return;
      }
      const m = this.motion(key, this.cursor, this.n(), this.op);
      if (m) this.applyMotion(this.op, this.cursor, m);
      this.reset();
      return;
    }

    if (visual) return this.visualKey(key);

    if (['d', 'c', 'y'].includes(key)) {
      this.op = key as Op;
      return;
    }

    const m = this.motion(key, this.cursor, this.n(), null);
    if (m) {
      if (key !== 'j' && key !== 'k') this.goalX = null;
      this.setCursor(m.to);
      this.reset();
      return;
    }
    this.command(key);
    this.reset();
  }

  private withPrefix(p: string, key: string, visual: boolean) {
    const i = this.cursor;
    const n = this.n();
    if (p === 'i' || p === 'a') {
      const [from, to] = textObject(this.ti.text, i, `${p}${key}` as TextObject, this.ti.blockStarts);
      if (this.op && to > from) this.applyRange(this.op, from, to, key === 'p');
      this.reset();
      return;
    }
    if (p === 'f' || p === 'F' || p === 't' || p === 'T') {
      if (key.length !== 1) return this.reset();
      this.lastFind = { ch: key, kind: p };
      const to = findChar(this.ti.text, i, key, p, n);
      if (to !== -1) this.dispatchMotion({ to, inclusive: p === 'f' || p === 't' }, visual);
      this.reset();
      return;
    }
    if (p === 'r') {
      if (key.length === 1) this.replaceChars(i, key, n);
      this.reset();
      return;
    }
    const combo = p + key;
    this.reset();
    switch (combo) {
      case 'gg':
        return this.dispatchMotion(this.lineMotion(this.count ? n - 1 : 0), visual);
      case 'gj':
        return this.dispatchMotion({ to: this.screenLine(i, n) }, visual);
      case 'gk':
        return this.dispatchMotion({ to: this.screenLine(i, -n) }, visual);
      case 'gt':
        return this.actions.view(1);
      case 'gT':
        return this.actions.view(-1);
      case ']s':
        return this.actions.issue('next', n);
      case '[s':
        return this.actions.issue('prev', n);
      case 'z=':
        this.actions.issue('open');
        this.picking = true;
        return;
      case 'zg':
        return this.actions.issue('addword');
      case 'za':
        return this.actions.issue('accept');
      case 'zd':
        return this.actions.issue('dismiss');
      case 'zr':
        return this.actions.issue('reject');
      case 'zc':
        return this.actions.issue('check');
      case 'zz':
        return this.center();
      case '<C-w>l':
      case '<C-w><C-l>':
        return this.actions.panel();
      default:
        return;
    }
  }

  /** Apply a motion either as a cursor move, a visual extension, or (with an operator) a range. */
  private dispatchMotion(m: Motion, visual: boolean) {
    const i = this.cursor;
    if (this.op) return this.applyMotion(this.op, i, m);
    if (visual) {
      this.head = Math.max(0, Math.min(m.to, this.ti.text.length - 1));
      return this.setVisualSelection();
    }
    this.setCursor(m.to);
  }

  private lineMotion(line: number): Motion {
    const t = this.ti.text;
    let k = 0;
    for (let l = 0; l < line; l++) {
      const nl = t.indexOf('\n', k);
      if (nl === -1) break;
      k = nl + 1;
    }
    return { to: firstNonBlank(t, k), linewise: true };
  }

  /** Move by visual (wrapped) lines, keeping the horizontal goal column. */
  private screenLine(i: number, delta: number): number {
    const view = this.editor.view;
    const ti = this.ti;
    let k = i;
    try {
      const start = view.coordsAtPos(ti.posAt(k));
      this.goalX ??= start.left;
      for (let s = 0; s < Math.abs(delta); s++) {
        const c = view.coordsAtPos(ti.posAt(k));
        const y = delta > 0 ? c.bottom + 4 : c.top - 4;
        const hit = view.posAtCoords({ left: this.goalX, top: y });
        let next = hit ? ti.indexAt(hit.pos) : -1;
        if (next === -1 || next === k) {
          // Outside the viewport or stuck: fall back to logical lines.
          next = logicalLine(ti.text, k, delta > 0 ? 1 : -1);
        }
        if (next === k) break;
        k = next;
      }
    } catch {
      k = logicalLine(ti.text, k, delta);
    }
    return clampCursor(ti.text, k);
  }

  private motion(key: string, i: number, n: number, op: Op | null): Motion | null {
    const ti = this.ti;
    const t = ti.text;
    const repeat = (f: (k: number) => number) => {
      let k = i;
      for (let s = 0; s < n; s++) k = f(k);
      return k;
    };
    switch (key) {
      case 'h':
      case '<BS>':
      case 'ArrowLeft':
        return { to: Math.max(lineStart(t, i), i - n) };
      case 'l':
      case 'ArrowRight':
        return { to: Math.min(op ? lineEnd(t, i) : lastCol(t, i), i + n) };
      case 'w':
      case 'W': {
        const big = key === 'W';
        if (op === 'c' && /\S/.test(t[i] ?? '')) return { to: repeat((k) => wordEnd(t, k === i ? k - 1 : k, big)), inclusive: true };
        let to = repeat((k) => wordForward(t, k, big));
        if (op) {
          const nl = t.indexOf('\n', i);
          if (nl !== -1 && nl < to && nl > i) to = nl;
        }
        return { to };
      }
      case 'b':
      case 'B':
        return { to: repeat((k) => wordBackward(t, k, key === 'B')) };
      case 'e':
      case 'E':
        return { to: repeat((k) => wordEnd(t, k, key === 'E')), inclusive: true };
      case '0':
      case 'Home':
        return { to: lineStart(t, i) };
      case '^':
        return { to: firstNonBlank(t, i) };
      case '$':
      case 'End': {
        let k = i;
        for (let s = 1; s < n; s++) k = Math.min(t.length, lineEnd(t, k) + 1);
        const e = lineEnd(t, k);
        return op ? { to: e } : { to: Math.max(lineStart(t, k), e - 1) };
      }
      case 'G':
        return this.count ? this.lineMotion(n - 1) : { ...this.lineMotion(Number.MAX_SAFE_INTEGER), linewise: true };
      case 'j':
      case 'ArrowDown':
      case '<C-d>':
      case 'k':
      case 'ArrowUp':
      case '<C-u>': {
        const down = key === 'j' || key === 'ArrowDown' || key === '<C-d>';
        const steps = key.startsWith('<C-') ? 12 : n;
        if (op) return { to: logicalLine(t, i, down ? steps : -steps), linewise: true };
        return { to: this.screenLine(i, down ? steps : -steps) };
      }
      case '}':
        return { to: repeat((k) => paragraphForward(t, k, ti.blockStarts)) };
      case '{':
        return { to: repeat((k) => paragraphBackward(k, ti.blockStarts)) };
      case ';':
      case ',': {
        if (!this.lastFind) return null;
        const flip: Record<string, 'f' | 'F' | 't' | 'T'> = { f: 'F', F: 'f', t: 'T', T: 't' };
        const kind = key === ';' ? this.lastFind.kind : flip[this.lastFind.kind]!;
        const to = findChar(t, i, this.lastFind.ch, kind, n);
        return to === -1 ? null : { to, inclusive: kind === 'f' || kind === 't' };
      }
      case 'n':
      case 'N': {
        if (!this.lastSearch) return null;
        const backward = key === 'N' ? !this.lastSearch.backward : this.lastSearch.backward;
        const to = repeat((k) => {
          const r = search(t, k, this.lastSearch!.q, backward);
          return r === -1 ? k : r;
        });
        return { to };
      }
      default:
        return null;
    }
  }

  private applyMotion(op: Op, from: number, m: Motion) {
    if (m.linewise) {
      const t = this.ti.text;
      const a = Math.min(from, m.to);
      const b = Math.max(from, m.to);
      let lines = 0;
      for (let k = a; k < b; k++) if (t[k] === '\n') lines++;
      return this.applyLines(op, a, lines);
    }
    const a = Math.min(from, m.to);
    let b = Math.max(from, m.to);
    if (m.inclusive) b += 1;
    b = Math.min(b, this.ti.text.length);
    if (b > a) this.applyRange(op, a, b, false);
    else this.reset();
  }

  /** Operator on `extra + 1` whole lines starting at the line of `i`. */
  private applyLines(op: Op, i: number, extra: number) {
    const t = this.ti.text;
    const from = lineStart(t, i);
    let end = lineEnd(t, i);
    for (let s = 0; s < extra && end < t.length; s++) end = lineEnd(t, end + 1);
    this.applyRange(op, from, end, true);
  }

  private applyRange(op: Op, from: number, to: number, linewise: boolean) {
    const ti = this.ti;
    const t = ti.text;
    const text = t.slice(from, to);
    this.register = { text, linewise };
    this.yankToClipboard(text);
    this.reset();

    if (op === 'y') {
      if (this.mode !== 'normal') this.exitVisual(false);
      this.setCursor(from);
      return;
    }

    const state = this.editor.state;
    let tr = state.tr;
    if (linewise && op === 'd') {
      const first = ti.blockAt(from);
      const last = ti.blockAt(Math.max(from, to - 1));
      const wholeBlocks = from === first.startIndex && to === last.endIndex;
      if (wholeBlocks) {
        if (first.pos === 0 && last.end === state.doc.content.size) {
          tr = tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph!.create());
        } else {
          tr = tr.delete(first.pos, last.end);
        }
      } else {
        // lines inside a block (hard breaks): take one adjacent line break with them
        const a = to < t.length ? from : Math.max(0, from - 1);
        const b = to < t.length ? to + 1 : to;
        tr = tr.delete(ti.posAt(a), ti.posAt(b));
      }
      this.editor.view.dispatch(tr.scrollIntoView());
      if (this.mode !== 'normal') this.setMode('normal');
      const nt = this.ti.text;
      this.setCursor(firstNonBlank(nt, Math.min(from, Math.max(0, nt.length - 1))));
      return;
    }

    tr = tr.delete(ti.posAt(from), ti.posAt(to));
    this.editor.view.dispatch(tr.scrollIntoView());
    if (op === 'c') {
      this.setMode('insert');
      this.setCursor(from, false);
    } else {
      if (this.mode !== 'normal') this.setMode('normal');
      this.setCursor(from);
    }
  }

  private replaceChars(i: number, ch: string, n: number) {
    const ti = this.ti;
    const end = Math.min(i + n, lineEnd(ti.text, i));
    if (end - i < n) return;
    this.editor.view.dispatch(this.editor.state.tr.insertText(ch.repeat(n), ti.posAt(i), ti.posAt(end)));
    this.setCursor(end - 1);
  }

  private paste(before: boolean) {
    const { text, linewise } = this.register;
    if (!text) return;
    const ti = this.ti;
    const i = this.cursor;
    const state = this.editor.state;
    if (linewise) {
      const block = ti.blockAt(i);
      const at = before ? block.pos : block.end;
      const nodes = text.split('\n').map((line) => state.schema.nodes.paragraph!.create(null, line ? state.schema.text(line) : null));
      this.editor.view.dispatch(state.tr.insert(at, nodes));
      this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, at + 1)));
      return;
    }
    const flat = text.replace(/\s*\n\s*/g, ' ');
    const empty = lineEnd(ti.text, i) === lineStart(ti.text, i);
    const at = before || empty ? i : i + 1;
    const pos = ti.posAt(at);
    this.editor.view.dispatch(state.tr.insertText(flat, pos));
    this.setCursor(at + flat.length - 1);
  }

  private joinLines(i: number, n: number) {
    for (let s = 0; s < Math.max(1, n - 1); s++) {
      const ti = this.ti;
      const t = ti.text;
      const e = lineEnd(t, i);
      if (e >= t.length) return;
      let next = e + 1;
      while (next < t.length && /[ \t]/.test(t[next]!)) next++;
      let start = e;
      while (start > lineStart(t, i) && /[ \t]/.test(t[start - 1]!)) start--;
      const needsSpace = start > lineStart(t, i) && next < t.length && t[next] !== '\n';
      let tr = this.editor.state.tr.delete(ti.posAt(start), ti.posAt(next));
      if (needsSpace) tr = tr.insertText(' ', tr.mapping.map(ti.posAt(start)));
      this.editor.view.dispatch(tr);
      this.setCursor(start);
    }
  }

  private toggleCase(from: number, to: number) {
    const ti = this.ti;
    const s = ti.text.slice(from, to);
    const flipped = [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
    if (s.includes('\n')) return;
    this.editor.view.dispatch(this.editor.state.tr.insertText(flipped, ti.posAt(from), ti.posAt(to)));
  }

  private center() {
    try {
      const c = this.editor.view.coordsAtPos(this.editor.state.selection.head);
      const scroller = this.editor.view.dom.closest('.page-scroll');
      if (scroller) scroller.scrollBy({ top: c.top - (scroller.getBoundingClientRect().top + scroller.clientHeight / 2) });
    } catch {
      /* not rendered */
    }
  }

  private command(key: string) {
    const ti = this.ti;
    const t = ti.text;
    const i = this.cursor;
    const n = this.n();
    switch (key) {
      case 'x':
        return void (lineEnd(t, i) > i && this.applyRange('d', i, Math.min(i + n, lineEnd(t, i)), false));
      case 'X':
        return void (i > lineStart(t, i) && this.applyRange('d', Math.max(lineStart(t, i), i - n), i, false));
      case 'D':
        return void (lineEnd(t, i) > i && this.applyRange('d', i, lineEnd(t, i), false));
      case 'C':
        if (lineEnd(t, i) > i) return this.applyRange('c', i, lineEnd(t, i), false);
        this.setMode('insert');
        return this.setCursor(i, false);
      case 's':
        if (lineEnd(t, i) > i) return this.applyRange('c', i, Math.min(i + n, lineEnd(t, i)), false);
        this.setMode('insert');
        return;
      case 'S': {
        const a = firstNonBlank(t, i);
        const b = lineEnd(t, i);
        if (b > a) return this.applyRange('c', a, b, false);
        this.setMode('insert');
        return this.setCursor(a, false);
      }
      case 'J':
        return this.joinLines(i, n);
      case '~': {
        const end = Math.min(i + n, lineEnd(t, i));
        if (end > i) this.toggleCase(i, end);
        return this.setCursor(end);
      }
      case 'p':
        return this.paste(false);
      case 'P':
        return this.paste(true);
      case 'u':
        for (let s = 0; s < n; s++) this.editor.commands.undo();
        return this.setCursor(this.cursor);
      case '<C-r>':
        for (let s = 0; s < n; s++) this.editor.commands.redo();
        return this.setCursor(this.cursor);
      case 'i':
        this.setMode('insert');
        return this.setCursor(i, false);
      case 'a':
        this.setMode('insert');
        return this.setCursor(Math.min(i + 1, lineEnd(t, i)), false);
      case 'I':
        this.setMode('insert');
        return this.setCursor(firstNonBlank(t, i), false);
      case 'A':
        this.setMode('insert');
        return this.setCursor(lineEnd(t, i), false);
      case 'o':
      case 'O': {
        const block = ti.blockAt(i);
        const at = key === 'o' ? block.end : block.pos;
        const state = this.editor.state;
        const tr = state.tr.insert(at, state.schema.nodes.paragraph!.create());
        tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
        this.mode = 'insert';
        this.editor.view.dispatch(tr);
        this.setMode('insert');
        return;
      }
      case 'v':
      case 'V':
        this.anchor = i;
        this.head = i;
        this.setMode(key === 'v' ? 'visual' : 'visual-line');
        return this.setVisualSelection();
      case '/':
      case '?':
        return this.actions.prompt(key, (q) => {
          if (!q) return;
          this.lastSearch = { q, backward: key === '?' };
          const to = search(this.ti.text, i, q, key === '?');
          if (to !== -1) this.setCursor(to);
          this.editor.commands.focus();
        });
      case ':':
        return this.actions.prompt(':', (line) => this.actions.command(line));
      case 'Enter':
      case '<CR>':
        return this.setCursor(Math.min(t.length, lineEnd(t, i) + 1));
      default:
        return;
    }
  }

  private visualKey(key: string) {
    const ti = this.ti;
    const t = ti.text;
    if (key === 'v' || key === 'V') {
      const target = key === 'v' ? 'visual' : 'visual-line';
      if (this.mode === target) return this.exitVisual();
      this.setMode(target);
      return this.setVisualSelection();
    }
    if (key === 'o') {
      [this.anchor, this.head] = [this.head, this.anchor];
      return this.setVisualSelection();
    }
    let a = Math.min(this.anchor, this.head);
    let b = Math.min(Math.max(this.anchor, this.head) + 1, t.length);
    const linewise = this.mode === 'visual-line';
    if (linewise) {
      a = lineStart(t, a);
      b = lineEnd(t, b - 1);
    }
    switch (key) {
      case 'd':
      case 'x':
        return this.applyRange('d', a, b, linewise);
      case 'c':
      case 's':
        return linewise ? this.applyRange('c', a, b, false) : this.applyRange('c', a, b, false);
      case 'y':
        return this.applyRange('y', a, b, linewise);
      case '~':
        this.toggleCase(a, b);
        return this.exitVisual();
      case 'p': {
        const reg = this.register;
        this.applyRange('d', a, b, linewise);
        this.register = reg;
        return this.paste(true);
      }
      case 'J':
        this.exitVisual();
        return this.joinLines(a, Math.max(2, t.slice(a, b).split('\n').length));
      default: {
        const m = this.motion(key, this.head, this.n(), null);
        if (m) {
          this.head = Math.max(0, Math.min(m.to, t.length - 1));
          this.setVisualSelection();
        }
        this.reset();
      }
    }
  }

  private exitVisual(moveCursor = true) {
    const h = this.head;
    this.setMode('normal');
    if (moveCursor) this.setCursor(h);
  }

  // ------------------------------------------------------------ extension

  extension() {
    const vim = this;
    return Extension.create({
      name: 'vim',
      priority: 1000,
      addProseMirrorPlugins: () => [
        new Plugin({
          key: vimKey,
          props: {
            handleKeyDown: (_view, e) => vim.handleKey(e),
            handleTextInput: () => vim.enabled && vim.mode !== 'insert',
            handleDOMEvents: {
              focus: () => {
                vim.focused = true;
                vim.refresh();
                return false;
              },
              blur: () => {
                vim.focused = false;
                vim.refresh();
                return false;
              },
            },
            attributes: () => ({ class: vim.enabled ? `vim vim-${vim.mode}` : '' }),
            decorations(state) {
              if (!vim.enabled || vim.mode !== 'normal') return null;
              const head = state.selection.head;
              const ti = textIndex(state.doc);
              const i = ti.indexAt(head);
              const ch = ti.text[i];
              if (ch && ch !== '\n' && ti.posAt(i) === head) {
                return DecorationSet.create(state.doc, [Decoration.inline(head, head + 1, { class: 'vim-cursor' })]);
              }
              const el = () => {
                const span = document.createElement('span');
                span.className = 'vim-cursor vim-cursor-eol';
                span.textContent = ' ';
                return span;
              };
              return DecorationSet.create(state.doc, [Decoration.widget(head, el, { side: 0, key: 'vim-eol' })]);
            },
          },
        }),
      ],
    });
  }
}

/** Same column on the line `delta` lines away (logical lines). */
function logicalLine(t: string, i: number, delta: number): number {
  const col = i - lineStart(t, i);
  let s = lineStart(t, i);
  for (let k = 0; k < Math.abs(delta); k++) {
    if (delta > 0) {
      const e = lineEnd(t, s);
      if (e >= t.length) break;
      s = e + 1;
    } else {
      if (s === 0) break;
      s = lineStart(t, s - 1);
    }
  }
  return Math.min(s + col, lastCol(t, s));
}

function tokenize(e: KeyboardEvent): string | null {
  if (e.metaKey || e.altKey) return null;
  const k = e.key;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k)) return null;
  if (e.ctrlKey) {
    const c = k.toLowerCase();
    if (['r', 'w', 'd', 'u', '[', 'l', 'h', 'c'].includes(c)) return `<C-${c}>`;
    return null; // let the app handle Ctrl-S, Ctrl-O, ...
  }
  if (k === 'Escape') return '<Esc>';
  if (k === 'Backspace') return '<BS>';
  if (k === 'Tab') return e.shiftKey ? '<S-Tab>' : 'Tab';
  return k;
}
