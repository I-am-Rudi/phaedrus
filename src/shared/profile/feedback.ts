// How the profile learns from use. Every update skips locked moves.

import type { EditFeedback, StyleMove, TasteProfile } from '../types';
import { clampHint, clampWeight, touch } from './model';

/** Consecutive landed edits needed before a move's hints get less explicit. */
export const STREAK_TO_FADE = 3;
const MAX_USER_EXAMPLES = 5;

export type ProfileEvent =
  | { type: 'accept'; moveId: string }
  | { type: 'reject'; moveId: string; reason?: string; docType?: string }
  | { type: 'edit'; moveId: string; feedback: EditFeedback; revised: string };

export function applyEvent(profile: TasteProfile, event: ProfileEvent): TasteProfile {
  let changed = false;
  const moves = profile.moves.map((m) => {
    if (m.id !== event.moveId || m.locked) return m;
    changed = true;
    return updateMove(m, event);
  });
  return changed ? touch({ ...profile, moves }) : profile;
}

function updateMove(m: StyleMove, e: ProfileEvent): StyleMove {
  const stats = { ...m.stats };
  switch (e.type) {
    case 'accept':
      stats.accepted++;
      return { ...m, stats, weight: clampWeight(m.weight + 0.05 * (1 - m.weight)) };

    case 'reject': {
      stats.rejected++;
      const notes = [...m.notes];
      const reason = e.reason?.trim();
      if (reason) notes.push(e.docType ? `${reason} (in ${e.docType})` : reason);
      return { ...m, stats, notes, weight: clampWeight(m.weight * 0.9) };
    }

    case 'edit': {
      const { verdict, exemplary } = e.feedback;
      let hintLevel = m.hintLevel;
      if (verdict === 'landed') {
        stats.landed++;
        stats.streak++;
        if (stats.streak >= STREAK_TO_FADE) {
          hintLevel = clampHint(hintLevel - 1);
          stats.streak = 0;
        }
      } else if (verdict === 'missed' || verdict === 'overcorrected') {
        stats.missed++;
        stats.streak = 0;
        hintLevel = clampHint(Math.max(hintLevel + 1, 1));
      } else {
        stats.streak = 0;
      }
      let examples = m.examples;
      const revised = e.revised.trim();
      if (verdict === 'landed' && exemplary && revised && !examples.some((x) => x.text === revised)) {
        const own = examples.filter((x) => x.kind === 'user');
        const trimmedOwn = [...own, { text: revised, kind: 'user' as const }].slice(-MAX_USER_EXAMPLES);
        examples = [...examples.filter((x) => x.kind === 'author'), ...trimmedOwn];
      }
      return { ...m, stats, hintLevel, examples };
    }
  }
}

/** Pick the hint text to show in teacher mode, or null if the move is silent. */
export function hintFor(level: StyleMove['hintLevel'], hints: { specific: string; general: string }, moveTitle: string): string | null {
  switch (level) {
    case 3:
      return hints.specific || hints.general;
    case 2:
      return hints.general || hints.specific;
    case 1:
      return `Look at this against "${moveTitle}".`;
    default:
      return null;
  }
}
