// Spelling and grammar come from a deterministic, open-source engine, never
// from the LLM: instant, cheap and identical in assistant and teacher mode.
//  - LanguageTool (LGPL): local server, English, German and many more
//  - Harper (Apache-2.0): in-process WebAssembly, English only

import { Dialect, LocalLinter, SuggestionKind } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';
import { codePointToUtf16, findQuote } from '@shared/spans';
import type { GrammarIssue, Settings } from '@shared/types';

export async function checkGrammar(text: string, cfg: Settings['grammar']): Promise<GrammarIssue[]> {
  if (!text.trim()) return [];
  if (cfg.engine === 'languagetool') return languageTool(text, cfg);
  if (cfg.engine === 'harper') return harper(text, cfg.harperDialect);
  return [];
}

// ---------------------------------------------------------------- LanguageTool

/** LanguageTool issue types that are about style; the taste profile owns style. */
const LT_SKIP = new Set(['style', 'register', 'locale-violation']);

async function languageTool(text: string, cfg: Settings['grammar']): Promise<GrammarIssue[]> {
  const url = `${cfg.languageToolUrl.replace(/\/+$/, '')}/v2/check`;
  const body = new URLSearchParams({ text, language: cfg.language || 'auto' });
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  } catch {
    throw new Error(`LanguageTool is not reachable at ${cfg.languageToolUrl}. Start it (see README) or switch to Harper in Settings.`);
  }
  if (!res.ok) throw new Error(`LanguageTool ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return (data.matches ?? [])
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
