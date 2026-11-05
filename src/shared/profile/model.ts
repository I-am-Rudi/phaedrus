import type { HintLevel, MoveStats, StyleMove, TasteProfile } from '../types';

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = slugify(base);
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function emptyStats(): MoveStats {
  return { accepted: 0, rejected: 0, landed: 0, missed: 0, streak: 0 };
}

export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, w)) * 1000) / 1000;
}

export function clampHint(h: number): HintLevel {
  const n = Math.round(Number.isFinite(h) ? h : 3);
  return Math.min(3, Math.max(0, n)) as HintLevel;
}

export function newMove(partial: Partial<StyleMove> & { title: string }, takenIds: Iterable<string> = []): StyleMove {
  return {
    id: partial.id ?? uniqueId(partial.title, takenIds),
    title: partial.title,
    description: partial.description ?? '',
    rationale: partial.rationale ?? '',
    enabled: partial.enabled ?? true,
    weight: clampWeight(partial.weight ?? 0.6),
    scope: { docTypes: partial.scope?.docTypes ?? [], sections: partial.scope?.sections ?? [] },
    locked: partial.locked ?? false,
    hintLevel: clampHint(partial.hintLevel ?? 3),
    origin: partial.origin ?? 'manual',
    examples: partial.examples ?? [],
    notes: partial.notes ?? [],
    stats: { ...emptyStats(), ...partial.stats },
  };
}

export function newProfile(name: string, kind: TasteProfile['kind'] = 'general', takenIds: Iterable<string> = []): TasteProfile {
  const now = new Date().toISOString();
  return {
    id: uniqueId(name, takenIds),
    name,
    kind,
    description: '',
    sources: [],
    moves: [],
    created: now,
    updated: now,
  };
}

export interface CheckContext {
  docType: string;
  section: string;
}

function inScope(list: string[], value: string): boolean {
  if (list.length === 0) return true;
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return list.some((s) => {
    const t = s.trim().toLowerCase();
    return t === v || v.includes(t);
  });
}

export function moveApplies(move: StyleMove, ctx: CheckContext): boolean {
  return (
    move.enabled &&
    move.weight > 0 &&
    inScope(move.scope.docTypes, ctx.docType) &&
    inScope(move.scope.sections, ctx.section)
  );
}

/**
 * Combine the general and the project profile into the moves that apply here.
 * Project moves override general moves with the same id.
 */
export function effectiveMoves(
  general: TasteProfile | null,
  project: TasteProfile | null,
  ctx: CheckContext,
): StyleMove[] {
  const byId = new Map<string, StyleMove>();
  for (const m of general?.moves ?? []) byId.set(m.id, m);
  for (const m of project?.moves ?? []) byId.set(m.id, m);
  return [...byId.values()].filter((m) => moveApplies(m, ctx)).sort((a, b) => b.weight - a.weight);
}

/** Find which profile (project first) owns a move id. */
export function ownerOf(moveId: string, general: TasteProfile | null, project: TasteProfile | null): TasteProfile | null {
  if (project?.moves.some((m) => m.id === moveId)) return project;
  if (general?.moves.some((m) => m.id === moveId)) return general;
  return null;
}

export function touch<T extends { updated: string }>(item: T): T {
  return { ...item, updated: new Date().toISOString() };
}
