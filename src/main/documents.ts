// Text from source documents: Markdown/plain/LaTeX as is, PDF via pdf.js,
// EPUB by reading the book's chapters in spine order. Scanned PDFs have no
// text layer; the caller can hand those to the model instead.

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { SourceDoc } from '@shared/types';

export interface ReadResult {
  doc: SourceDoc;
  /** True for PDFs that have (almost) no text layer, i.e. scanned pages. */
  needsOcr?: boolean;
  pages?: number;
}

export const SOURCE_EXTENSIONS = ['md', 'markdown', 'txt', 'tex', 'pdf', 'epub'];

export async function readSource(file: string): Promise<ReadResult> {
  const ext = extname(file).slice(1).toLowerCase();
  const name = basename(file).replace(/\.[^.]+$/, '');
  if (ext === 'pdf') return pdfText(new Uint8Array(await readFile(file)), name);
  if (ext === 'epub') return { doc: epubText(new Uint8Array(await readFile(file)), name) };
  return { doc: { name, text: await readFile(file, 'utf8') } };
}

// ------------------------------------------------------------------- PDF

export async function pdfText(data: Uint8Array, fallbackName: string): Promise<ReadResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let out = '';
    let lastY: number | null = null;
    let lastHeight = 0;
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      if (!item.str.trim()) {
        // Empty marker items carry line ends but no useful geometry.
        if (item.hasEOL && !out.endsWith('\n')) out += '\n';
        else if (item.str) out += item.str;
        continue;
      }
      const y = item.transform?.[5] ?? 0;
      const h = item.height || lastHeight || 10;
      // A vertical jump of more than ~1.6 lines, or a change of font size
      // (heading to body), starts a new paragraph.
      const jump = lastY !== null && Math.abs(lastY - y) > Math.min(h, lastHeight || h) * 1.6;
      const resized = lastY !== null && lastY !== y && Math.abs(h - lastHeight) > 1.5;
      if ((jump || resized) && !out.endsWith('\n\n')) out = out.replace(/\n?$/, '\n\n');
      out += item.str;
      if (item.hasEOL) out += '\n';
      lastY = y;
      lastHeight = h;
    }
    pages.push(out);
    page.cleanup();
  }
  const meta: any = await pdf.getMetadata().catch(() => null);
  await task.destroy();
  const text = tidy(pages.join('\n\n'));
  const title = String(meta?.info?.Title ?? '').trim();
  const author = String(meta?.info?.Author ?? '').trim();
  const doc: SourceDoc = { name: title || fallbackName, text, ...(author ? { author } : {}) };
  const needsOcr = text.replace(/\s/g, '').length < 100 * Math.max(1, pages.length);
  return { doc, needsOcr, pages: pages.length };
}

/** Join wrapped lines into paragraphs and undo end-of-line hyphenation. */
function tidy(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((para) =>
      para
        .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
}

// ------------------------------------------------------------------- EPUB

export function epubText(data: Uint8Array, fallbackName: string): SourceDoc {
  const files = unzipSync(data);
  const read = (path: string) => {
    const f = files[path] ?? files[decodeURIComponent(path)];
    return f ? strFromU8(f) : '';
  };
  const container = read('META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('Not a valid EPUB (no container.xml).');
  const opf = read(opfPath);
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, { href: string; type: string }>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    const type = /\bmedia-type="([^"]+)"/.exec(tag)?.[1] ?? '';
    if (id && href) manifest.set(id, { href, type });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/g)].map((m) => m[1]!);
  const chapters: string[] = [];
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item || !/html|xml/.test(item.type)) continue;
    const text = htmlToText(read(normalizePath(dir + item.href.split('#')[0])));
    if (text.trim()) chapters.push(text);
  }
  if (!chapters.length) throw new Error('The EPUB has no readable chapters.');
  const title = decodeEntities(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? '').trim();
  const author = decodeEntities(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf)?.[1] ?? '').trim();
  return { name: title || fallbackName, text: chapters.join('\n\n'), ...(author ? { author } : {}) };
}

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return decodeEntities(
    body
      .replace(/<(script|style|head|nav)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr|figcaption)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}
