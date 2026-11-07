// Orchestrates checks for the open document.
//
// Grammar/spelling: every paragraph, short debounce, cached by text.
// Style: paragraphs of real prose, longer debounce, one request at a time,
// cached by text + context + profile content (not weights, so accepting a
// suggestion does not trigger a full recheck).
// Teacher mode: a style range you edit becomes "revising"; the edit is sent
// for feedback when you finish revising the paragraph (Done) or press
// "Check my revision", never just because the cursor moved.

import type { Editor } from '@tiptap/core';
import type { Backend } from '@shared/api';
import { sectionTitle, softWrap, type DocBlock } from '@shared/document';
import { effectiveMoves, newMove, ownerOf } from '@shared/profile/model';
import { activeRules, type RuleEvent, type RuleSet } from '@shared/rules';
import { proseOf } from '@shared/latex';
import { findQuote, hash } from '@shared/spans';
import type { Category, EditFeedback, GrammarIssue, Mode, Settings, StyleMove, StyleSuggestion, TasteProfile } from '@shared/types';
import type { KeyboardLayout } from '@shared/spelling/keyboard';
import { learnedPairs } from '@shared/spelling/memory';
import { buildVocabulary, rankSpelling, type VocabularyEntry } from '@shared/spelling/rank';
import type { StyleBatchResult, TypoChoice, TypoQuestion } from '@shared/coach';
import { blocks, getIssues, issuesKey, type BlockInfo, type IssueMeta, type IssueRange } from './issues';

export interface GrammarEntry {
  id: string;
  kind: 'grammar';
  category: 'spelling' | 'grammar';
  /** As shown: for spelling, the replacements are ranked (see spelling/rank.ts). */
  issue: GrammarIssue;
  /** As the engine returned it, plus the candidates added from the word list. */
  raw: GrammarIssue;
  /** Spelling with no clear best correction: the style pass asks the model. */
  close?: boolean;
}

export interface StyleEntry {
  id: string;
  kind: 'style';
  /** "style" for taste-profile moves, "rules" for rule violations. */
  category: 'style' | 'rules';
  s: StyleSuggestion;
  /** The move, or for a rule violation a move-shaped view of the rule. */
  move: StyleMove;
  /** Set for rule violations. */
  rule?: { setId: string; ruleId: string };
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
  /** A range whose style hints must stay as they are (the paragraph under revision). */
  paused?(): { from: number; to: number } | null;
  /** The chosen profiles, plus those switched to always on for this language. */
  profiles(): { general: TasteProfile | null; project: TasteProfile | null; always: TasteProfile[] };
  /** Active rule sets. */
  ruleSets(): RuleSet[];
  onRuleEvent(setId: string, ev: RuleEvent): void;
  docType(): string;
  /** The project's language, or the default. */
  language(): string;
  onProfile(p: TasteProfile): void;
  /** The keyboard the writer types on, for ranking spelling corrections. */
  keyboard?(): KeyboardLayout;
  /** A spelling correction was applied, to be remembered for next time. */
  onSpellingChoice?(typo: string, word: string): void;
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
  /** Words of the document, for spelling corrections. Rebuilt after each grammar round. */
  private vocabulary = new Map<string, VocabularyEntry>();
  private proseCache = new Map<string, string>();
  /** The model's pick for a close spelling call, by grammar entry id. */
  private picks = new Map<string, string>();
  /** The model's typo picks per style job key, like styleCache. */
  private typoCache = new Map<string, TypoChoice[]>();
  private pairsFor: { memory: Settings['spellingMemory'] | undefined; pairs: Map<string, number> } | null = null;
  /** Bumped when spelling suggestions are re-ranked, so the UI redraws. */
  spellingVersion = 0;
  /** Categories the user has switched off (chips in the panel, SPC t): their underlines are not drawn. */
  private shown: Record<Category, boolean> = { spelling: true, grammar: true, style: true, rules: true };
  private grammarGen = 0;
  /** Style checks per paragraph key that are waiting or running. */
  private pending = new Map<string, 'queued' | 'checking'>();
  private inflight = new Set<string>();
  private blockKeys = new Map<number, string>();
  private progressTotal = 0;
  /** Duration of the last style request, ms. */
  lastStyleMs = 0;
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
    // Teacher mode: an edited passage is marked as revised. Feedback is asked
    // for only when the revision is confirmed (finishRevision) or on request.
    if (this.deps.settings().mode === 'teacher' && transaction.docChanged) {
      for (const it of items) {
        const e = this.entries.get(it.id);
        if (e?.kind !== 'style' || e.status !== 'open') continue;
        if (textAt(this.editor.state.doc, it.from, it.to) !== e.original) {
          e.status = 'revising';
          changed = true;
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
    const lang = this.deps.language();
    const keyOf = (text: string) => hash(`${engine}\u0000${lang}\u0000${text}`);
    const pending = blocks(this.editor.state.doc).filter((b) => this.appliedGrammar.get(b.index) !== keyOf(b.text));
    if (!pending.length) return;
    this.grammarPhase = 'busy';
    this.emit();
    try {
      for (const b of pending) {
        if (gen !== this.grammarGen || this.destroyed) return;
        const key = keyOf(b.text);
        let issues = this.grammarCache.get(key);
        if (!issues) {
          // Line breaks inside a paragraph are formatting; the engine sees one line (same offsets).
          issues = b.text.trim() ? await this.deps.backend.grammar.check(softWrap(b.text), lang) : [];
          this.grammarCache.set(key, issues);
        }
        if (gen !== this.grammarGen) return;
        this.applyGrammar(b.text, b.index, issues, key);
      }
      // The document's words are known now; rank its spelling suggestions with them.
      this.rerankSpelling();
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
      // Compare against the real text later (it may contain line breaks the engine saw as spaces).
      items.push({ id, category: issue.category, from, to, text: text.slice(issue.from, issue.to), hidden: !this.shown[issue.category] });
      this.entries.set(id, { id, kind: 'grammar', category: issue.category, raw: issue, ...this.rank(id, issue) });
    }
    this.appliedGrammar.set(b.index, key);
    this.dispatch({ type: 'replace', kind: 'grammar', from: b.pos, to: b.end, items });
  }

  /** Spelling: the engine's and the word list's candidates, best first. */
  private rank(id: string, raw: GrammarIssue): { issue: GrammarIssue; close: boolean } {
    if (raw.category !== 'spelling' || !raw.replacements.length) return { issue: raw, close: false };
    const memory = this.deps.settings().spellingMemory;
    if (this.pairsFor?.memory !== memory) this.pairsFor = { memory, pairs: learnedPairs(memory) };
    const ranked = rankSpelling(raw, {
      layout: this.deps.keyboard?.() ?? 'qwerty',
      vocabulary: this.vocabulary,
      memory,
      pairs: this.pairsFor.pairs,
      pick: this.picks.get(id),
    });
    return { issue: { ...raw, replacements: ranked.replacements }, close: ranked.close };
  }

  /**
   * Rank all spelling suggestions again, with the document's current words and
   * the remembered choices. No engine call: the candidates are kept on the entries.
   */
  rerankSpelling() {
    const spelling = [...this.entries.values()].filter((e): e is GrammarEntry => e.kind === 'grammar' && e.category === 'spelling');
    const texts = blocks(this.editor.state.doc).map((b) => {
      let prose = this.proseCache.get(b.text);
      if (prose === undefined) {
        prose = proseOf(b.text);
        this.proseCache.set(b.text, prose);
      }
      return prose;
    });
    if (this.proseCache.size > texts.length * 2 + 50) this.proseCache.clear();
    const flagged = new Set(spelling.map((e) => e.raw.text.toLowerCase()));
    this.vocabulary = buildVocabulary(texts, flagged, this.deps.settings().dictionary);
    if (!spelling.length) return;
    for (const e of spelling) Object.assign(e, this.rank(e.id, e.raw));
    this.spellingVersion++;
    this.emit();
  }

  /** Close spelling calls in a paragraph, for the model to settle along with the style check. */
  private typoQuestions(text: string, paragraphId: string): TypoQuestion[] {
    const prefix = `g:${hash(text)}:`;
    const seen = new Set<string>();
    const out: TypoQuestion[] = [];
    for (const e of this.entries.values()) {
      if (e.kind !== 'grammar' || !e.close || !e.id.startsWith(prefix) || seen.has(e.raw.text)) continue;
      seen.add(e.raw.text);
      out.push({ paragraph: paragraphId, word: e.raw.text, candidates: e.issue.replacements.slice(0, 3) });
    }
    return out;
  }

  /** The model's picks for a paragraph's close calls. Returns true if any ranking changed. */
  private applyTypoChoices(text: string, choices: TypoChoice[]): boolean {
    if (!choices.length) return false;
    const prefix = `g:${hash(text)}:`;
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.kind !== 'grammar' || !e.id.startsWith(prefix)) continue;
      const c = choices.find((x) => x.word === e.raw.text);
      if (c && this.picks.get(e.id) !== c.choice) {
        this.picks.set(e.id, c.choice);
        changed = true;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------- style

  private async runStyle() {
    const gen = ++this.styleGen;
    const { general, project, always } = this.deps.profiles();
    if (!general && !project && !always.length && !this.deps.ruleSets().length) return;
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
    const ruleSets = this.deps.ruleSets();
    this.blockKeys.clear();
    const jobs: { b: BlockInfo; moves: StyleMove[]; rules: ReturnType<typeof activeRules>; section: string; key: string }[] = [];
    for (const b of bs) {
      const db: DocBlock = b.type === 'heading' ? { type: 'heading', level: b.level, text: b.text } : { type: 'paragraph', text: b.text };
      const title = sectionTitle(db);
      if (title) section = title;
      if (b.type === 'heading' || proseOf(b.text).trim().length < MIN_STYLE_CHARS || busyBlocks.has(b.index)) continue;
      // The paragraph being revised keeps its hints until the revision is done.
      const paused = this.deps.paused?.();
      if (paused && b.pos < paused.to && b.end > paused.from) continue;
      const moves = effectiveMoves(general, project, { docType, section }, always);
      const rules = activeRules(ruleSets, { docType, section });
      if (!moves.length && !rules.length) continue;
      const movesKey = moves.map((m) => `${m.id}:${m.title}:${m.description}:${m.notes.length}`).join('|');
      const rulesKey = rules.map((r) => `${r.key}:${r.description}:${r.notes.length}`).join('|');
      const key = hash([b.text, docType, section, movesKey, rulesKey].join('\u0000'));
      this.blockKeys.set(b.index, key);
      if (this.appliedStyle.get(b.index) === key) continue;
      jobs.push({ b, moves, rules, section, key });
    }
    // Results still on their way count as done for this round.
    const fresh = jobs.filter((j) => !this.inflight.has(j.key));
    // Forget queued work from an older round; requests already running stay visible.
    for (const k of [...this.pending.keys()]) if (!this.inflight.has(k)) this.pending.delete(k);
    for (const j of fresh) this.pending.set(j.key, 'queued');
    if (!fresh.length) return this.emitProgress();

    // The paragraph at the cursor goes alone, so the first hint comes quickly.
    // The rest go in batches of paragraphs that share moves and rules.
    const head = this.editor.state.selection.head;
    fresh.sort((x, y) => Math.abs(x.b.pos - head) - Math.abs(y.b.pos - head));
    const batches = makeBatches(fresh);
    this.progressTotal = fresh.length;
    this.stylePhase = 'busy';
    this.emitProgress();

    const metrics = general?.metrics ?? project?.metrics ?? always[0]?.metrics;
    const concurrency = this.deps.settings().provider.endsWith('-cli') ? 3 : 4;
    const worker = async () => {
      for (;;) {
        if (gen !== this.styleGen || this.destroyed) return;
        const batch = batches.shift();
        if (!batch) return;
        const cached = batch.every((j) => this.styleCache.has(j.key));
        if (!cached) {
          for (const j of batch) {
            this.pending.set(j.key, 'checking');
            this.inflight.add(j.key);
          }
          this.emitProgress();
          const all = blocks(this.editor.state.doc);
          const first = batch.reduce((m, j) => (j.b.index < m.b.index ? j : m), batch[0]!);
          const last = batch.reduce((m, j) => (j.b.index > m.b.index ? j : m), batch[0]!);
          const near = (i: number) => (all[i] && all[i]!.type === 'paragraph' ? softWrap(all[i]!.text) : undefined);
          const started = performance.now();
          const typos = batch.flatMap((j) => this.typoQuestions(j.b.text, j.key));
          let results: StyleBatchResult;
          try {
            results = await this.deps.backend.coach.checkStyleBatch({
              paragraphs: batch.map((j) => ({ id: j.key, text: softWrap(j.b.text), section: j.section })),
              before: near(first.b.index - 1),
              after: near(last.b.index + 1),
              moves: batch[0]!.moves,
              rules: batch[0]!.rules,
              docType,
              metrics,
              ...(typos.length ? { typos } : {}),
            });
          } finally {
            for (const j of batch) this.inflight.delete(j.key);
          }
          this.lastStyleMs = performance.now() - started;
          for (const j of batch) {
            this.styleCache.set(j.key, results.suggestions[j.key] ?? []);
            this.typoCache.set(j.key, results.typos?.[j.key] ?? []);
          }
        }
        let picked = false;
        for (const j of batch) {
          this.pending.delete(j.key);
          // Apply even if a newer round started: the text is matched again, so stale results never land.
          this.applyStyle(j.b.text, j.b.index, this.styleCache.get(j.key) ?? [], j.moves, j.rules, j.key);
          if (this.applyTypoChoices(j.b.text, this.typoCache.get(j.key) ?? [])) picked = true;
        }
        if (picked) this.rerankSpelling();
        this.emitProgress();
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
      if (gen === this.styleGen) {
        this.stylePhase = 'idle';
        if (this.message.startsWith('Style:')) this.message = '';
      }
    } catch (e) {
      this.pending.clear();
      this.stylePhase = 'error';
      this.message = 'Style: ' + clean(e);
    }
    this.emitProgress();
  }

  /** Style/rule checks still waiting or running, for the indicator. */
  get styleProgress(): { waiting: number; checking: number; total: number } {
    let waiting = 0;
    let checking = 0;
    for (const s of this.pending.values()) (s === 'checking' ? checking++ : waiting++);
    return { waiting, checking, total: this.progressTotal };
  }

  /** Mark paragraphs that are waiting or being checked, and tell the UI. */
  private emitProgress() {
    if (this.destroyed || this.editor.isDestroyed) return;
    const marks: { from: number; to: number; state: 'queued' | 'checking' }[] = [];
    if (this.pending.size) {
      for (const b of blocks(this.editor.state.doc)) {
        for (const [key, state] of this.pending) {
          if (this.blockKeys.get(b.index) === key) marks.push({ from: b.pos, to: b.end, state });
        }
      }
    }
    if (!this.pending.size) this.progressTotal = 0;
    if (!this.pending.size && !this.inflight.size && this.stylePhase === 'busy') this.stylePhase = 'idle';
    this.dispatch({ type: 'progress', marks });
    this.emit();
  }

  private applyStyle(text: string, index: number, suggestions: StyleSuggestion[], moves: StyleMove[], rules: ReturnType<typeof activeRules>, key: string) {
    const b = this.locate(text, index);
    if (!b) return;
    const teacher = this.deps.settings().mode === 'teacher';
    const items: IssueRange[] = [];
    const taken: { from: number; to: number }[] = [];
    for (const s of suggestions) {
      const rule = s.ruleKey ? rules.find((r) => r.key === s.ruleKey) : undefined;
      const move = rule ? ruleAsMove(rule) : moves.find((m) => m.id === s.moveId);
      if (!move || this.dismissed.has(`s:${move.id}|${s.quote}`)) continue;
      const r = findQuote(text, s.quote);
      if (!r) continue;
      // Overlapping suggestions would share one underline and one revision;
      // keep the first (the model lists the most important first).
      if (taken.some((t) => r.from < t.to && t.from < r.to)) continue;
      taken.push(r);
      const id = `s:${hash(text + s.moveId + s.quote)}`;
      const from = b.posAt(r.from);
      const to = b.posAt(r.to - 1) + 1;
      const category = rule ? 'rules' : 'style';
      items.push({ id, category, from, to, text: s.quote, hidden: !this.shown[category] || (teacher && move.hintLevel === 0) });
      this.entries.set(id, {
        // The passage as it stands in the document (with its line breaks), not the
        // model's quote, which saw the paragraph on one line: only a real edit differs.
        id, kind: 'style', category, s, move, original: text.slice(r.from, r.to), status: 'open',
        ...(rule ? { rule: { setId: rule.setId, ruleId: rule.id } } : {}),
      });
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
    const e = this.entries.get(id);
    this.replace(id, replacement);
    if (e?.kind === 'grammar' && e.category === 'spelling' && replacement.trim()) this.deps.onSpellingChoice?.(e.raw.text, replacement);
  }

  async accept(id: string) {
    const e = this.entries.get(id);
    if (e?.kind !== 'style') return;
    this.replace(id, e.s.rewrite);
    if (e.rule) return this.deps.onRuleEvent(e.rule.setId, { type: 'accept', ruleId: e.rule.ruleId });
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
    if (e.rule) return this.deps.onRuleEvent(e.rule.setId, { type: 'reject', ruleId: e.rule.ruleId, reason, docType: this.deps.docType() });
    await this.profileEvent({ type: 'reject', moveId: e.move.id, reason, docType: this.deps.docType() });
  }

  /**
   * The text in [from, to) was put back as it was (a discarded revision):
   * drop its suggestions and lay them out again. Results come from the caches,
   * so this costs no model call.
   */
  restoreRange(from: number, to: number) {
    const ids = getIssues(this.editor.state).filter((it) => it.from < to && it.to > from).map((it) => it.id);
    for (const id of ids) this.entries.delete(id);
    if (ids.length) this.dispatch({ type: 'remove', ids });
    for (const b of blocks(this.editor.state.doc)) {
      if (b.pos < to && b.end > from) {
        this.appliedGrammar.delete(b.index);
        this.appliedStyle.delete(b.index);
      }
    }
    this.schedule(true);
    this.emit();
  }

  /** Teacher mode: the revision of the paragraph in [from, to) is done; ask for feedback on every passage that changed. */
  finishRevision(from: number, to: number) {
    const ids = getIssues(this.editor.state)
      .filter((it) => it.from >= from && it.to <= to)
      .map((it) => this.entries.get(it.id))
      .filter((e): e is StyleEntry => e?.kind === 'style' && e.status === 'revising')
      .map((e) => e.id);
    for (const id of ids) void this.requestFeedback(id);
    this.schedule();
    return ids.length;
  }

  /** Teacher mode: ask for feedback on the user's revision of a flagged passage. */
  async requestFeedback(id: string) {
    const e = this.entries.get(id);
    const r = this.range(id);
    if (e?.kind !== 'style' || !r || e.status === 'checking') return;
    e.status = 'checking';
    this.emit();
    const revised = softWrap(textAt(this.editor.state.doc, r.from, r.to));
    const b = blocks(this.editor.state.doc).find((x) => r.from >= x.pos && r.from <= x.end);
    try {
      const feedback = await this.deps.backend.coach.editFeedback({
        move: e.move,
        issue: e.s.issue,
        original: softWrap(e.original),
        revised,
        paragraph: b ? softWrap(b.text) : revised,
      });
      if (this.message.startsWith('Feedback:')) this.message = '';
      this.feedback.unshift({ id: `f:${id}:${Date.now()}`, move: e.move, original: softWrap(e.original), revised, feedback });
      this.dispatch({ type: 'remove', ids: [id] });
      this.entries.delete(id);
      if (!e.rule) await this.profileEvent({ type: 'edit', moveId: e.move.id, feedback, revised });
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
    this.applyVisibility(mode);
  }

  /** Show or hide whole categories of underlines. */
  setShown(shown: Record<Category, boolean>) {
    this.shown = { ...shown };
    this.applyVisibility(this.deps.settings().mode);
  }

  private applyVisibility(mode: Mode) {
    const hidden: Record<string, boolean> = {};
    for (const e of this.entries.values()) {
      hidden[e.id] = !this.shown[e.category] || (e.kind === 'style' && mode === 'teacher' && e.move.hintLevel === 0);
    }
    this.dispatch({ type: 'visibility', hidden });
    this.emit();
  }

  private async profileEvent(ev: Parameters<Backend['profiles']['applyEvent']>[1]) {
    const { general, project, always } = this.deps.profiles();
    const owner = ownerOf(ev.moveId, general, project, always);
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

/** A rule shown through the same card and feedback machinery as a style move. */
function ruleAsMove(rule: ReturnType<typeof activeRules>[number]): StyleMove {
  return newMove({
    id: `rule:${rule.key}`,
    title: rule.title,
    description: rule.description,
    hintLevel: 3,
    examples: rule.good.map((g) => ({ text: g, kind: 'author' as const })),
    notes: rule.notes,
  });
}

type StyleJob = { b: BlockInfo; moves: StyleMove[]; rules: ReturnType<typeof activeRules>; section: string; key: string };

const BATCH_SIZE = 5;
const BATCH_WORDS = 1500;

/** First job alone; the rest grouped by identical moves and rules, a few paragraphs per request. */
export function makeBatches(jobs: StyleJob[]): StyleJob[][] {
  if (!jobs.length) return [];
  const [first, ...rest] = jobs;
  const out: StyleJob[][] = [[first!]];
  const groups = new Map<string, StyleJob[]>();
  for (const j of rest) {
    const g = j.moves.map((m) => m.id).join(',') + '|' + j.rules.map((r) => r.key).join(',');
    groups.set(g, [...(groups.get(g) ?? []), j]);
  }
  for (const list of groups.values()) {
    let cur: StyleJob[] = [];
    let words = 0;
    for (const j of list) {
      const w = j.b.text.split(/\s+/).length;
      if (cur.length && (cur.length >= BATCH_SIZE || words + w > BATCH_WORDS)) {
        out.push(cur);
        cur = [];
        words = 0;
      }
      cur.push(j);
      words += w;
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

/** Text of a range as the checks see it: a line break inside a paragraph is "\n". */
function textAt(doc: { textBetween(from: number, to: number, block?: string, leaf?: string): string }, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', '\n');
}
