// A plain-text view of the ProseMirror document for vim motions: blocks joined
// by "\n", hard breaks as "\n". Maps text offsets to document positions and back.

import type { Node as PMNode } from '@tiptap/pm/model';

export interface TextIndex {
  text: string;
  /** Text offsets where blocks (paragraphs, headings) start. */
  blockStarts: number[];
  /** Document position for a text offset (offset == text.length is the end of the last block). */
  posAt(i: number): number;
  /** Text offset for a document position. */
  indexAt(pos: number): number;
  /** Top-level block node position for the block containing text offset i. */
  blockAt(i: number): { pos: number; end: number; startIndex: number; endIndex: number };
}

const cache = new WeakMap<PMNode, TextIndex>();

export function textIndex(doc: PMNode): TextIndex {
  const hit = cache.get(doc);
  if (hit) return hit;
  let text = '';
  const pos: number[] = [];
  const blockStarts: number[] = [];
  const blocks: { pos: number; end: number; startIndex: number; endIndex: number }[] = [];
  doc.forEach((node, offset, i) => {
    if (i > 0) {
      // separator: sits at the end of the previous block's content
      text += '\n';
      pos.push(blocks[blocks.length - 1]!.end - 1);
    }
    const startIndex = text.length;
    blockStarts.push(startIndex);
    node.descendants((child, childPos) => {
      const abs = offset + 1 + childPos;
      if (child.isText) {
        for (let k = 0; k < child.text!.length; k++) pos.push(abs + k);
        text += child.text!;
      } else if (child.type.name === 'hardBreak') {
        pos.push(abs);
        text += '\n';
      }
      return true;
    });
    blocks.push({ pos: offset, end: offset + node.nodeSize, startIndex, endIndex: text.length });
  });
  const endPos = blocks.length ? blocks[blocks.length - 1]!.end - 1 : 0;

  const index: TextIndex = {
    text,
    blockStarts,
    posAt: (i) => (i >= pos.length ? endPos : i < 0 ? (pos[0] ?? 0) : pos[i]!),
    indexAt(p) {
      // first offset whose position is >= p
      let lo = 0;
      let hi = pos.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pos[mid]! < p) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    blockAt(i) {
      let k = blockStarts.length - 1;
      while (k > 0 && blockStarts[k]! > i) k--;
      return blocks[k] ?? { pos: 0, end: doc.content.size, startIndex: 0, endIndex: text.length };
    },
  };
  cache.set(doc, index);
  return index;
}
