// The editor works on plain text files (.md, .txt, .tex). A paragraph is what
// TeX and Markdown both mean by one: lines up to the next blank line. A single
// line break inside a paragraph is only source formatting, so the checks see
// the paragraph as one piece of text (see softWrap).
//
// Markdown "#" lines become headings. In LaTeX documents, sectioning commands
// (\section{...} and friends) on their own line become their own blocks even
// without a blank line around them, so they are not read as the start of the
// following paragraph. The exact whitespace between blocks is kept, so a file
// saves back exactly as it was opened unless you edit it.

export type DocBlock = ({ type: 'heading'; level: number; text: string } | { type: 'paragraph'; text: string }) & {
  /** Text between the previous block and this one ("\n\n" for a blank line). Unset = one blank line. */
  sep?: string;
};

export interface ParsedDocument {
  blocks: DocBlock[];
  /** Text before the first block (blank lines at the top of the file). */
  leading: string;
  /** Text after the last block, usually "\n". */
  trailing: string;
  latex: boolean;
}

const SECTION_LINE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{.*\}\s*(?:\\label\{[^}]*\}\s*)?(?:%.*)?$/;

/** Is this a LaTeX document? By file name, or by unmistakable LaTeX structure in the text. */
export function isLatex(text: string, name = ''): boolean {
  if (/\.(tex|ltx|sty|cls)$/i.test(name)) return true;
  return /\\documentclass|\\begin\{document\}/.test(text) || (text.match(/^\s*\\(?:sub)*section\*?\{/gm)?.length ?? 0) >= 2;
}

export function parseDocumentFull(text: string, name = ''): ParsedDocument {
  const src = text.replace(/\r\n?/g, '\n');
  const latex = isLatex(src, name);
  const lines = src.split('\n');
  const blocks: DocBlock[] = [];
  let leading = '';
  let pendingSep = '';
  let started = false;
  let para: string[] = [];

  const push = (b: DocBlock) => {
    blocks.push(started ? { ...b, sep: pendingSep } : b);
    started = true;
    pendingSep = '\n';
  };
  const flush = () => {
    if (para.length) push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^[ \t]*$/.test(line)) {
      flush();
      // Blank line: part of the separator before the next block.
      if (!started) leading += line + '\n';
      else pendingSep += line + '\n';
      continue;
    }
    const md = !latex ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (md) {
      flush();
      push({ type: 'heading', level: md[1]!.length, text: md[2]!.trim() });
      continue;
    }
    if (latex && SECTION_LINE.test(line)) {
      flush();
      push({ type: 'paragraph', text: line });
      continue;
    }
    para.push(line);
  }
  flush();

  if (!blocks.length) return { blocks, leading: src, trailing: '', latex };
  // Everything after the last non-blank character: usually just the final newline.
  const trailing = /\n[ \t\n]*$/.exec(src)?.[0] ?? '';
  return { blocks, leading, trailing, latex };
}

export function parseDocument(text: string, name = ''): DocBlock[] {
  return parseDocumentFull(text, name).blocks;
}

export function serializeDocument(blocks: DocBlock[], opts: { leading?: string; trailing?: string } = {}): string {
  const body = blocks
    .map((b, i) => {
      const content = b.type === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.text;
      return i === 0 ? content : (b.sep ?? '\n\n') + content;
    })
    .join('');
  return (opts.leading ?? '') + body + (opts.trailing ?? '\n');
}

/** Line breaks inside a paragraph are formatting, not text: show the checks one line. Same length, so offsets carry over. */
export function softWrap(text: string): string {
  return text.replace(/\n/g, ' ');
}

/** If a block starts a section (Markdown heading or LaTeX \section), return its title. */
export function sectionTitle(block: DocBlock): string | null {
  if (block.type === 'heading') return block.text;
  const tex = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(block.text);
  if (tex) return tex[1]!.trim();
  if (/^\s*\\begin\{abstract\}/.test(block.text)) return 'Abstract';
  return null;
}

/** A block that is only a LaTeX sectioning command. */
export function isLatexHeading(text: string): boolean {
  return SECTION_LINE.test(text) && !text.includes('\n');
}

export const DOC_TYPES = ['paper', 'thesis', 'blog', 'email', 'notes', 'other'] as const;
