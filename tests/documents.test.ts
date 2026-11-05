import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { epubText, htmlToText, pdfText } from '../src/main/documents';

describe('PDF sources', () => {
  it('extracts paragraphs and metadata', async () => {
    const data = new Uint8Array(await readFile(join(import.meta.dirname, 'fixtures/sample.pdf')));
    const r = await pdfText(data, 'sample');
    expect(r.needsOcr).toBe(false);
    expect(r.doc.name).toBe('Lectures on Motion');
    expect(r.doc.author).toBe('A. Physicist');
    const paras = r.doc.text.split('\n\n');
    expect(paras.some((p) => p.startsWith('Nature is simple.') && p.includes('three centuries ago.'))).toBe(true);
    expect(paras.some((p) => p.startsWith('So let us start with something concrete.'))).toBe(true);
    expect(r.doc.text).not.toMatch(/Moon\ngoing/);
  });
});

describe('EPUB sources', () => {
  const book = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<package><metadata><dc:title>Six Easy Pieces</dc:title><dc:creator>R. Feynman</dc:creator></metadata>
      <manifest><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="css" href="s.css" media-type="text/css"/></manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/text/ch1.xhtml': strToU8('<html><head><title>x</title><style>p{}</style></head><body><h1>Atoms in Motion</h1><p>If, in some cataclysm, all of scientific knowledge were to be destroyed&#8230;</p><p>Ladies &amp; gentlemen.</p></body></html>'),
    'OEBPS/text/ch2.xhtml': strToU8('<html><body><p>Basic   physics.<br/>Second line.</p></body></html>'),
  });

  it('reads chapters in spine order with metadata', () => {
    const doc = epubText(book, 'book');
    expect(doc.name).toBe('Six Easy Pieces');
    expect(doc.author).toBe('R. Feynman');
    expect(doc.text.split('\n\n')).toEqual([
      'Atoms in Motion',
      'If, in some cataclysm, all of scientific knowledge were to be destroyed…',
      'Ladies & gentlemen.',
      'Basic physics. Second line.',
    ]);
  });

  it('rejects a zip that is not an EPUB', () => {
    expect(() => epubText(zipSync({ 'a.txt': strToU8('x') }), 'x')).toThrow(/EPUB/);
  });

  it('turns HTML into paragraphs', () => {
    expect(htmlToText('<div><p>A <em>b</em></p><p>C&nbsp;d</p></div>')).toBe('A b\n\nC d');
  });
});
