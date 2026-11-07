// Asks Harper which words it accepts. Used by the main process and the browser preview.

import { codePointToUtf16 } from '../spans';

interface HarperLint {
  lint_kind(): string;
  span(): { start: number; end: number };
  get_problem_text(): string;
}

interface HarperLinter {
  lint(text: string, opts: { language: 'plaintext' }): Promise<HarperLint[]>;
}

/**
 * The words Harper does not object to. Each word gets its own line after a
 * neutral first line; a word is rejected if any lint touches it, whatever its
 * kind ("teh" is a Typo, "alot" a BoundaryError), except capitalisation, which
 * only means a line starts in lower case.
 */
export async function harperAccepts(linter: HarperLinter, words: string[]): Promise<Set<string>> {
  const spans: { word: string; from: number; to: number }[] = [];
  let text = 'Words\n';
  for (const w of words) {
    spans.push({ word: w, from: text.length, to: text.length + w.length });
    text += w + '\n';
  }
  const rejected = new Set<string>();
  for (const l of await linter.lint(text, { language: 'plaintext' })) {
    if (l.lint_kind() === 'Capitalization') continue;
    let { start, end } = l.span();
    if (text.slice(start, end) !== l.get_problem_text()) {
      start = codePointToUtf16(text, start);
      end = codePointToUtf16(text, end);
    }
    for (const sp of spans) if (sp.from < end && start < sp.to) rejected.add(sp.word);
  }
  return new Set(words.filter((w) => !rejected.has(w)));
}
