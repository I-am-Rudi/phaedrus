// Ranks spelling corrections. The score adds up, in Zipf units (one unit is a
// factor of ten in how common a word is):
//   how common the word is                     zipf, or FLOOR if unlisted
//   minus how unlikely this typo is for it     COST_WEIGHT x typoCost
//   plus a word the document already uses      up to DOC_MAX
//   plus a correction the writer chose before  MEMORY
//   plus the language model's pick in context  PICK
//   plus a little for the engine's own order   ENGINE
// so "zou" becomes "you" (very common, a y/z slip) before "zoo".

import type { GrammarIssue } from '../types';
import { matchCase } from './candidates';
import { typoCost, type ChannelOptions } from './channel';
import type { KeyboardLayout } from './keyboard';

const COST_WEIGHT = 2.5;
const FLOOR = 2;
const DOC_MAX = 2.5;
const MEMORY = 4;
const PICK = 5;
const ENGINE = [0.3, 0.15];
/** Words from the document are only considered this close to the typo: about two cheap slips or one real mistake and a bit. */
const DOC_MAX_COST = 1.6;
/** Top two closer than this: the sentence has to decide. */
export const CLOSE_CALL = 1;
const SHOWN = 6;

export interface VocabularyEntry {
  count: number;
  /** How the word is written in the document ("Hadamard"). */
  form: string;
}

export interface RankContext {
  layout: KeyboardLayout;
  /** Words of the document, lower case. */
  vocabulary?: Map<string, VocabularyEntry>;
  /** Corrections chosen before: typo (lower case) -> word (lower case) -> times. */
  memory?: Record<string, Record<string, number>>;
  /** Typing slips learned from `memory`, "intended>typed" -> times. */
  pairs?: Map<string, number>;
  /** The word the language model picked for this typo, judging by its sentence. */
  pick?: string;
}

export interface RankedSpelling {
  replacements: string[];
  scores: number[];
  /** No clear winner; worth asking the model with the sentence. */
  close: boolean;
}

export function rankSpelling(issue: GrammarIssue, ctx: RankContext): RankedSpelling {
  const typo = issue.text;
  const lower = typo.toLowerCase();
  const channel: ChannelOptions = { layout: ctx.layout, pairs: ctx.pairs };
  const remembered = ctx.memory?.[lower] ?? {};
  const pick = ctx.pick?.toLowerCase();

  const candidates = new Map<string, { form: string; zipf: number | null; engineRank: number }>();
  const add = (form: string, zipf: number | null, engineRank = -1) => {
    const key = form.toLowerCase();
    if (key === lower || candidates.has(key)) return;
    candidates.set(key, { form, zipf, engineRank });
  };
  const engineCount = issue.engineCount ?? issue.replacements.length;
  issue.replacements.forEach((r, i) => add(r, issue.zipf?.[i] ?? null, i < engineCount ? i : -1));
  for (const w of Object.keys(remembered)) add(matchCase(typo, w), null);
  if (ctx.vocabulary) {
    const len = [...lower].length;
    for (const [w, v] of ctx.vocabulary) {
      if (candidates.has(w) || w === lower || Math.abs([...w].length - len) > 2) continue;
      if (typoCost(typo, w, channel) <= DOC_MAX_COST) add(v.form === w ? matchCase(typo, w) : v.form, null);
    }
  }

  const scored = [...candidates].map(([key, c]) => {
    const multiWord = /\s/.test(c.form);
    let score = (c.zipf ?? FLOOR) - (multiWord ? 1 : 0) - COST_WEIGHT * typoCost(typo, c.form, channel);
    if (c.engineRank >= 0) score += ENGINE[c.engineRank] ?? 0;
    const inDoc = ctx.vocabulary?.get(key);
    if (inDoc) score += Math.min(DOC_MAX, 0.8 + 0.7 * Math.log(inDoc.count));
    const times = remembered[key] ?? 0;
    if (times) score += MEMORY + Math.log(times);
    if (pick && key === pick) score += PICK;
    return { form: c.form, score, decided: times > 0 || (pick !== undefined && key === pick) };
  });
  scored.sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  return {
    replacements: scored.slice(0, SHOWN).map((s) => s.form),
    scores: scored.slice(0, SHOWN).map((s) => s.score),
    close: !!first && !!second && !first.decided && first.score - second.score < CLOSE_CALL,
  };
}

const TOKEN = /\p{L}+(?:['’-]\p{L}+)*/gu;

/**
 * The document's words. A word the engine flags counts only if it is used at
 * least twice: a name like "Hadamard" that the engine does not know is offered
 * once the document has used it consistently, and a single typo is never
 * offered as the fix for another.
 */
export function buildVocabulary(texts: Iterable<string>, flagged: Set<string>, dictionary: string[] = []): Map<string, VocabularyEntry> {
  const counts = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const text of texts) {
    for (const m of text.matchAll(TOKEN)) {
      const form = m[0];
      if ([...form].length < 3) continue;
      const key = form.toLowerCase();
      const e = counts.get(key) ?? { count: 0, forms: new Map() };
      e.count++;
      e.forms.set(form, (e.forms.get(form) ?? 0) + 1);
      counts.set(key, e);
    }
  }
  const out = new Map<string, VocabularyEntry>();
  for (const [key, e] of counts) {
    // Lower case wins if the word is ever written that way: "The" at a sentence start is still "the".
    const lowerUses = e.forms.get(key) ?? 0;
    const form = lowerUses > 0 ? key : [...e.forms].sort((a, b) => b[1] - a[1])[0]![0];
    if (flagged.has(key) && e.count < 2) continue;
    out.set(key, { count: e.count, form });
  }
  for (const w of dictionary) {
    const key = w.toLowerCase();
    if (!out.has(key) && [...key].length >= 3) out.set(key, { count: 1, form: w });
  }
  return out;
}
