// How often the intended word comes first, Harper's order vs the ranking in
// src/shared/spelling. Not part of the normal run: it needs test data that is
// not in the repo. Peter Norvig's sets from the Birkbeck spelling error corpus
// (lines like "beginning:true:begining") work, e.g. spell-testset1.txt and
// spell-testset2.txt as found in many repositories on GitHub:
//
//   SPELLING_EVAL=path/to/spell-testset1.txt,path/to/spell-testset2.txt npx vitest run tests/spelling-eval.test.ts
//
// On 2026-11-07 it gave, first place: 69.5% -> 80.1% and 71.1% -> 84.0%.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkGrammar } from '../src/main/grammar';
import { rankSpelling } from '../src/shared/spelling/rank';

const sets = (process.env.SPELLING_EVAL ?? '').split(',').filter(Boolean);
const cfg = { engine: 'harper' as const, languageToolUrl: '', language: 'en-US', harperDialect: 'american' as const, keyboard: 'auto' as const };

describe.skipIf(!sets.length)('spelling evaluation', () => {
  for (const file of sets) {
    it(file.split('/').pop()!, async () => {
      const pairs: [string, string][] = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const [right, , wrongs] = line.split(':');
        if (right && wrongs) for (const w of wrongs.split(',')) if (w.trim()) pairs.push([w.trim(), right.trim().toLowerCase()]);
      }
      const n = { flagged: 0, before1: 0, before3: 0, after1: 0, after3: 0 };
      for (const [typo, right] of pairs) {
        const issue = (await checkGrammar(typo, cfg)).find((x) => x.category === 'spelling' && x.text.toLowerCase() === typo.toLowerCase());
        if (!issue) continue;
        n.flagged++;
        const engine = issue.replacements.slice(0, issue.engineCount ?? issue.replacements.length).map((r) => r.toLowerCase());
        const ranked = rankSpelling(issue, { layout: 'qwerty' }).replacements.map((r) => r.toLowerCase());
        if (engine[0] === right) n.before1++;
        if (engine.slice(0, 3).includes(right)) n.before3++;
        if (ranked[0] === right) n.after1++;
        if (ranked.slice(0, 3).includes(right)) n.after3++;
      }
      const pct = (k: number) => `${((100 * k) / n.flagged).toFixed(1)}%`;
      console.log(`${pairs.length} pairs, ${n.flagged} flagged. First: ${pct(n.before1)} -> ${pct(n.after1)}. Top 3: ${pct(n.before3)} -> ${pct(n.after3)}.`);
      expect(n.after1).toBeGreaterThanOrEqual(n.before1);
    }, 600_000);
  }
});
