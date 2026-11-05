import { describe, expect, it } from 'vitest';
import { isLatex, isLatexHeading, parseDocument, parseDocumentFull, sectionTitle, serializeDocument, softWrap } from '@shared/document';

const roundTrip = (text: string, name = '') => {
  const d = parseDocumentFull(text, name);
  return serializeDocument(d.blocks, { leading: d.leading, trailing: d.trailing });
};

describe('document', () => {
  it('splits Markdown into headings and blank-line paragraphs, keeping line breaks inside them', () => {
    const md = '# Intro\n\nFirst line\nsecond line.\n\n## Method\nWe sample.\n';
    expect(parseDocument(md)).toEqual([
      { type: 'heading', level: 1, text: 'Intro' },
      { type: 'paragraph', text: 'First line\nsecond line.', sep: '\n\n' },
      { type: 'heading', level: 2, text: 'Method', sep: '\n\n' },
      { type: 'paragraph', text: 'We sample.', sep: '\n' },
    ]);
    expect(roundTrip(md)).toBe(md);
  });

  it('recognises LaTeX sections', () => {
    expect(sectionTitle({ type: 'paragraph', text: '\\section*{Introduction}\nText' })).toBe('Introduction');
    expect(sectionTitle({ type: 'paragraph', text: '\\begin{abstract}' })).toBe('Abstract');
    expect(sectionTitle({ type: 'paragraph', text: 'Plain.' })).toBeNull();
  });
});

describe('LaTeX paragraphs', () => {
  const tex = `\\documentclass{article}
\\usepackage{amsmath}

\\begin{document}
\\section{Introduction}\\label{sec:intro}
The stress tensor is a product of distributions,
which is not defined. Their are several ways
around this % TODO cite
and we use point splitting.
\\begin{equation}
  G(x,x') = \\langle \\phi(x)\\phi(x') \\rangle
\\end{equation}
where the bracket is the vacuum expectation value.


\\subsection*{Point splitting}
Take two points.

\\end{document}
`;

  it('detects LaTeX', () => {
    expect(isLatex(tex)).toBe(true);
    expect(isLatex('Plain text with $x$.', 'notes.md')).toBe(false);
    expect(isLatex('anything', 'paper.tex')).toBe(true);
  });

  it('a blank line ends a paragraph; line breaks, comments and display math inside it do not', () => {
    const blocks = parseDocument(tex);
    expect(blocks.map((b) => b.text.split('\n')[0])).toEqual([
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{Introduction}\\label{sec:intro}',
      'The stress tensor is a product of distributions,',
      '\\subsection*{Point splitting}',
      'Take two points.',
      '\\end{document}',
    ]);
    const para = blocks[3]!.text;
    expect(para).toContain('% TODO cite\nand we use point splitting.');
    expect(para).toContain('\\end{equation}\nwhere the bracket');
    expect(blocks[3]!.sep).toBe('\n');
    expect(isLatexHeading(blocks[2]!.text)).toBe(true);
  });

  it('saves back byte for byte', () => {
    expect(roundTrip(tex)).toBe(tex);
    expect(roundTrip('\n\nNo trailing newline')).toBe('\n\nNo trailing newline');
    expect(roundTrip('a  \n  \n\nb\n\n')).toBe('a  \n  \n\nb\n\n');
  });

  it('softWrap joins the lines of a paragraph without changing offsets', () => {
    const p = 'one line\nnext line';
    expect(softWrap(p)).toBe('one line next line');
    expect(softWrap(p).length).toBe(p.length);
  });
});
