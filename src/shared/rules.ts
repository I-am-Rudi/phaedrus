// Writing rules: explicit, checkable instructions ("define acronyms at first
// use", "no contractions") written by hand or extracted from documents that
// state them (journal author guides, a supervisor's notes). Unlike taste
// profiles they describe requirements, not an author's habits, so a violation
// is flagged regardless of weight and rejections add notes instead of fading.
//
// File format (Markdown, one file per rule set):
//   ---  frontmatter: gorgias-rules, id, name, language, description, sources
//   ## Rule title
//   ```yaml  id, enabled, locked, origin, source, scope, stats
//   Rule text
//   ### Do      - bullet examples that follow the rule
//   ### Don't   - bullet examples that break it
//   ### Notes   - bullets

import YAML from 'yaml';
import type { CheckContext } from './profile/model';
import { slugify, touch, uniqueId } from './profile/model';
import { moveSimilarity } from './profile/similarity';
import type { MoveScope, SourceRef } from './types';

export interface WritingRule {
  id: string;
  title: string;
  description: string;
  good: string[];
  bad: string[];
  enabled: boolean;
  locked: boolean;
  origin: 'manual' | 'extracted';
  /** Document the rule was extracted from. */
  source?: string;
  scope: MoveScope;
  notes: string[];
  stats: { accepted: number; rejected: number };
}

export interface RuleSet {
  id: string;
  name: string;
  language?: string;
  description: string;
  sources: SourceRef[];
  rules: WritingRule[];
  created: string;
  updated: string;
}

export function newRule(partial: Partial<WritingRule> & { title: string }, taken: Iterable<string> = []): WritingRule {
  return {
    id: partial.id ?? uniqueId(partial.title, taken),
    title: partial.title,
    description: partial.description ?? '',
    good: partial.good ?? [],
    bad: partial.bad ?? [],
    enabled: partial.enabled ?? true,
    locked: partial.locked ?? false,
    origin: partial.origin ?? 'manual',
    ...(partial.source ? { source: partial.source } : {}),
    scope: { docTypes: partial.scope?.docTypes ?? [], sections: partial.scope?.sections ?? [] },
    notes: partial.notes ?? [],
    stats: { accepted: 0, rejected: 0, ...partial.stats },
  };
}

export function newRuleSet(name: string, taken: Iterable<string> = []): RuleSet {
  const now = new Date().toISOString();
  return { id: uniqueId(name, taken), name, description: '', sources: [], rules: [], created: now, updated: now };
}

function inScope(list: string[], value: string): boolean {
  if (!list.length) return true;
  const v = value.trim().toLowerCase();
  return !!v && list.some((s) => v === s.trim().toLowerCase() || v.includes(s.trim().toLowerCase()));
}

export function ruleApplies(rule: WritingRule, ctx: CheckContext): boolean {
  return rule.enabled && inScope(rule.scope.docTypes, ctx.docType) && inScope(rule.scope.sections, ctx.section);
}

/** Rules from several active sets; ids are made unique across sets as "<set>/<rule>". */
export function activeRules(sets: RuleSet[], ctx: CheckContext): (WritingRule & { setId: string; key: string })[] {
  return sets.flatMap((s) => s.rules.filter((r) => ruleApplies(r, ctx)).map((r) => ({ ...r, setId: s.id, key: `${s.id}/${r.id}` })));
}

export type RuleEvent = { type: 'accept'; ruleId: string } | { type: 'reject'; ruleId: string; reason?: string; docType?: string };

export function applyRuleEvent(set: RuleSet, ev: RuleEvent): RuleSet {
  let changed = false;
  const rules = set.rules.map((r) => {
    if (r.id !== ev.ruleId || r.locked) return r;
    changed = true;
    if (ev.type === 'accept') return { ...r, stats: { ...r.stats, accepted: r.stats.accepted + 1 } };
    const reason = ev.reason?.trim();
    return {
      ...r,
      stats: { ...r.stats, rejected: r.stats.rejected + 1 },
      notes: reason ? [...r.notes, ev.docType ? `${reason} (in ${ev.docType})` : reason] : r.notes,
    };
  });
  return changed ? touch({ ...set, rules }) : set;
}

/** Add extracted rules, skipping ones that duplicate an existing rule. Returns the new set and the skipped titles. */
export function mergeRules(set: RuleSet, incoming: WritingRule[], sources: SourceRef[] = []): { set: RuleSet; skipped: string[] } {
  const rules = [...set.rules];
  const skipped: string[] = [];
  for (const r of incoming) {
    if (rules.some((x) => moveSimilarity(x, r) >= 0.6)) {
      skipped.push(r.title);
      continue;
    }
    rules.push({ ...r, id: uniqueId(r.id, rules.map((x) => x.id)) });
  }
  const key = (s: SourceRef) => `${s.title}|${s.author ?? ''}`.toLowerCase();
  const known = new Set(set.sources.map(key));
  return { set: touch({ ...set, rules, sources: [...set.sources, ...sources.filter((s) => !known.has(key(s)))] }), skipped };
}

// ------------------------------------------------------------------ Markdown

export function serializeRuleSet(s: RuleSet): string {
  const front: Record<string, unknown> = { 'gorgias-rules': 1, id: s.id, name: s.name };
  if (s.language) front.language = s.language;
  Object.assign(front, { description: s.description, sources: s.sources, created: s.created, updated: s.updated });
  const out = ['---', YAML.stringify(front).trimEnd(), '---', '', `# ${s.name}`, ''];
  for (const r of s.rules) {
    const settings: Record<string, unknown> = { id: r.id, enabled: r.enabled, locked: r.locked, origin: r.origin };
    if (r.source) settings.source = r.source;
    settings.scope = { doc_types: r.scope.docTypes, sections: r.scope.sections };
    settings.stats = r.stats;
    out.push(`## ${r.title.replace(/\n/g, ' ')}`, '', '```yaml', YAML.stringify(settings).trimEnd(), '```', '');
    if (r.description.trim()) out.push(r.description.trim(), '');
    if (r.good.length) out.push('### Do', '', ...r.good.map((g) => `- ${g.replace(/\n/g, ' ')}`), '');
    if (r.bad.length) out.push("### Don't", '', ...r.bad.map((g) => `- ${g.replace(/\n/g, ' ')}`), '');
    if (r.notes.length) out.push('### Notes', '', ...r.notes.map((g) => `- ${g.replace(/\n/g, ' ')}`), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function parseRuleSet(text: string, fallbackId = 'rules'): RuleSet {
  const normalized = text.replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const meta = ((fm ? YAML.parse(fm[1] ?? '') : {}) ?? {}) as Record<string, any>;
  const body = fm ? normalized.slice(fm[0].length) : normalized;
  let name = typeof meta.name === 'string' ? meta.name : '';
  const blocks: { title: string; lines: string[] }[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence) {
      const h1 = /^#\s+(.+?)\s*$/.exec(line);
      if (h1 && !cur) {
        name ||= h1[1]!;
        continue;
      }
      const h2 = /^##\s+(.+?)\s*$/.exec(line);
      if (h2) {
        cur = { title: h2[1]!, lines: [] };
        blocks.push(cur);
        continue;
      }
    }
    cur?.lines.push(line);
  }
  const taken: string[] = [];
  const rules = blocks.map((b) => {
    const r = parseRule(b.title, b.lines, taken);
    taken.push(r.id);
    return r;
  });
  const now = new Date().toISOString();
  return {
    id: typeof meta.id === 'string' && meta.id ? meta.id : slugify(name || fallbackId),
    name: name || fallbackId,
    ...(typeof meta.language === 'string' && meta.language ? { language: meta.language } : {}),
    description: typeof meta.description === 'string' ? meta.description : '',
    sources: Array.isArray(meta.sources) ? meta.sources.filter((s: any) => s?.title).map((s: any) => (s.author ? { title: String(s.title), author: String(s.author) } : { title: String(s.title) })) : [],
    rules,
    created: typeof meta.created === 'string' ? meta.created : now,
    updated: typeof meta.updated === 'string' ? meta.updated : now,
  };
}

function parseRule(title: string, lines: string[], taken: string[]): WritingRule {
  let i = 0;
  let settings: Record<string, any> = {};
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i < lines.length && /^```ya?ml\s*$/.test(lines[i]!.trim())) {
    const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l.trim()));
    if (end > i) {
      settings = (YAML.parse(lines.slice(i + 1, end).join('\n')) as Record<string, any>) ?? {};
      i = end + 1;
    }
  }
  const sections: Record<string, string[]> = { description: [] };
  let key = 'description';
  for (; i < lines.length; i++) {
    const h3 = /^###\s+(.+?)\s*$/.exec(lines[i]!);
    if (h3) {
      const h = h3[1]!.toLowerCase().replace(/[’']/g, "'");
      key = h.startsWith("don't") || h.startsWith('dont') || h.startsWith('avoid') ? 'bad' : h.startsWith('do') ? 'good' : h.startsWith('note') ? 'notes' : 'description';
      sections[key] ??= [];
      continue;
    }
    (sections[key] ??= []).push(lines[i]!);
  }
  const bullets = (ls: string[] = []) => ls.map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
  const scope = settings.scope ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const id = typeof settings.id === 'string' && settings.id && !taken.includes(settings.id) ? settings.id : uniqueId(title, taken);
  return newRule(
    {
      id,
      title,
      description: (sections.description ?? []).join('\n').trim(),
      good: bullets(sections.good),
      bad: bullets(sections.bad),
      notes: bullets(sections.notes),
      enabled: settings.enabled !== false,
      locked: settings.locked === true,
      origin: settings.origin === 'extracted' ? 'extracted' : 'manual',
      source: typeof settings.source === 'string' ? settings.source : undefined,
      scope: { docTypes: list(scope.doc_types), sections: list(scope.sections) },
      stats: { accepted: Number(settings.stats?.accepted) || 0, rejected: Number(settings.stats?.rejected) || 0 },
    },
    taken,
  );
}
