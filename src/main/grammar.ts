// Spelling and grammar come from a deterministic, open-source engine, never
// from the LLM: instant, cheap and identical in assistant and teacher mode.
//  - LanguageTool (LGPL): local server, English, German and many more
//  - Harper (Apache-2.0): in-process WebAssembly, English only

import { Dialect, LocalLinter, SuggestionKind } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';
import { harperDialectFor } from '@shared/language';
import { hasLatex, mapBack, maskLatex } from '@shared/latex';
import { codePointToUtf16, findQuote } from '@shared/spans';
import { expandSpelling } from '@shared/spelling/candidates';
import { harperAccepts } from '@shared/spelling/harper';
import type { GrammarIssue, Settings } from '@shared/types';

export async function checkGrammar(text: string, cfg: Settings['grammar'], language?: string): Promise<GrammarIssue[]> {
  if (!text.trim() || cfg.engine === 'none') return [];
  const lang = language || cfg.language || 'auto';
  const dialect = harperDialectFor(lang, cfg.harperDialect);
  if (cfg.engine === 'harper' && !dialect) return []; // Harper is English only
  // The engine's suggestions plus common words it missed, each confirmed by the engine (see spelling/candidates.ts).
  const run = async (t: string) => {
    if (cfg.engine === 'languagetool') {
      const { issues, detected } = await languageTool(t, cfg, lang);
      const wordsLang = lang === 'auto' ? detected : lang;
      return wordsLang ? expandSpelling(issues, wordsLang, (words) => languageToolAccepts(words, cfg, wordsLang)) : issues;
    }
    return expandSpelling(await harper(t, dialect!), 'en', (words) => harperAccepts(harperLinter(dialect!), words));
  };
  if (!hasLatex(text)) return run(text);
  // Check the prose with LaTeX masked out, then put findings back on the original.
  const masked = maskLatex(text);
  return mapBack(masked, text, await run(masked.text));
}

// ---------------------------------------------------------------- LanguageTool

/** LanguageTool issue types that are about style; the taste profile owns style. */
const LT_SKIP = new Set(['style', 'register', 'locale-violation']);

async function languageToolRequest(text: string, cfg: Settings['grammar'], language: string): Promise<any> {
  const url = `${cfg.languageToolUrl.replace(/\/+$/, '')}/v2/check`;
  const body = new URLSearchParams({ text, language });
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  } catch {
    throw new Error(`LanguageTool is not reachable at ${cfg.languageToolUrl}. Start it (see README) or switch to Harper in Settings.`);
  }
  if (!res.ok) throw new Error(`LanguageTool ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Issues, and the language LanguageTool detected when asked to ("auto"). */
async function languageTool(text: string, cfg: Settings['grammar'], language: string): Promise<{ issues: GrammarIssue[]; detected?: string }> {
  const data = await languageToolRequest(text, cfg, language);
  const detected: string | undefined = data.language?.detectedLanguage?.code ?? data.language?.code;
  const issues = (data.matches ?? [])
    .filter((m: any) => !LT_SKIP.has(m.rule?.issueType))
    .map((m: any) => ({
      category: m.rule?.issueType === 'misspelling' ? 'spelling' : 'grammar',
      from: m.offset,
      to: m.offset + m.length,
      text: text.slice(m.offset, m.offset + m.length),
      message: m.message ?? m.shortMessage ?? '',
      replacements: (m.replacements ?? []).slice(0, 5).map((r: any) => r.value),
      ruleId: m.rule?.id ?? 'languagetool',
      engine: 'languagetool' as const,
    }));
  return { issues, detected };
}

/** The words (lower case) LanguageTool does not mark as misspelled, checked in one request. */
async function languageToolAccepts(words: string[], cfg: Settings['grammar'], language: string): Promise<Set<string>> {
  const text = words.join('\n\n');
  const data = await languageToolRequest(text, cfg, language);
  // Every line starts in lower case, so sentence-start rules fire; only spelling counts.
  const rejected = new Set<string>(
    (data.matches ?? [])
      .filter((m: any) => m.rule?.issueType === 'misspelling' || m.rule?.category?.id === 'TYPOS')
      .map((m: any) => text.slice(m.offset, m.offset + m.length).toLowerCase()),
  );
  return new Set(words.filter((w) => !rejected.has(w.toLowerCase())));
}

// ---------------------------------------------------------------------- Harper

const HARPER_SKIP = new Set(['Style', 'Readability', 'Enhancement', 'WordChoice', 'Regionalism']);
const HARPER_SPELLING = new Set(['Spelling', 'Typo']);
const linters = new Map<string, LocalLinter>();

function harperLinter(dialect: Settings['grammar']['harperDialect']): LocalLinter {
  let l = linters.get(dialect);
  if (!l) {
    const d = { american: Dialect.American, british: Dialect.British, australian: Dialect.Australian, canadian: Dialect.Canadian }[dialect];
    l = new LocalLinter({ binary: binaryInlined, dialect: d });
    linters.set(dialect, l);
  }
  return l;
}

async function harper(text: string, dialect: Settings['grammar']['harperDialect']): Promise<GrammarIssue[]> {
  const lints = await harperLinter(dialect).lint(text, { language: 'plaintext' });
  const out: GrammarIssue[] = [];
  for (const lint of lints) {
    const kind = lint.lint_kind();
    if (HARPER_SKIP.has(kind)) continue;
    const span = lint.span();
    const problem = lint.get_problem_text();
    // harper.js reports UTF-16 offsets; verify against the problem text and
    // fall back to code-point conversion or a search if they ever disagree.
    let from = span.start;
    let to = span.end;
    if (text.slice(from, to) !== problem) {
      from = codePointToUtf16(text, span.start);
      to = codePointToUtf16(text, span.end);
      if (text.slice(from, to) !== problem) {
        const r = findQuote(text, problem, span.start);
        if (!r) continue;
        ({ from, to } = r);
      }
    }
    out.push({
      category: HARPER_SPELLING.has(kind) ? 'spelling' : 'grammar',
      from,
      to,
      text: text.slice(from, to),
      message: lint.message(),
      // Normalise Harper's three suggestion kinds to "replace the span with this".
      replacements: lint
        .suggestions()
        .slice(0, 5)
        .map((s) =>
          s.kind() === SuggestionKind.InsertAfter
            ? text.slice(from, to) + s.get_replacement_text()
            : s.kind() === SuggestionKind.Remove
              ? ''
              : s.get_replacement_text(),
        ),
      ruleId: kind,
      engine: 'harper',
    });
  }
  return out;
}
