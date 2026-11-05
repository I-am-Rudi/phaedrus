// Taste profiles are stored as plain Markdown so they can be read, diffed and
// edited by hand (Obsidian, Neovim, git). Layout:
//
//   ---                      <- YAML frontmatter: profile metadata + metrics
//   ...
//   ---
//   # Profile name
//   ## Move title            <- one H2 per move
//   ```yaml                  <- move settings
//   ...
//   ```
//   Description paragraphs
//   ### Why it works         <- rationale
//   ### Examples             <- blockquotes, last line "— source" ("— me" for your own)
//   ### Notes                <- bullet list

import YAML from 'yaml';
import type { Example, StyleMove, TasteProfile } from '../types';
import { clampHint, clampWeight, emptyStats, newMove, slugify, uniqueId } from './model';

const FORMAT_VERSION = 1;
const USER_MARK = 'me';

export function serializeProfile(p: TasteProfile): string {
  const front: Record<string, unknown> = {
    stylecoach: FORMAT_VERSION,
    id: p.id,
    name: p.name,
    kind: p.kind,
    description: p.description,
    sources: p.sources,
    created: p.created,
    updated: p.updated,
  };
  if (p.metrics) front.metrics = p.metrics;

  const out: string[] = ['---', YAML.stringify(front).trimEnd(), '---', '', `# ${p.name}`, ''];
  for (const m of p.moves) out.push(...serializeMove(m));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function serializeMove(m: StyleMove): string[] {
  const settings = {
    id: m.id,
    enabled: m.enabled,
    weight: m.weight,
    locked: m.locked,
    hint_level: m.hintLevel,
    origin: m.origin,
    scope: { doc_types: m.scope.docTypes, sections: m.scope.sections },
    stats: m.stats,
  };
  const lines = [`## ${m.title.replace(/\n/g, ' ')}`, '', '```yaml', YAML.stringify(settings).trimEnd(), '```', ''];
  if (m.description.trim()) lines.push(m.description.trim(), '');
  if (m.rationale.trim()) lines.push('### Why it works', '', m.rationale.trim(), '');
  if (m.examples.length) {
    lines.push('### Examples', '');
    for (const ex of m.examples) {
      for (const l of ex.text.trim().split('\n')) lines.push(`> ${l}`.trimEnd());
      const attribution = ex.kind === 'user' ? USER_MARK : ex.source?.trim();
      if (attribution) lines.push('>', `> — ${attribution}`);
      lines.push('');
    }
  }
  if (m.notes.length) {
    lines.push('### Notes', '');
    for (const n of m.notes) lines.push(`- ${n.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  return lines;
}

export class ProfileParseError extends Error {}

export function parseProfile(text: string, fallbackId = 'profile'): TasteProfile {
  const normalized = text.replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const front = (fm ? YAML.parse(fm[1] ?? '') : {}) as Record<string, any> | null;
  const meta = front ?? {};
  const body = fm ? normalized.slice(fm[0].length) : normalized;

  const lines = body.split('\n');
  let name = typeof meta.name === 'string' ? meta.name : '';
  const moveBlocks: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h1 = /^#\s+(.+?)\s*$/.exec(line);
      if (h1 && !current) {
        if (!name) name = h1[1] ?? '';
        continue;
      }
      const h2 = /^##\s+(.+?)\s*$/.exec(line);
      if (h2) {
        current = { title: h2[1] ?? '', lines: [] };
        moveBlocks.push(current);
        continue;
      }
    }
    current?.lines.push(line);
  }

  const taken: string[] = [];
  const moves = moveBlocks.map((b) => {
    const m = parseMove(b.title, b.lines, taken);
    taken.push(m.id);
    return m;
  });

  const now = new Date().toISOString();
  return {
    id: typeof meta.id === 'string' && meta.id ? meta.id : slugify(name || fallbackId),
    name: name || fallbackId,
    kind: meta.kind === 'project' ? 'project' : 'general',
    description: typeof meta.description === 'string' ? meta.description : '',
    sources: Array.isArray(meta.sources)
      ? meta.sources
          .filter((s: any) => s && typeof s.title === 'string')
          .map((s: any) => (s.author ? { title: s.title, author: String(s.author) } : { title: s.title }))
      : [],
    metrics: meta.metrics && typeof meta.metrics === 'object' ? meta.metrics : undefined,
    moves,
    created: typeof meta.created === 'string' ? meta.created : now,
    updated: typeof meta.updated === 'string' ? meta.updated : now,
  };
}

function parseMove(title: string, lines: string[], takenIds: string[]): StyleMove {
  let settings: Record<string, any> = {};
  let i = 0;
  // Leading blank lines, then an optional ```yaml block.
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
    const line = lines[i]!;
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      const h = (h3[1] ?? '').toLowerCase();
      key = h.startsWith('why') ? 'rationale' : h.startsWith('example') ? 'examples' : h.startsWith('note') ? 'notes' : 'description';
      sections[key] ??= [];
      continue;
    }
    (sections[key] ??= []).push(line);
  }

  const id = typeof settings.id === 'string' && settings.id && !takenIds.includes(settings.id)
    ? settings.id
    : uniqueId(title, takenIds);
  const scope = settings.scope ?? {};
  return newMove(
    {
      id,
      title,
      description: (sections.description ?? []).join('\n').trim(),
      rationale: (sections.rationale ?? []).join('\n').trim(),
      enabled: settings.enabled !== false,
      weight: clampWeight(Number(settings.weight ?? 0.6)),
      locked: settings.locked === true,
      hintLevel: clampHint(Number(settings.hint_level ?? 3)),
      origin: ['extracted', 'manual', 'blended'].includes(settings.origin) ? settings.origin : 'manual',
      scope: {
        docTypes: toStringList(scope.doc_types ?? scope.docTypes),
        sections: toStringList(scope.sections),
      },
      examples: parseExamples(sections.examples ?? []),
      notes: (sections.notes ?? [])
        .map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim())
        .filter((n): n is string => !!n),
      stats: { ...emptyStats(), ...pickNumbers(settings.stats) },
    },
    takenIds,
  );
}

function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function pickNumbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

function parseExamples(lines: string[]): Example[] {
  const quotes: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      if (!cur) {
        cur = [];
        quotes.push(cur);
      }
      cur.push(q[1] ?? '');
    } else {
      cur = null;
    }
  }
  return quotes
    .map((q) => {
      let source: string | undefined;
      const last = q[q.length - 1]?.trim() ?? '';
      const attr = /^[—–-]{1,2}\s*(.+)$/.exec(last);
      if (attr) {
        source = attr[1]!.trim();
        q = q.slice(0, -1);
      }
      const text = q.join('\n').trim();
      if (source === USER_MARK) return { text, kind: 'user' as const };
      return source ? { text, source, kind: 'author' as const } : { text, kind: 'author' as const };
    })
    .filter((e) => e.text.length > 0);
}
