import { describe, expect, it } from 'vitest';
import { parseDocument, sectionTitle, serializeDocument } from '@shared/document';

describe('document', () => {
  it('round-trips markdown and keeps line breaks inside paragraphs', () => {
    const md = '# Intro\n\nFirst line\nsecond line.\n\n## Method\nWe sample.\n';
    const blocks = parseDocument(md);
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Intro' },
      { type: 'paragraph', text: 'First line\nsecond line.' },
      { type: 'heading', level: 2, text: 'Method' },
      { type: 'paragraph', text: 'We sample.' },
    ]);
    expect(serializeDocument(blocks)).toBe('# Intro\n\nFirst line\nsecond line.\n\n## Method\n\nWe sample.\n');
  });

  it('recognises LaTeX sections', () => {
    expect(sectionTitle({ type: 'paragraph', text: '\\section*{Introduction}\nText' })).toBe('Introduction');
    expect(sectionTitle({ type: 'paragraph', text: '\\begin{abstract}' })).toBe('Abstract');
    expect(sectionTitle({ type: 'paragraph', text: 'Plain.' })).toBeNull();
  });
});
