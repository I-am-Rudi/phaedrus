import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { BlockSeparators } from '../src/renderer/editor/issues';
import { textToSlice } from '../src/renderer/editor/paste';

const schema = getSchema([StarterKit, BlockSeparators]);

describe('pasting plain text', () => {
  it('makes one paragraph per blank-line block, not per line', () => {
    const text = readFileSync('tests/fixtures/intro-attachment.tex', 'utf8');
    const slice = textToSlice(schema, text, 'untitled.md');
    expect(slice.content.childCount).toBe(33);
    const para = slice.content.child(4);
    expect(para.textContent).toContain('This question posed by Bryce DeWitt');
    expect(para.textContent).toContain('the strong interacti');
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
