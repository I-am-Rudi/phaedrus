import { describe, expect, it } from 'vitest';
import {
  clampCursor, findChar, firstNonBlank, lineEnd, lineStart, paragraphBackward, paragraphForward, search, textObject, wordBackward, wordEnd, wordForward,
} from '../src/renderer/vim/motions';

const t = 'The field, phi(x), diverges.\n  Second line here\nThird.';
//         0123456789012345678901234567 8901234567890123456 7

describe('vim motions', () => {
  it('word motions follow vim classes', () => {
    expect(wordForward(t, 0)).toBe(4); // The -> field
    expect(wordForward(t, 4)).toBe(9); // field -> ,
    expect(wordForward(t, 9)).toBe(11); // , -> phi
    expect(wordForward(t, 4, true)).toBe(11); // W skips punctuation
    expect(wordBackward(t, 11)).toBe(9);
    expect(wordBackward(t, 11, true)).toBe(4);
    expect(wordEnd(t, 0)).toBe(2);
    expect(wordEnd(t, 2)).toBe(8);
    expect(wordForward(t, 19)).toBe(27); // diverges -> .
    expect(wordForward(t, 27)).toBe(31); // . -> Second (skips newline and indent)
  });

  it('line motions', () => {
    expect(lineStart(t, 35)).toBe(29);
    expect(lineEnd(t, 35)).toBe(47);
    expect(firstNonBlank(t, 35)).toBe(31);
    expect(clampCursor(t, 28)).toBe(27); // cannot rest on the newline
  });

  it('f/t/F/T stay on the line', () => {
    expect(findChar(t, 0, 'e', 'f')).toBe(2);
    expect(findChar(t, 0, 'e', 'f', 2)).toBe(6);
    expect(findChar(t, 0, ',', 't')).toBe(8);
    expect(findChar(t, 20, 'p', 'F')).toBe(11);
    expect(findChar(t, 0, 'S', 'f')).toBe(-1);
  });

  it('text objects', () => {
    expect(textObject(t, 5, 'iw', [])).toEqual([4, 9]);
    expect(textObject(t, 1, 'aw', [])).toEqual([0, 4]);
    expect(textObject(t, 22, 'is', [])).toEqual([0, 28]);
    const starts = [0, 29, 48];
    expect(textObject(t, 35, 'ip', starts)).toEqual([29, 47]);
    expect(textObject(t, 35, 'ap', starts)).toEqual([29, 48]);
  });

  it('paragraphs and search', () => {
    const starts = [0, 29, 48];
    expect(paragraphForward(t, 3, starts)).toBe(29);
    expect(paragraphBackward(35, starts)).toBe(29);
    expect(search(t, 0, 'line')).toBe(38);
    expect(search(t, 40, 'THE')).toBe(-1); // smart case
    expect(search(t, 40, 'the')).toBe(0); // wraps
    expect(search(t, 10, 'e', true)).toBe(6);
  });
});
