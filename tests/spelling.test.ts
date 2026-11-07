import { describe, expect, it } from 'vitest';
import { expandSpelling, generateCandidates, matchCase } from '../src/shared/spelling/candidates';
import { typoCost } from '../src/shared/spelling/channel';
import { areNeighbours, layoutForLocale } from '../src/shared/spelling/keyboard';
import { learnedPairs, MEMORY_LIMIT, rememberChoice } from '../src/shared/spelling/memory';
import { buildVocabulary, rankSpelling, type RankContext } from '../src/shared/spelling/rank';
import { loadWordList } from '../src/shared/spelling/wordlist';
import type { GrammarIssue } from '../src/shared/types';

const issue = (text: string, replacements: string[]): GrammarIssue => ({
  category: 'spelling',
  from: 0,
  to: text.length,
  text,
  message: '',
  replacements,
  ruleId: 'Spelling',
  engine: 'harper',
});

// Real engines accept these; the frequency list also has misspellings, which they reject.
const NOT_WORDS = new Set(['teh', 'alot', 'recieve', 'thier', 'dont', 'im', 'wich', 'definately']);
const validate = async (words: string[]) => new Set(words.filter((w) => !NOT_WORDS.has(w)));

/** Harper's suggestions -> expanded -> ranked, as the app does it. */
async function top(text: string, harper: string[], ctx: Partial<RankContext> = {}) {
  const [expanded] = await expandSpelling([issue(text, harper)], 'en', validate);
  return rankSpelling(expanded!, { layout: 'qwerty', ...ctx });
}

describe('keyboard and typo cost', () => {
  it('knows neighbouring keys per layout', () => {
    expect(areNeighbours('s', 'w', 'qwerty')).toBe(true);
    expect(areNeighbours('s', 'x', 'qwerty')).toBe(true);
    expect(areNeighbours('s', 'p', 'qwerty')).toBe(false);
    expect(areNeighbours('z', 't', 'qwertz')).toBe(true);
    expect(areNeighbours('z', 't', 'qwerty')).toBe(false);
  });

  it('guesses the layout from the locale', () => {
    expect(layoutForLocale('de-DE')).toBe('qwertz');
    expect(layoutForLocale('fr-FR')).toBe('azerty');
    expect(layoutForLocale('fr-CA')).toBe('qwerty');
    expect(layoutForLocale('en-US')).toBe('qwerty');
    expect(layoutForLocale('pl-PL')).toBe('qwerty');
  });

  it('makes common slips cheap', () => {
    const q = { layout: 'qwertz' as const };
    expect(typoCost('zou', 'you', q)).toBe(0.25); // y and z swapped
    expect(typoCost('zou', 'you', { layout: 'qwerty' })).toBe(1.2);
    expect(typoCost('teh', 'the', q)).toBe(0.6); // transposed
    expect(typoCost('hapen', 'happen', q)).toBe(0.5); // one of a double letter
    expect(typoCost('untill', 'until', q)).toBe(0.5); // a letter typed twice
    expect(typoCost('tge', 'the', q)).toBe(0.6); // neighbouring key
    expect(typoCost('Schon', 'schön', q)).toBe(0.3); // accent, any case
    expect(typoCost('zoo', 'zoo', q)).toBe(0);
    expect(typoCost('fomr', 'from', q)).toBe(0.9); // one letter two places late
    expect(typoCost('fomr', 'form', q)).toBe(0.6);
  });

  it('learns slips the writer keeps making', () => {
    const pairs = new Map([['e>i', 3]]);
    expect(typoCost('rid', 'red', { layout: 'qwerty', pairs })).toBe(0.6);
    expect(typoCost('rid', 'red', { layout: 'qwerty' })).toBe(1.2);
  });
});

describe('candidates', () => {
  it('adds the words the engine missed, if the engine accepts them', async () => {
    const list = (await loadWordList('en-GB'))!;
    expect(generateCandidates('papre', list)).toContain('paper');
    expect(generateCandidates('tje', list)).toContain('the');
    expect(generateCandidates('fomr', list)).toContain('from');
    const [x] = await expandSpelling([issue('Teh', ['The', 'Tea'])], 'en', validate);
    expect(x!.engineCount).toBe(2);
    expect(x!.replacements.slice(0, 2)).toEqual(['The', 'Tea']);
    expect(x!.replacements.map((r) => r.toLowerCase())).not.toContain('teh');
    expect(x!.zipf?.[0]).toBeGreaterThan(7);
  });

  it('keeps the engine suggestions when there is no word list or the check fails', async () => {
    const i = issue('xyzzy', ['xyz']);
    expect(await expandSpelling([i], 'auto', validate)).toEqual([i]);
    const [x] = await expandSpelling([issue('papre', ['pa pre'])], 'en', async () => {
      throw new Error('engine down');
    });
    expect(x!.replacements).toEqual(['pa pre']);
  });

  it('copies the capitalisation of the typo', () => {
    expect(matchCase('Teh', 'the')).toBe('The');
    expect(matchCase('TEH', 'the')).toBe('THE');
    expect(matchCase('teh', 'the')).toBe('the');
    expect(matchCase('teh', 'Hadamard')).toBe('Hadamard');
  });
});

describe('ranking (inputs are what Harper actually suggests)', () => {
  it('puts the common word first: zou -> you', async () => {
    expect((await top('zou', ['zoo', 'sou', 'you'], { layout: 'qwertz' })).replacements[0]).toBe('you');
    expect((await top('zou', ['zoo', 'sou', 'you'], { layout: 'qwerty' })).replacements[0]).toBe('you');
  });

  it('fixes the other cases Harper ranks wrongly', async () => {
    expect((await top('ture', ['tire', 'tore', 'true'])).replacements[0]).toBe('true');
    expect((await top('fidn', ['fin', 'find', 'fad'])).replacements[0]).toBe('find');
    expect((await top('papre', ['pa pre'])).replacements[0]).toBe('paper');
    expect((await top('Thsi', ['This', 'Thai', 'Than'])).replacements[0]).toBe('This');
  });

  it('keeps what Harper already gets right', async () => {
    expect((await top('simpel', ['simple', 'simped', 'simper'])).replacements[0]).toBe('simple');
    expect((await top('recieve', ['receive', 'relieve', 'recipe'])).replacements[0]).toBe('receive');
    expect((await top('importnat', ['important', 'importunate'])).replacements[0]).toBe('important');
    expect((await top('equaiton', ['equation', 'equator', 'equations'])).replacements[0]).toBe('equation');
    expect((await top('zoi', ['zoo', 'moi', 'oi'])).replacements[0]).toBe('zoo');
  });

  it('offers a name the document uses consistently', async () => {
    const vocabulary = buildVocabulary(
      ['The Hadamard parametrix fixes the Hadamard state.', 'Hadamard showed it.', 'We use the Hadamrd form.'],
      new Set(['hadamard', 'hadamrd', 'parametrix']),
    );
    expect(vocabulary.get('hadamard')?.form).toBe('Hadamard');
    expect(vocabulary.has('hadamrd')).toBe(false); // a single flagged word is not vocabulary
    const r = await top('Hadamrd', ['Hazard', 'Hadar'], { vocabulary });
    expect(r.replacements[0]).toBe('Hadamard');
    // Other words of the document are not offered unless they are close: "for" is not a fix for "zou".
    const doc = buildVocabulary(['Thank zou for the help, and we went to Jena.'], new Set(['zou', 'jena']));
    expect((await top('zou', ['zoo', 'sou', 'you'], { vocabulary: doc })).replacements).not.toContain('for');
  });

  it('puts an earlier choice first and learns the slip behind it', async () => {
    let memory = rememberChoice({}, 'lable', 'table');
    expect((await top('lable', ['label', 'table', 'able'], { memory })).replacements[0]).toBe('table');
    memory = rememberChoice(rememberChoice({}, 'zou', 'you'), 'yero', 'zero');
    expect(learnedPairs(memory)).toEqual(new Map([['y>z', 1], ['z>y', 1]]));
  });

  it('flags a close call for the model, and the model can settle it', async () => {
    // "fomr": "from" (r two places late), "form" (two letters swapped) or "for" (a stray m).
    // Harper offers for, form, four; "from" comes from the word list.
    const r = await top('fomr', ['for', 'form', 'four']);
    expect(r.replacements.slice(0, 3)).toEqual(expect.arrayContaining(['from', 'form', 'for']));
    expect(r.close).toBe(true);
    const picked = await top('fomr', ['for', 'form', 'four'], { pick: 'form' });
    expect(picked.replacements[0]).toBe('form');
    expect(picked.close).toBe(false);
    expect((await top('zou', ['zoo', 'sou', 'you'])).close).toBe(false);
    expect((await top('lable', ['label', 'table', 'able'])).close).toBe(false);
  });

  it('forgets the least used typos past the limit', () => {
    let memory = {};
    for (let i = 0; i < MEMORY_LIMIT + 5; i++) memory = rememberChoice(memory, `typo${i}`, `word${i}`);
    memory = rememberChoice(memory, 'typo0', 'word0');
    expect(Object.keys(memory)).toHaveLength(MEMORY_LIMIT);
    expect(memory).toHaveProperty('typo0');
  });
});

describe('with the Harper engine', () => {
  it('ranks real results and never offers what Harper rejects', async () => {
    const { checkGrammar } = await import('../src/main/grammar');
    const cfg = { engine: 'harper' as const, languageToolUrl: '', language: 'en-GB', harperDialect: 'british' as const, keyboard: 'auto' as const };
    const issues = await checkGrammar('Thank zou for the help. We bring the papre. This is ture.', cfg);
    const best = (word: string) => {
      const i = issues.find((x) => x.text === word)!;
      return rankSpelling(i, { layout: 'qwertz' }).replacements[0];
    };
    expect(best('zou')).toBe('you');
    expect(best('papre')).toBe('paper');
    expect(best('ture')).toBe('true');
    // Common misspellings are in the frequency list but must never be suggested.
    const all = issues.flatMap((i) => i.replacements.map((r) => r.toLowerCase()));
    for (const bad of ['teh', 'alot', 'dont', 'thier']) expect(all).not.toContain(bad);
    // "tehs" -> "teh" is one edit and "teh" is in the list, so only the engine check keeps it out.
    expect(generateCandidates('tehs', (await loadWordList('en'))!)).toContain('teh');
    const [tehs] = await checkGrammar('We read tehs paper.', cfg);
    expect(tehs!.text).toBe('tehs');
    expect(tehs!.replacements.length).toBeGreaterThan(tehs!.engineCount!); // some generated words got through
    expect(tehs!.replacements.map((r) => r.toLowerCase())).not.toContain('teh');
  });
});
