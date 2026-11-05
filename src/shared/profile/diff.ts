// Re-extraction: compare a freshly extracted profile with the current one and
// let the user choose what to merge, instead of overwriting their edits.

import type { StyleMove, TasteProfile } from '../types';
import { touch, uniqueId } from './model';
import { moveSimilarity, SIMILAR } from './similarity';

export type DiffKind = 'added' | 'changed' | 'unchanged' | 'missing';

export interface DiffEntry {
  kind: DiffKind;
  /** Move in the current profile (changed, unchanged, missing). */
  current?: StyleMove;
  /** Move in the new extraction (added, changed, unchanged). */
  incoming?: StyleMove;
  /** Default decision: true = apply the incoming change / remove the missing move. */
  apply: boolean;
  /** Why the default is what it is, for display. */
  note?: string;
}

const contentKey = (m: StyleMove) =>
  [m.description.trim(), m.rationale.trim(), m.examples.filter((e) => e.kind === 'author').map((e) => e.text.trim()).join('|')].join('\n');

export function diffProfiles(current: TasteProfile, incoming: TasteProfile): DiffEntry[] {
  const unmatched = new Set(current.moves.map((m) => m.id));
  const entries: DiffEntry[] = [];

  for (const inc of incoming.moves) {
    let match = current.moves.find((m) => m.id === inc.id && unmatched.has(m.id));
    if (!match) {
      let best = 0;
      for (const m of current.moves) {
        if (!unmatched.has(m.id)) continue;
        const s = moveSimilarity(m, inc);
        if (s >= SIMILAR && s > best) {
          best = s;
          match = m;
        }
      }
    }
    if (!match) {
      entries.push({ kind: 'added', incoming: inc, apply: true });
      continue;
    }
    unmatched.delete(match.id);
    if (contentKey(match) === contentKey(inc)) {
      entries.push({ kind: 'unchanged', current: match, incoming: inc, apply: false });
    } else if (match.locked) {
      entries.push({ kind: 'changed', current: match, incoming: inc, apply: false, note: 'locked, so kept as is unless you apply it' });
    } else {
      entries.push({ kind: 'changed', current: match, incoming: inc, apply: true });
    }
  }

  for (const m of current.moves) {
    if (!unmatched.has(m.id)) continue;
    const note =
      m.origin !== 'extracted' ? `${m.origin} move, not affected by extraction` : m.locked ? 'locked' : 'not found in the new extraction';
    entries.push({ kind: 'missing', current: m, apply: false, note });
  }
  return entries;
}

/** Apply the chosen entries. Settings, stats, notes and your own examples always survive. */
export function mergeDiff(current: TasteProfile, incoming: TasteProfile, entries: DiffEntry[]): TasteProfile {
  let moves = current.moves.map((m) => structuredClone(m));
  const ids = () => moves.map((m) => m.id);

  for (const e of entries) {
    if (!e.apply) continue;
    if (e.kind === 'added' && e.incoming) {
      moves.push({ ...structuredClone(e.incoming), id: uniqueId(e.incoming.id, ids()), origin: 'extracted' });
    } else if (e.kind === 'changed' && e.current && e.incoming) {
      const inc = e.incoming;
      moves = moves.map((m) =>
        m.id === e.current!.id
          ? {
              ...m,
              title: inc.title,
              description: inc.description,
              rationale: inc.rationale,
              examples: [...inc.examples.filter((x) => x.kind === 'author'), ...m.examples.filter((x) => x.kind === 'user')],
            }
          : m,
      );
    } else if (e.kind === 'missing' && e.current) {
      moves = moves.filter((m) => m.id !== e.current!.id);
    }
  }

  const sourceKey = (s: { title: string; author?: string }) => `${s.title}|${s.author ?? ''}`.toLowerCase();
  const known = new Set(current.sources.map(sourceKey));
  return touch({
    ...current,
    moves,
    sources: [...current.sources, ...incoming.sources.filter((s) => !known.has(sourceKey(s)))],
    metrics: incoming.metrics ?? current.metrics,
  });
}
