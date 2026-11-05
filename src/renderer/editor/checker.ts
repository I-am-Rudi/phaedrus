// Orchestrates checks for the open document.
//
// Grammar/spelling: every paragraph, short debounce, cached by text.
// Style: paragraphs of real prose, longer debounce, one request at a time,
// cached by text + context + profile content (not weights, so accepting a
// suggestion does not trigger a full recheck).
// Teacher mode: a style range you edit becomes "revising"; when you leave
// the paragraph (or press "Check my revision") the edit is sent for feedback.

import type { Editor } from '@tiptap/core';
import type { Backend } from '@shared/api';
import { sectionTitle, type DocBlock } from '@shared/document';
import { effectiveMoves, ownerOf } from '@shared/profile/model';
import { proseOf } from '@shared/latex';
import { findQuote, hash } from '@shared/spans';
import type { EditFeedback, GrammarIssue, Mode, Settings, StyleMove, StyleSuggestion, TasteProfile } from '@shared/types';
import { blocks, getIssues, issuesKey, type BlockInfo, type IssueMeta, type IssueRange } from './issues';

export interface GrammarEntry {
  id: string;
  kind: 'grammar';
  category: 'spelling' | 'grammar';
  issue: GrammarIssue;
}

export interface StyleEntry {
  id: string;
  kind: 'style';
  category: 'style';
  s: StyleSuggestion;
  move: StyleMove;
  original: string;
  status: 'open' | 'revising' | 'checking';
}

export type Entry = GrammarEntry | StyleEntry;

export interface FeedbackEntry {
  id: string;
  move: StyleMove;
  original: string;
  revised: string;
  feedback: EditFeedback;
}

export interface CheckerDeps {
  backend: Backend;
  settings(): Settings;
  profiles(): { general: TasteProfile | null; project: TasteProfile | null };
  docType(): string;
  onProfile(p: TasteProfile): void;
}

type Phase = 'idle' | 'busy' | 'error';
const MIN_STYLE_CHARS = 60;
/** Reference abbreviations common in scientific writing; never flagged as misspelled. */
const BUILTIN_WORDS = ['eq', 'eqs', 'fig', 'figs', 'sec', 'secs', 'ref', 'refs', 'tab', 'app', 'thm', 'lem', 'prop', 'def', 'cor', 'ch', 'cf'];

export class Checker {
  entries = new Map<string, Entry>();
  feedback: FeedbackEntry[] = [];
  grammarPhase: Phase = 'idle';
  stylePhase: Phase = 'idle';
  message = '';

  private grammarCache = new Map<string, GrammarIssue[]>();
  private styleCache = new Map<string, StyleSuggestion[]>();
  private appliedGrammar = new Map<number, string>();
  private appliedStyle = new Map<number, string>();
  private dismissed = new Set<string>();
  private grammarGen = 0;
  private styleGen = 0;
  private grammarTimer: number | undefined;
  private styleTimer: number | undefined;
  private listeners = new Set<() => void>();
  private destroyed = false;

  constructor(
    private editor: Editor,
    private deps: CheckerDeps,
  ) {
    editor.on('transaction', this.onTransaction);
    if (import.meta.env.DEV) (window as any).__checker = this;
  }

  destroy() {
    this.destroyed = true;
    window.clearTimeout(this.grammarTimer);
    window.clearTimeout(this.styleTimer);
    this.editor.off('transaction', this.onTransaction);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Forget everything (new document loaded). */
  reset() {
    this.entries.clear();
    this.feedback = [];
    this.appliedGrammar.clear();
    this.appliedStyle.clear();
    this.dispatch({ type: 'clear' });
    this.schedule(true);
  }

  /** Context changed (profile, document type, engine): recheck style, keep caches. */
  invalidate(what: 'style' | 'grammar' | 'all' = 'all') {
    if (what !== 'grammar') this.appliedStyle.clear();
    if (what !== 'style') {
      this.appliedGrammar.clear();
      this.grammarCache.clear();
    }
    this.schedule(true);
  }

  schedule(now = false) {
    const s = this.deps.settings();
    window.clearTimeout(this.grammarTimer);
    window.clearTimeout(this.styleTimer);
    this.grammarTimer = window.setTimeout(() => void this.runGrammar(), now ? 50 : s.grammarDebounceMs);
    this.styleTimer = window.setTimeout(() => void this.runStyle(), now ? 400 : s.styleDebounceMs);
  }

  private dispatch(meta: IssueMeta) {
    if (this.destroyed || this.editor.isDestroyed) return;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(issuesKey, meta).setMeta('addToHistory', false));
  }

  // ------------------------------------------------------------- tracking

  private onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
    const items = getIssues(this.editor.state);
    const live = new Set(items.map((i) => i.id));
    let changed = false;
    for (const id of [...this.entries.keys()]) {
      if (!live.has(id)) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (this.deps.settings().mode === 'teacher') {
      const head = this.editor.state.selection.head;
      const bs = blocks(this.editor.state.doc);
      for (const it of items) {
        const e = this.entries.get(it.id);
        if (e?.kind !== 'style') continue;
        const now = this.editor.state.doc.textBetween(it.from, it.to, '\n');
        if (e.status === 'open' && now !== e.original) {
          e.status = 'revising';
          changed = true;
        }
        if (e.status === 'revising') {
          const b = bs.find((x) => it.from >= x.pos && it.from <= x.end);
          if (b && (head < b.pos || head > b.end)) void this.requestFeedback(e.id);
        }
      }
    }
    if (transaction.docChanged) this.schedule();
    if (changed || transaction.docChanged) this.emit();
  };

  range(id: string): IssueRange | undefined {
    return getIssues(this.editor.state).find((i) => i.id === id);
  }

  // -------------------------------------------------------------- grammar

  private async runGrammar() {
    const gen = ++this.grammarGen;
    const settings = this.deps.settings();
    const engine = settings.grammar.engine;
    if (engine === 'none') {
      this.dispatch({ type: 'replace', kind: 'grammar', from: 0, to: this.editor.state.doc.content.size, items: [] });
      return;
    }
    const pending = blocks(this.editor.state.doc).filter((b) => this.appliedGrammar.get(b.index) !== hash(engine + b.text));
    if (!pending.length) return;
    this.grammarPhase = 'busy';
    this.emit();
    try {
      for (const b of pending) {
        if (gen !== this.grammarGen || this.destroyed) return;
        const key = hash(engine + b.text);
        let issues = this.grammarCache.get(key);
        if (!issues) {
          issues = b.text.trim() ? await this.deps.backend.grammar.check(b.text) : [];
          this.grammarCache.set(key, issues);
        }
        if (gen !== this.grammarGen) return;
        this.applyGrammar(b.text, b.index, issues, key);
      }
      this.grammarPhase = 'idle';
      if (this.message.startsWith('Grammar:')) this.message = '';
    } catch (e) {
      this.grammarPhase = 'error';
      this.message = 'Grammar: ' + clean(e);
    }
    this.emit();
  }

  private locate(text: string, index: number): BlockInfo | undefined {
    const bs = blocks(this.editor.state.doc);
    if (bs[index]?.text === text) return bs[index];
    return bs.find((b) => b.text === text);
  }

  private applyGrammar(text: string, index: number, issues: GrammarIssue[], key: string) {
    const b = this.locate(text, index);
    if (!b) return;
    const dict = new Set([...BUILTIN_WORDS, ...this.deps.settings().dictionary.map((w) => w.toLowerCase())]);
    const items: IssueRange[] = [];
    for (const issue of issues) {
      if (issue.category === 'spelling' && dict.has(issue.text.toLowerCase())) continue;
      if (this.dismissed.has(`g:${issue.text}|${issue.ruleId}`)) continue;
      const id = `g:${hash(text)}:${issue.from}:${issue.ruleId}`;
      const from = b.posAt(issue.from);
      const to = b.posAt(issue.to - 1) + 1;
      if (from >= to) continue;
      items.push({ id, category: issue.category, from, to, text: issue.text });
      this.entries.set(id, { id, kind: 'grammar', category: issue.category, issue });
    }
    this.appliedGrammar.set(b.index, key);
    this.dispatch({ type: 'replace', kind: 'grammar', from: b.pos, to: b.end, items });
  }

  // ---------------------------------------------------------------- style

  private async runStyle() {
    const gen = ++this.styleGen;
    const { general, project } = this.deps.profiles();
    if (!general && !project) return;
    const docType = this.deps.docType();
    const bs = blocks(this.editor.state.doc);
    const items = getIssues(this.editor.state);
    const busyBlocks = new Set(
      items
        .filter((i) => {
          const e = this.entries.get(i.id);
          return e?.kind === 'style' && e.status !== 'open';
        })
        .map((i) => bs.find((b) => i.from >= b.pos && i.from <= b.end)?.index),
    );

    // Work out each block's section and the moves that apply there.
    let section = '';
    const jobs: { b: BlockInfo; moves: StyleMove[]; section: string; key: string }[] = [];
    for (const b of bs) {
      const db: DocBlock = b.type === 'heading' ? { type: 'heading', level: b.level, text: b.text } : { type: 'paragraph', text: b.text };
      const title = sectionTitle(db);
      if (title) section = title;
      if (b.type === 'heading' || proseOf(b.text).trim().length < MIN_STYLE_CHARS || busyBlocks.has(b.index)) continue;
      const moves = effectiveMoves(general, project, { docType, section });
      const movesKey = moves.map((m) => `${m.id}:${m.title}:${m.description}:${m.notes.length}`).join('|');
      const key = hash([b.text, docType, section, movesKey].join('\u0000'));
      if (this.appliedStyle.get(b.index) === key) continue;
      jobs.push({ b, moves, section, key });
    }
    if (!jobs.length) return;

    // Paragraphs near the cursor first.
    const head = this.editor.state.selection.head;
    jobs.sort((x, y) => Math.abs(x.b.pos - head) - Math.abs(y.b.pos - head));

    this.stylePhase = 'busy';
    this.emit();
    try {
      for (const job of jobs) {
        if (gen !== this.styleGen || this.destroyed) return;
        let suggestions = this.styleCache.get(job.key);
        if (!suggestions) {
          const all = blocks(this.editor.state.doc);
          const neighbour = (d: number) => {
            const n = all[job.b.index + d];
            return n && n.type === 'paragraph' ? n.text : undefined;
          };
          suggestions = await this.deps.backend.coach.checkStyle({
            paragraph: job.b.text,
            before: neighbour(-1),
            after: neighbour(1),
            moves: job.moves,
            docType,
            section: job.section,
            metrics: general?.metrics ?? project?.metrics,
          });
          this.styleCache.set(job.key, suggestions);
        }
        if (gen !== this.styleGen) return;
        this.applyStyle(job.b.text, job.b.index, suggestions, job.moves, job.key);
      }
      this.stylePhase = 'idle';
      if (this.message.startsWith('Style:')) this.message = '';
    } catch (e) {
      this.stylePhase = 'error';
      this.message = 'Style: ' + clean(e);
    }
    this.emit();
  }

  private applyStyle(text: string, index: number, suggestions: StyleSuggestion[], moves: StyleMove[], key: string) {
    const b = this.locate(text, index);
    if (!b) return;
    const teacher = this.deps.settings().mode === 'teacher';
    const items: IssueRange[] = [];
    const taken: { from: number; to: number }[] = [];
    for (const s of suggestions) {
      const move = moves.find((m) => m.id === s.moveId);
      if (!move || this.dismissed.has(`s:${s.moveId}|${s.quote}`)) continue;
      const r = findQuote(text, s.quote);
      if (!r) continue;
      // Overlapping suggestions would share one underline and one revision;
      // keep the first (the model lists the most important first).
      if (taken.some((t) => r.from < t.to && t.from < r.to)) continue;
      taken.push(r);
      const id = `s:${hash(text + s.moveId + s.quote)}`;
      const from = b.posAt(r.from);
      const to = b.posAt(r.to - 1) + 1;
      items.push({ id, category: 'style', from, to, text: s.quote, hidden: teacher && move.hintLevel === 0 });
      this.entries.set(id, { id, kind: 'style', category: 'style', s, move, original: s.quote, status: 'open' });
    }
    this.appliedStyle.set(b.index, key);
    this.dispatch({ type: 'replace', kind: 'style', from: b.pos, to: b.end, items });
  }

  // -------------------------------------------------------------- actions

  select(id: string | null, focusEditor = false) {
    this.dispatch({ type: 'select', id });
    const r = id ? this.range(id) : undefined;
    if (r && focusEditor) {
      this.editor.chain().setTextSelection({ from: r.from, to: r.to }).scrollIntoView().run();
    }
  }

  private replace(id: string, text: string) {
    const r = this.range(id);
    if (!r) return;
    const tr = this.editor.state.tr;
    const clean = text.replace(/\s*\n\s*/g, ' ');
    if (clean) tr.insertText(clean, r.from, r.to);
    else tr.delete(r.from, r.to);
    tr.setMeta(issuesKey, { type: 'remove', ids: [id] } satisfies IssueMeta);
    this.editor.view.dispatch(tr);
  }

  applyReplacement(id: string, replacement: string) {
    this.replace(id, replacement);
  }

  async accept(id: string) {
    const e = this.entries.get(id);
    if (e?.kind !== 'style') return;
    this.replace(id, e.s.rewrite);
    await this.profileEvent({ type: 'accept', moveId: e.move.id });
  }

  dismiss(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.dismissed.add(e.kind === 'grammar' ? `g:${e.issue.text}|${e.issue.ruleId}` : `s:${e.move.id}|${e.s.quote}`);
    this.dispatch({ type: 'remove', ids: [id] });
  }

  async reject(id: string, reason?: string) {
    const e = this.entries.get(id);
    if (e?.kind !== 'style') return;
    this.dismiss(id);
    await this.profileEvent({ type: 'reject', moveId: e.move.id, reason, docType: this.deps.docType() });
  }

  /** Teacher mode: ask for feedback on the user's revision of a flagged passage. */
  async requestFeedback(id: string) {
    const e = this.entries.get(id);
    const r = this.range(id);
    if (e?.kind !== 'style' || !r || e.status === 'checking') return;
    e.status = 'checking';
    this.emit();
    const revised = this.editor.state.doc.textBetween(r.from, r.to, '\n');
    const b = blocks(this.editor.state.doc).find((x) => r.from >= x.pos && r.from <= x.end);
    try {
      const feedback = await this.deps.backend.coach.editFeedback({
        move: e.move,
        issue: e.s.issue,
        original: e.original,
        revised,
        paragraph: b?.text ?? revised,
      });
      if (this.message.startsWith('Feedback:')) this.message = '';
      this.feedback.unshift({ id: `f:${id}:${Date.now()}`, move: e.move, original: e.original, revised, feedback });
      this.dispatch({ type: 'remove', ids: [id] });
      this.entries.delete(id);
      await this.profileEvent({ type: 'edit', moveId: e.move.id, feedback, revised });
      this.schedule();
    } catch (err) {
      e.status = 'revising';
      this.message = 'Feedback: ' + clean(err);
    }
    this.emit();
  }

  closeFeedback(id: string) {
    this.feedback = this.feedback.filter((f) => f.id !== id);
    this.emit();
  }

  /** Apply teacher/assistant visibility after a mode switch. */
  setMode(mode: Mode) {
    const hidden: Record<string, boolean> = {};
    for (const e of this.entries.values()) if (e.kind === 'style') hidden[e.id] = mode === 'teacher' && e.move.hintLevel === 0;
    this.dispatch({ type: 'visibility', hidden });
    this.emit();
  }

  private async profileEvent(ev: Parameters<Backend['profiles']['applyEvent']>[1]) {
    const { general, project } = this.deps.profiles();
    const owner = ownerOf(ev.moveId, general, project);
    if (!owner) return;
    try {
      this.deps.onProfile(await this.deps.backend.profiles.applyEvent(owner.id, ev));
      if (this.message.startsWith('Profile:')) this.message = '';
    } catch (e) {
      this.message = 'Profile: ' + clean(e);
      this.emit();
    }
  }
}

function clean(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
