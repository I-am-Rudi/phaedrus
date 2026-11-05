import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_TELLS_ID, aiTellsRuleSet } from '@shared/defaults/aiTells';
import { effectiveMoves, newMove, newProfile } from '@shared/profile/model';
import { parseRuleSet, serializeRuleSet } from '@shared/rules';
import { Store } from '../src/main/store';

const plain = { available: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };

describe('built-in "Signs of AI writing" rule set', () => {
  it('survives the Markdown round trip', () => {
    const set = aiTellsRuleSet();
    const back = parseRuleSet(serializeRuleSet(set), set.id);
    expect(back.name).toBe(set.name);
    expect(back.language).toBe('en');
    expect(back.rules.map((r) => r.id)).toEqual(set.rules.map((r) => r.id));
    expect(back.rules.map((r) => r.description)).toEqual(set.rules.map((r) => r.description));
    expect(back.rules.find((r) => r.id === 'dashes')!.notes.length).toBe(2);
    expect(new Set(set.rules.map((r) => r.id)).size).toBe(set.rules.length);
  });

  it('is seeded once and switched on, and stays deleted when the user deletes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phaedrus-seed-'));
    const s = new Store(dir, plain);
    await s.seedDefaults();
    expect((await s.listRuleSets()).map((r) => r.id)).toContain(AI_TELLS_ID);
    expect((await s.getSettings()).alwaysOnRules).toEqual([AI_TELLS_ID]);

    await s.setSettings({ alwaysOnRules: [] });
    await s.removeRuleSet(AI_TELLS_ID);
    await new Store(dir, plain).seedDefaults();
    const fresh = new Store(dir, plain);
    expect((await fresh.listRuleSets()).map((r) => r.id)).not.toContain(AI_TELLS_ID);
    expect((await fresh.getSettings()).alwaysOnRules).toEqual([]);
    await rm(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('always-on profiles', () => {
  it('add their moves; chosen profiles override them by id', () => {
    const always = newProfile('Plain', 'general');
    always.moves = [newMove({ id: 'short', title: 'Short sentences (always)' }), newMove({ id: 'concrete', title: 'Concrete claims' })];
    const general = newProfile('Author', 'general');
    general.moves = [newMove({ id: 'short', title: 'Short sentences (author)' })];
    const moves = effectiveMoves(general, null, { docType: 'paper', section: '' }, [always]);
    expect(moves.map((m) => m.title).sort()).toEqual(['Concrete claims', 'Short sentences (author)']);
  });
});
