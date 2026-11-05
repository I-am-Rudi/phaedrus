// Pasting text works like opening a file: blank lines separate paragraphs,
// single line breaks stay inside the paragraph. The editor holds plain text
// (.tex, .md), so rich clipboard content (HTML from a browser or a code
// editor) is ignored in favour of its plain-text version.

import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { parseDocumentFull } from '@shared/document';

function inline(schema: Schema, text: string): PMNode[] {
  const out: PMNode[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) out.push(schema.nodes.hardBreak!.create());
    if (line) out.push(schema.text(line));
  });
  return out;
}

/** Plain text as a slice of paragraphs (and Markdown headings outside LaTeX). */
export function textToSlice(schema: Schema, text: string, fileName = ''): Slice {
  const src = text.replace(/\r\n?/g, '\n');
  // Within one line: insert as text, no new paragraph.
  if (!src.includes('\n')) return new Slice(Fragment.from(schema.text(src)), 0, 0);
  const { blocks } = parseDocumentFull(src, fileName);
  if (!blocks.length) return Slice.empty;
  const nodes = blocks.map((b) =>
    b.type === 'heading'
      ? schema.nodes.heading!.create({ level: Math.min(b.level, 6), sep: b.sep ?? null }, inline(schema, b.text))
      : schema.nodes.paragraph!.create({ sep: b.sep ?? null }, inline(schema, b.text)),
  );
  // Open on both sides, so the first and last pieces join the paragraphs around the cursor.
  return new Slice(Fragment.from(nodes), 1, 1);
}

export function PlainTextPaste(fileName: () => string) {
  return Extension.create({
    name: 'plainTextPaste',
    addProseMirrorPlugins: () => [
      new Plugin({
        key: new PluginKey('plainTextPaste'),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData('text/plain');
            if (!text || !text.trim()) return false;
            view.dispatch(view.state.tr.replaceSelection(textToSlice(view.state.schema, text, fileName())).scrollIntoView());
            return true;
          },
        },
      }),
    ],
  });
}
