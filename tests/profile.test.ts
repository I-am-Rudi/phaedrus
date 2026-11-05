import { describe, expect, it } from 'vitest';
import { blendProfiles, resolveConflict } from '@shared/profile/blend';
import { diffProfiles, mergeDiff } from '@shared/profile/diff';
import { applyExcerptPolicy, exportBundle, exportMarkdown, importProfile } from '@shared/profile/exchange';
import { applyEvent, hintFor, STREAK_TO_FADE } from '@shared/profile/feedback';
import { parseProfile, serializeProfile } from '@shared/profile/markdown';
import { effectiveMoves, newMove, newProfile } from '@shared/profile/model';
import type { TasteProfile } from '@shared/types';

function sample(): TasteProfile {
  const p = newProfile('Plain Physics');
  p.description = 'Direct, concrete, conversational.';
  p.sources = [{ title: 'Lectures', author: 'R. Feynman' }];
  p.moves = [
    newMove({
      title: 'Short declarative openers',
      description: 'Open paragraphs with a short sentence that states the point.',
      rationale: 'The reader knows where the paragraph is going.',
      weight: 0.8,
      origin: 'extracted',
      scope: { docTypes: ['blog'], sections: [] },
      examples: [
        { text: 'Nature is simple.', source: 'Lectures', kind: 'author' },
        { text: 'The integral diverges.', kind: 'user' },
      ],
      notes: ['not in abstracts'],
    }),
    newMove({ title: 'Concrete example before the rule', description: 'Show a case, then generalise.', weight: 0.5 }, ['short-declarative-openers']),
  ];
  return p;
}

describe('markdown round trip', () => {
  it('preserves every field', () => {
    const p = sample();
    const back = parseProfile(serializeProfile(p));
    expect(back).toEqual(p);
  });

  it('reads a hand-written profile without settings blocks', () => {
    const md = `# My style

## No throat clearing

Start with the claim, not with "In this section we will".

### Examples

> We compute the amplitude directly.
>
> Source: me
`;
    const p = parseProfile(md, 'mine');
    expect(p.name).toBe('My style');
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0]!.id).toBe('no-throat-clearing');
    expect(p.moves[0]!.enabled).toBe(true);
    expect(p.moves[0]!.examples).toEqual([{ text: 'We compute the amplitude directly.', kind: 'user' }]);
  });

  it('does not treat headings inside code fences as moves', () => {
    const md = '# P\n\n## Real move\n\n```yaml\nid: real\n```\n\nText\n\n```\n## not a move\n```\n';
    expect(parseProfile(md).moves.map((m) => m.title)).toEqual(['Real move']);
  });
});

describe('scope', () => {
  it('filters by document type and lets project moves override', () => {
    const general = sample();
    const project = newProfile('Thesis', 'project');
    project.moves = [newMove({ id: 'concrete-example-before-the-rule', title: 'Concrete example before the rule', weight: 0.9 })];
    const blog = effectiveMoves(general, project, { docType: 'blog', section: '' });
    expect(blog.map((m) => m.id)).toEqual(['concrete-example-before-the-rule', 'short-declarative-openers']);
    expect(blog[0]!.weight).toBe(0.9);
    const paper = effectiveMoves(general, project, { docType: 'paper', section: '' });
    expect(paper.map((m) => m.id)).toEqual(['concrete-example-before-the-rule']);
  });
});

describe('feedback', () => {
  it('accept/reject adjust weight and record notes', () => {
    let p = sample();
    p = applyEvent(p, { type: 'accept', moveId: 'short-declarative-openers' });
    expect(p.moves[0]!.weight).toBeGreaterThan(0.8);
    p = applyEvent(p, { type: 'reject', moveId: 'short-declarative-openers', reason: 'too abrupt', docType: 'email' });
    expect(p.moves[0]!.stats).toMatchObject({ accepted: 1, rejected: 1 });
    expect(p.moves[0]!.notes).toContain('too abrupt (in email)');
  });

  it('never touches locked moves', () => {
    const p = sample();
    p.moves[0]!.locked = true;
    expect(applyEvent(p, { type: 'accept', moveId: 'short-declarative-openers' })).toBe(p);
  });

  it('fades hints after a streak and keeps exemplary revisions', () => {
    let p = sample();
    const id = 'short-declarative-openers';
    for (let i = 0; i < STREAK_TO_FADE; i++) {
      p = applyEvent(p, { type: 'edit', moveId: id, revised: `Sentence ${i}.`, feedback: { verdict: 'landed', feedback: '', exemplary: i === 0 } });
    }
    const m = p.moves[0]!;
    expect(m.hintLevel).toBe(2);
    expect(m.examples.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['The integral diverges.', 'Sentence 0.']);
    p = applyEvent(p, { type: 'edit', moveId: id, revised: 'x', feedback: { verdict: 'missed', feedback: '', exemplary: false } });
    expect(p.moves[0]!.hintLevel).toBe(3);
  });

  it('chooses hint text by level', () => {
    const h = { specific: 'What is the point of this paragraph?', general: 'Short openers: look at the first sentence.' };
    expect(hintFor(3, h, 'x')).toBe(h.specific);
    expect(hintFor(2, h, 'x')).toBe(h.general);
    expect(hintFor(1, h, 'Openers')).toContain('Openers');
    expect(hintFor(0, h, 'x')).toBeNull();
  });
});

describe('export', () => {
  it('strips author excerpts but keeps the user\'s own', () => {
    const p = sample();
    p.moves[0]!.examples.push({ text: Array(30).fill('word').join(' '), source: 'Long', kind: 'author' });
    const none = applyExcerptPolicy(p, 'none');
    expect(none.moves[0]!.examples).toEqual([{ text: 'The integral diverges.', kind: 'user' }]);
    const short = applyExcerptPolicy(p, 'short');
    expect(short.moves[0]!.examples.map((e) => e.text)).toEqual(['Nature is simple.', 'The integral diverges.']);
  });

  it('round-trips through a zip bundle and plain markdown', () => {
    const p = sample();
    expect(importProfile(exportBundle(p), 'x.zip')).toEqual(p);
    expect(importProfile(exportMarkdown(p), 'x.md')).toEqual(p);
  });
});

describe('re-extraction diff', () => {
  it('classifies moves and merges without losing settings or own examples', () => {
    const current = sample();
    current.moves[0]!.weight = 0.33;
    current.moves.push(newMove({ title: 'Old extracted thing', description: 'gone now', origin: 'extracted' }, current.moves.map((m) => m.id)));

    const incoming = newProfile('Plain Physics');
    incoming.sources = [{ title: 'More lectures', author: 'R. Feynman' }];
    incoming.moves = [
      newMove({ title: 'Short declarative paragraph openers', description: 'Open with a short sentence stating the point, then unpack it.', origin: 'extracted', examples: [{ text: 'It is simple.', source: 'More', kind: 'author' }] }),
      newMove({ title: 'Address the reader as you', description: 'Talk to the reader directly.', origin: 'extracted' }),
    ];

    const diff = diffProfiles(current, incoming);
    const kinds = Object.fromEntries(diff.map((d) => [d.current?.title ?? d.incoming!.title, d.kind]));
    expect(kinds).toEqual({
      'Short declarative openers': 'changed',
      'Address the reader as you': 'added',
      'Concrete example before the rule': 'missing',
      'Old extracted thing': 'missing',
    });
    // Manual moves are never proposed for removal.
    expect(diff.find((d) => d.current?.title === 'Concrete example before the rule')!.apply).toBe(false);

    const merged = mergeDiff(current, incoming, diff);
    const openers = merged.moves.find((m) => m.id === 'short-declarative-openers')!;
    expect(openers.weight).toBe(0.33);
    expect(openers.description).toContain('then unpack it');
    expect(openers.examples).toEqual([
      { text: 'It is simple.', source: 'More', kind: 'author' },
      { text: 'The integral diverges.', kind: 'user' },
    ]);
    expect(merged.moves.map((m) => m.title)).toContain('Address the reader as you');
    expect(merged.sources.map((s) => s.title)).toEqual(['Lectures', 'More lectures']);
  });

  it('defaults to keeping locked moves', () => {
    const current = sample();
    current.moves[0]!.locked = true;
    const incoming = structuredClone(current);
    incoming.moves[0]!.description = 'Something else entirely about openers.';
    const entry = diffProfiles(current, incoming).find((d) => d.kind === 'changed')!;
    expect(entry.apply).toBe(false);
    expect(entry.note).toContain('locked');
  });
});

describe('blending', () => {
  it('scales weights, flags overlaps and resolves them', () => {
    const a = sample();
    const b = newProfile('Terse');
    b.moves = [
      newMove({ title: 'Long declarative openers', description: 'Open with a long scene-setting sentence.', weight: 1 }),
      newMove({ title: 'Cut adverbs', description: 'Remove most -ly words.', weight: 1 }),
    ];
    const { profile, conflicts } = blendProfiles([{ profile: a, weight: 0.7 }, { profile: b, weight: 0.3 }], 'Mix');
    expect(profile.moves).toHaveLength(4);
    expect(profile.moves.find((m) => m.title === 'Cut adverbs')!.weight).toBeCloseTo(0.3 / 0.7, 2);
    expect(profile.moves.find((m) => m.title === 'Short declarative openers')!.weight).toBe(0.8);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.a.title).toBe('Short declarative openers');

    const keepA = resolveConflict(profile, conflicts[0]!, 'a');
    expect(keepA.moves.map((m) => m.title)).not.toContain('Long declarative openers');
    const merged = resolveConflict(profile, conflicts[0]!, 'merge');
    expect(merged.moves).toHaveLength(3);
  });
});
