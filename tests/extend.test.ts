import { describe, expect, it } from 'vitest';
import { addMoves, splitForAdding } from '@shared/profile/diff';
import { newMove, newProfile } from '@shared/profile/model';
import { blendRuleSets, diffRules, mergeRuleDiff, newRule, newRuleSet } from '@shared/rules';

describe('adding to a profile', () => {
  const current = newProfile('Feynman', 'general');
  current.moves = [newMove({ id: 'short', title: 'Short declarative openers', description: 'Open with a short sentence that states the point.', weight: 0.8, locked: true })];
  current.metrics = { sentenceLengthMean: 14 } as never;
  const incoming = newProfile('Feynman', 'general');
  incoming.moves = [
    newMove({ id: 'short-2', title: 'Short declarative openers', description: 'Start paragraphs with a short sentence stating the point.' }),
    newMove({ id: 'analogy', title: 'Everyday analogies', description: 'Explain an abstract idea through a familiar object.' }),
  ];
  incoming.sources = [{ title: 'Lectures', author: 'Feynman' }];

  it('offers only moves the profile does not cover', () => {
    const split = splitForAdding(current, incoming);
    expect(split.fresh.map((m) => m.id)).toEqual(['analogy']);
    expect(split.covered[0]!.existing.id).toBe('short');
  });

  it('keeps every existing move and its settings, adds the chosen ones and the sources', () => {
    const p = addMoves(current, incoming, splitForAdding(current, incoming).fresh);
    expect(p.moves.map((m) => m.id)).toEqual(['short', 'analogy']);
    expect(p.moves[0]).toMatchObject({ weight: 0.8, locked: true });
    expect(p.sources).toEqual([{ title: 'Lectures', author: 'Feynman' }]);
    expect(p.metrics).toEqual(current.metrics);
  });
});

describe('rule sets', () => {
  const set = newRuleSet('Journal');
  set.rules = [
    newRule({ id: 'acronyms', title: 'Define acronyms at first use', description: 'Spell out an acronym the first time it appears.', origin: 'extracted', enabled: false }),
    newRule({ id: 'units', title: 'SI units with a thin space', description: 'Write 5\\,m, not 5m.', origin: 'extracted' }),
    newRule({ id: 'mine', title: 'No contractions', description: 'Write do not, not don\'t.', origin: 'manual' }),
  ];

  it('re-extraction diff marks changed, new and missing rules and keeps settings when merging', () => {
    const incoming = [
      newRule({ title: 'Define acronyms at first use', description: 'Define every acronym when it first appears in the text.' }),
      newRule({ title: 'Number equations that are referenced', description: 'Only number displayed equations you refer to.' }),
    ];
    const d = diffRules(set, incoming);
    expect(d.map((e) => e.kind).sort()).toEqual(['added', 'changed', 'missing', 'missing']);
    const merged = mergeRuleDiff(set, d.map((e) => (e.kind === 'missing' && e.current?.id === 'units' ? { ...e, apply: true } : e)));
    const acr = merged.rules.find((r) => r.id === 'acronyms')!;
    expect(acr.description).toMatch(/every acronym/);
    expect(acr.enabled).toBe(false);
    expect(merged.rules.map((r) => r.id)).not.toContain('units');
    expect(merged.rules.map((r) => r.id)).toContain('mine');
    expect(merged.rules).toHaveLength(3);
  });

  it('blending takes each rule once and lists repeats', () => {
    const other = newRuleSet('Supervisor');
    other.rules = [
      newRule({ id: 'acronyms', title: 'Define acronyms at first use', description: 'Spell out acronyms on first use.' }),
      newRule({ id: 'tense', title: 'Present tense for results', description: 'Describe your results in the present tense.' }),
    ];
    const b = blendRuleSets([set, other], 'Both');
    expect(b.set.rules.map((r) => r.title)).toEqual(['Define acronyms at first use', 'SI units with a thin space', 'No contractions', 'Present tense for results']);
    expect(b.overlaps).toHaveLength(1);
    expect(b.overlaps[0]!.dropped.from).toBe('Supervisor');
    expect(new Set(b.set.rules.map((r) => r.id)).size).toBe(4);
  });
});
