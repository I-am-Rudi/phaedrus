import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { BlockSeparators } from '../src/renderer/editor/issues';
import { textToSlice } from '../src/renderer/editor/paste';

const schema = getSchema([StarterKit, BlockSeparators]);

describe('pasting plain text', () => {
  it('makes one paragraph per blank-line block, not per line', () => {
    const text = readFileSync('tests/fixtures/latex-hardwrapped.tex', 'utf8');
    const slice = textToSlice(schema, text, 'untitled.md');
    expect(slice.content.childCount).toBe(32);
    const para = slice.content.child(4);
    // A hard-wrapped paragraph is one node with line breaks inside.
    expect(para.type.name).toBe('paragraph');
    expect(para.textContent).toMatch(/^spin theory \\cite\{ref0\}/);
    expect(para.content.childCount).toBeGreaterThan(3);
  });

  it('keeps single line breaks as breaks inside the paragraph', () => {
    const slice = textToSlice(schema, 'one\ntwo\n\nthree');
    expect(slice.content.childCount).toBe(2);
    expect(slice.content.child(0).childCount).toBe(3); // text, hardBreak, text
  });

  it('inserts text without line breaks inline', () => {
    const slice = textToSlice(schema, 'a few words');
    expect(slice.openStart).toBe(0);
    expect(slice.content.firstChild!.isText).toBe(true);
  });
});
