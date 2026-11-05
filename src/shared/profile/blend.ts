// Blending: combine several profiles with weights, e.g. 70% one author's rhythm
// and 30% another's precision. Overlapping moves are reported as conflicts for
// the user to resolve instead of being merged silently.

import { combineMetrics } from '../metrics';
import type { BlendConflict, BlendInput, StyleMove, TasteProfile } from '../types';
import { clampWeight, newProfile, uniqueId } from './model';
import { moveSimilarity, SIMILAR } from './similarity';

export interface BlendResult {
  profile: TasteProfile;
  conflicts: BlendConflict[];
}

export function blendProfiles(inputs: BlendInput[], name: string, takenProfileIds: Iterable<string> = []): BlendResult {
  const usable = inputs.filter((i) => i.weight > 0);
  const maxW = Math.max(0, ...usable.map((i) => i.weight)) || 1;
  const profile = newProfile(name, 'general', takenProfileIds);
  profile.description = 'Blend of ' + usable.map((i) => `${i.profile.name} (${Math.round(share(i, usable) * 100)}%)`).join(', ');
  profile.sources = dedupeSources(usable.flatMap((i) => i.profile.sources));
  profile.metrics = combineMetrics(
    usable.filter((i) => i.profile.metrics).map((i) => ({ metrics: i.profile.metrics!, weight: i.weight })),
  );

  const placed: { move: StyleMove; profileId: string }[] = [];
  const taken: string[] = [];
  for (const input of usable) {
    const scale = input.weight / maxW;
    for (const m of input.profile.moves) {
      const id = uniqueId(m.id, taken);
      taken.push(id);
      placed.push({
        profileId: input.profile.id,
        move: {
          ...structuredClone(m),
          id,
          weight: clampWeight(m.weight * scale),
          origin: 'blended',
          notes: [...m.notes, `from ${input.profile.name}`],
        },
      });
    }
  }
  profile.moves = placed.map((p) => p.move);
  return { profile, conflicts: findOverlaps(placed) };
}

function share(i: BlendInput, all: BlendInput[]): number {
  const total = all.reduce((a, x) => a + x.weight, 0) || 1;
  return i.weight / total;
}

function dedupeSources(sources: TasteProfile['sources']): TasteProfile['sources'] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = `${s.title}|${s.author ?? ''}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function findOverlaps(placed: { move: StyleMove; profileId: string }[]): BlendConflict[] {
  const out: BlendConflict[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.profileId === b.profileId) continue;
      const sim = moveSimilarity(a.move, b.move);
      if (sim < SIMILAR) continue;
      out.push({
        a: { profileId: a.profileId, moveId: a.move.id, title: a.move.title },
        b: { profileId: b.profileId, moveId: b.move.id, title: b.move.title },
        reason: `Both profiles have a move about "${a.move.title}"; they may pull in different directions.`,
      });
    }
  }
  return out;
}

export type ConflictChoice = 'a' | 'b' | 'both' | 'merge';

/** Apply the user's decision for one conflict to a blended profile. */
export function resolveConflict(profile: TasteProfile, conflict: BlendConflict, choice: ConflictChoice): TasteProfile {
  const a = profile.moves.find((m) => m.id === conflict.a.moveId);
  const b = profile.moves.find((m) => m.id === conflict.b.moveId);
  if (!a || !b || choice === 'both') return profile;
  if (choice === 'a') return { ...profile, moves: profile.moves.filter((m) => m.id !== b.id) };
  if (choice === 'b') return { ...profile, moves: profile.moves.filter((m) => m.id !== a.id) };
  const [lead, other] = a.weight >= b.weight ? [a, b] : [b, a];
  const merged: StyleMove = {
    ...lead,
    weight: clampWeight(Math.max(a.weight, b.weight)),
    description: [lead.description, other.description].filter(Boolean).join('\n\n'),
    rationale: [lead.rationale, other.rationale].filter(Boolean).join('\n\n'),
    examples: [...lead.examples, ...other.examples],
    notes: [...new Set([...lead.notes, ...other.notes])],
    scope: {
      docTypes: union(lead.scope.docTypes, other.scope.docTypes),
      sections: union(lead.scope.sections, other.scope.sections),
    },
  };
  return {
    ...profile,
    moves: profile.moves.filter((m) => m.id !== other.id).map((m) => (m.id === lead.id ? merged : m)),
  };
}

function union(a: string[], b: string[]): string[] {
  // An empty scope means "everywhere", which absorbs any narrower scope.
  if (!a.length || !b.length) return [];
  return [...new Set([...a, ...b])];
}
