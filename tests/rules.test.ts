import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkStyle, extractRules, parseSuggestions, type LLM } from '@shared/coach';
import { activeRules, applyRuleEvent, mergeRules, newRule, newRuleSet, parseRuleSet, serializeRuleSet } from '@shared/rules';
import { Store } from '../src/main/store';

function sample() {
  const s = newRuleSet('Thesis rules');
  s.language = 'en-GB';
  s.sources = [{ title: 'Author guide' }];
  s.rules = [
    newRule({ title: 'No contractions', description: 'Write words in full.', good: ['It is finite.'], bad: ["It's finite."], notes: ['fine in quotes'] }),
    newRule({ title: 'Define acronyms at first use', description: 'Spell out acronyms once.', origin: 'extracted', source: 'Author guide', scope: { docTypes: [], sections: ['introduction'] } }, ['no-contractions']),
  ];
  return s;
}

describe('rule sets', () => {
  it('round-trip through Markdown', () => {
    const s = sample();
    expect(parseRuleSet(serializeRuleSet(s))).toEqual(s);
  });

  it('read a hand-written file', () => {
    const s = parseRuleSet("# House rules\n\n## Use SI units\n\nAlways SI, with a thin space.\n\n### Don't\n\n- 3kg\n");
    expect(s.name).toBe('House rules');
    expect(s.rules[0]).toMatchObject({ id: 'use-si-units', description: 'Always SI, with a thin space.', bad: ['3kg'], enabled: true });
  });

  it('scope rules by section and key them by set', () => {
    const rules = activeRules([sample()], { docType: 'paper', section: 'Methods' });
    expect(rules.map((r) => r.key)).toEqual(['thesis-rules/no-contractions']);
    expect(activeRules([sample()], { docType: 'paper', section: 'Introduction' })).toHaveLength(2);
  });

  it('record accepts and rejections as notes, never on locked rules', () => {
    let s = applyRuleEvent(sample(), { type: 'reject', ruleId: 'no-contractions', reason: 'quoting speech', docType: 'blog' });
    expect(s.rules[0]!.notes).toContain('quoting speech (in blog)');
    s = applyRuleEvent(s, { type: 'accept', ruleId: 'no-contractions' });
    expect(s.rules[0]!.stats).toEqual({ accepted: 1, rejected: 1 });
    const locked = sample();
    locked.rules[0]!.locked = true;
    expect(applyRuleEvent(locked, { type: 'accept', ruleId: 'no-contractions' })).toBe(locked);
  });

  it('merge extracted rules without duplicates', () => {
    const { set, skipped } = mergeRules(sample(), [
      newRule({ title: 'No contractions in the text', description: 'Write words in full.' }),
      newRule({ title: 'Number equations consecutively' }),
    ], [{ title: 'Journal guide' }]);
    expect(skipped).toEqual(['No contractions in the text']);
    expect(set.rules.map((r) => r.title)).toContain('Number equations consecutively');
    expect(set.sources.map((s) => s.title)).toEqual(['Author guide', 'Journal guide']);
  });

  it('are stored in their own folder with history', async () => {
    const store = new Store(await mkdtemp(join(tmpdir(), 'gorgias-rules-')), { available: () => false, encrypt: (x) => x, decrypt: (x) => x });
    await store.saveRuleSet(sample(), 'create');
    await store.saveRuleSet({ ...sample(), rules: [] }, 'edit');
    expect(await store.listRuleSets()).toEqual([expect.objectContaining({ id: 'thesis-rules', rules: 0, language: 'en-GB' })]);
    expect((await store.listProfiles()).length).toBe(0);
  });
});

describe('rules in checks', () => {
  const rules = activeRules([sample()], { docType: 'paper', section: '' });
  const paragraph = "It's clear that the integral converges for all positive values of the coupling.";

  it('a style check with only rules still runs and parses rule violations', async () => {
    const calls: string[] = [];
    const llm: LLM = {
      complete: async (r) => {
        calls.push(r.prompt);
        return JSON.stringify({ suggestions: [{ rule_id: 'thesis-rules/no-contractions', quote: "It's", issue: 'contraction', rewrite: 'It is', explanation: 'e' }] });
      },
    };
    const out = await checkStyle(llm, { paragraph, moves: [], rules, docType: 'paper', section: '' });
    expect(out).toEqual([expect.objectContaining({ moveId: '', ruleKey: 'thesis-rules/no-contractions', quote: "It's", rewrite: 'It is' })]);
    expect(calls[0]).toContain('- rule: thesis-rules/no-contractions | No contractions');
    expect(calls[0]).toContain('user note: fine in quotes');
  });

  it('ignores unknown rule ids', () => {
    const reply = JSON.stringify({ suggestions: [{ rule_id: 'other/x', quote: "It's", issue: '', rewrite: 'It is', explanation: '' }] });
    expect(parseSuggestions(reply, { paragraph, moves: [], rules })).toEqual([]);
  });

  it('extracts rules from a reply', async () => {
    const llm: LLM = {
      complete: async () =>
        JSON.stringify({ rules: [{ title: 'Use SI units', description: 'SI with thin space', do: ['3 kg'], dont: ['3kg'], applies_to: 'Methods', source: 'Guide' }, { title: '' }] }),
    };
    const out = await extractRules(llm, [{ name: 'Guide', text: '- Use SI units' }]);
    expect(out).toEqual([expect.objectContaining({ title: 'Use SI units', good: ['3 kg'], bad: ['3kg'], origin: 'extracted', source: 'Guide', scope: { docTypes: [], sections: ['Methods'] } })]);
  });
});
