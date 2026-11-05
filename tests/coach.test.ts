import { describe, expect, it } from 'vitest';
import { checkStyle, editFeedback, extractProfile, findBlendConflicts, parseSuggestions, sampleSources, type LLM } from '@shared/coach';
import { extractJson } from '@shared/json';
import { computeMetrics, metricDrift, splitSentences } from '@shared/metrics';
import { newMove } from '@shared/profile/model';
import { codePointToUtf16, findQuote } from '@shared/spans';

const fixed = (reply: string): LLM & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, complete: async (r) => (calls.push(r.prompt), reply) };
};

describe('spans', () => {
  const text = 'The field “diverges” at short   distances. The field converges later.';
  it('finds exact and fuzzy quotes', () => {
    expect(findQuote(text, 'The field converges')).toEqual({ from: 43, to: 62 });
    const r = findQuote(text, 'the field "diverges" at short distances')!;
    expect(text.slice(r.from, r.to)).toBe('The field “diverges” at short   distances');
    expect(findQuote(text, 'not there')).toBeNull();
  });
  it('picks the occurrence nearest to a hint', () => {
    expect(findQuote(text, 'The field', 40)!.from).toBe(43);
  });
  it('converts code points to UTF-16', () => {
    expect(codePointToUtf16('a😀b', 2)).toBe(3);
  });
});

describe('metrics', () => {
  it('splits sentences around abbreviations', () => {
    expect(splitSentences('We use e.g. Monte Carlo. It works. Dr. Smith agrees!')).toEqual([
      'We use e.g. Monte Carlo.',
      'It works.',
      'Dr. Smith agrees!',
    ]);
  });
  it('measures and reports drift', () => {
    const terse = 'It works. We check it. The sum is finite. Nothing diverges. '.repeat(10);
    const m = computeMetrics(terse);
    expect(m.sentenceLengthMean).toBeLessThan(5);
    const rambling =
      'It might perhaps be argued that the procedure, which was introduced by several authors and which was later refined, could possibly yield results that are somewhat more reliable than expected. '.repeat(3);
    expect(metricDrift(rambling, m).map((d) => d.key)).toEqual(expect.arrayContaining(['sentenceLengthMean', 'hedgeRate']));
  });
});

describe('json extraction', () => {
  it('handles fences and chatter', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a": [1,2]} done')).toEqual({ a: [1, 2] });
  });
});

describe('style check', () => {
  const moves = [newMove({ title: 'Short openers', description: 'Open with a short claim.' })];
  const paragraph = 'In this paragraph we will now discuss the various aspects of renormalisation in curved spacetime. Then we compute.';

  it('keeps only suggestions whose quote and move exist', () => {
    const reply = JSON.stringify({
      suggestions: [
        { move_id: 'short-openers', quote: 'in this paragraph we will now discuss', issue: 'i', rewrite: 'r', explanation: 'e', hint_specific: 's', hint_general: 'g' },
        { move_id: 'unknown', quote: 'Then we compute.', issue: '', rewrite: '', explanation: '' },
        { move_id: 'short-openers', quote: 'invented text', issue: '', rewrite: '', explanation: '' },
      ],
    });
    const s = parseSuggestions(reply, { paragraph, moves });
    expect(s).toHaveLength(1);
    expect(s[0]!.quote).toBe('In this paragraph we will now discuss');
    expect(s[0]!.hints).toEqual({ specific: 's', general: 'g' });
  });

  it('skips the model for tiny paragraphs or no moves', async () => {
    const llm = fixed('{}');
    expect(await checkStyle(llm, { paragraph: 'Short.', moves, docType: '', section: '' })).toEqual([]);
    expect(await checkStyle(llm, { paragraph, moves: [], docType: '', section: '' })).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('includes user notes and context in the prompt', async () => {
    const llm = fixed('{"suggestions":[]}');
    const m = newMove({ title: 'Short openers', description: 'd', notes: ['too abrupt (in email)'] });
    await checkStyle(llm, { paragraph, before: 'Earlier.', moves: [m], docType: 'paper', section: 'Introduction' });
    expect(llm.calls[0]).toContain('user note: too abrupt (in email)');
    expect(llm.calls[0]).toContain('<context>Earlier.</context>');
    expect(llm.calls[0]).toContain('Section: Introduction');
  });
});

describe('extraction', () => {
  it('builds a profile from the model reply', async () => {
    const llm = fixed(
      JSON.stringify({
        description: 'Plain and direct.',
        moves: [
          { title: 'Short openers', description: 'd', rationale: 'r', importance: 0.9, examples: [{ text: 'Nature is simple.', source: 'L' }] },
          { title: '', description: 'ignored' },
        ],
      }),
    );
    const p = await extractProfile(llm, [{ name: 'Lectures', author: 'Feynman', text: 'Nature is simple. '.repeat(50) }], { name: 'Feynman' });
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0]).toMatchObject({ id: 'short-openers', weight: 0.9, origin: 'extracted' });
    expect(p.sources).toEqual([{ title: 'Lectures', author: 'Feynman' }]);
    expect(p.metrics!.words).toBe(150);
  });

  it('samples long sources within budget', () => {
    const long = { name: 'x', text: 'abcdefghij'.repeat(10_000) };
    const [s] = sampleSources([long], 10_000);
    expect(s!.text.length).toBeLessThan(10_100);
    expect(s!.text).toContain('[…]');
  });
});

describe('edit feedback and conflicts', () => {
  it('parses verdicts defensively', async () => {
    const move = newMove({ title: 'Short openers' });
    const fb = await editFeedback(fixed('{"verdict":"nonsense","feedback":"ok"}'), { move, issue: 'i', original: 'a', revised: 'b', paragraph: 'b' });
    expect(fb.verdict).toBe('partly');
    const deleted = await editFeedback(fixed('{}'), { move, issue: 'i', original: 'a', revised: ' ', paragraph: '' });
    expect(deleted.verdict).toBe('missed');
  });

  it('maps conflicts to known moves', async () => {
    const profile = {
      id: 'mix', name: 'Mix', kind: 'general' as const, description: '', sources: [], created: '', updated: '',
      moves: [newMove({ id: 'a', title: 'A', notes: ['from P'] }), newMove({ id: 'b', title: 'B', notes: ['from Q'] })],
    };
    const c = await findBlendConflicts(fixed('{"conflicts":[{"a":"a","b":"b","reason":"opposite"},{"a":"a","b":"zzz"}]}'), profile);
    expect(c).toEqual([{ a: { profileId: 'P', moveId: 'a', title: 'A' }, b: { profileId: 'Q', moveId: 'b', title: 'B' }, reason: 'opposite' }]);
  });
});

describe('batched style checks', () => {
  it('sends several paragraphs in one request and splits the reply by paragraph', async () => {
    const { checkStyleBatch } = await import('@shared/coach');
    const moves = [newMove({ title: 'Short openers', description: 'Open with a short claim.' })];
    const p1 = 'In this paragraph we will now discuss the various aspects of renormalisation in curved spacetime.';
    const p2 = 'Then we compute the expectation value of the stress tensor for a free scalar field.';
    const calls: string[] = [];
    const llm: LLM = {
      complete: async (r) => {
        calls.push(r.prompt);
        return JSON.stringify({
          suggestions: [
            { paragraph: 'a', move_id: 'short-openers', quote: 'In this paragraph we will now discuss', issue: 'i', rewrite: 'r', explanation: 'e' },
            { paragraph: 'b', move_id: 'short-openers', quote: 'Then we compute', issue: 'i', rewrite: 'r', explanation: 'e' },
            { paragraph: 'b', move_id: 'short-openers', quote: 'not in b', issue: 'i', rewrite: 'r', explanation: 'e' },
          ],
        });
      },
    };
    const out = await checkStyleBatch(llm, {
      paragraphs: [{ id: 'a', text: p1, section: 'Intro' }, { id: 'b', text: p2, section: 'Intro' }, { id: 'c', text: 'Too short.', section: 'Intro' }],
      moves, docType: 'paper',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('<paragraph id="a" section="Intro">');
    expect(out.a!.map((s) => s.quote)).toEqual(['In this paragraph we will now discuss']);
    expect(out.b!.map((s) => s.quote)).toEqual(['Then we compute']);
    expect(out.c).toEqual([]);
  });

  it('uses the single-paragraph prompt for one paragraph', async () => {
    const { checkStyleBatch } = await import('@shared/coach');
    const calls: string[] = [];
    const llm: LLM = { complete: async (r) => (calls.push(r.prompt), '{"suggestions":[]}') };
    await checkStyleBatch(llm, { paragraphs: [{ id: 'a', text: 'A paragraph that is long enough to be checked by the model.', section: '' }], moves: [newMove({ title: 'x' })], docType: '' });
    expect(calls[0]).toContain('<paragraph>');
  });
});
