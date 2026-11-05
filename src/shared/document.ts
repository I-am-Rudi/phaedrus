// The editor works on plain text files (.md, .txt, .tex): blocks separated by
// blank lines, Markdown "#" lines become headings. Everything else is kept as
// literal text so files round-trip unchanged apart from blank-line runs.

export type DocBlock = { type: 'heading'; level: number; text: string } | { type: 'paragraph'; text: string };

export function parseDocument(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const chunk of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const trimmed = chunk.replace(/^\n+|\n+$/g, '');
    if (!trimmed.trim()) continue;
    // A chunk may start with a heading line followed directly by text.
    const lines = trimmed.split('\n');
    let para: string[] = [];
    const flush = () => {
      if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
      para = [];
    };
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        blocks.push({ type: 'heading', level: h[1]!.length, text: h[2]!.trim() });
      } else {
        para.push(line);
      }
    }
    flush();
  }
  return blocks;
}

export function serializeDocument(blocks: DocBlock[]): string {
  return (
    blocks
      .map((b) => (b.type === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.text))
      .join('\n\n')
      .trimEnd() + '\n'
  );
}

/** If a block starts a section (Markdown heading or LaTeX \section), return its title. */
export function sectionTitle(block: DocBlock): string | null {
  if (block.type === 'heading') return block.text;
  const tex = /^\s*\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(block.text);
  if (tex) return tex[1]!.trim();
  if (/^\s*\\begin\{abstract\}/.test(block.text)) return 'Abstract';
  return null;
}

export const DOC_TYPES = ['paper', 'thesis', 'blog', 'email', 'notes', 'other'] as const;
