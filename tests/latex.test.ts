import { describe, expect, it } from 'vitest';
import { mapBack, maskLatex, proseOf, rewriteKeepsLatex } from '@shared/latex';
import { checkGrammar } from '../src/main/grammar';
import { defaultSettings } from '../src/main/store';
import { parseSuggestions } from '@shared/coach';
import { computeMetrics } from '@shared/metrics';
import { newMove } from '@shared/profile/model';

const mask = (s: string) => maskLatex(s).text;

describe('maskLatex', () => {
  it('replaces math with a placeholder word', () => {
    expect(mask('The field $\\phi(x)$ diverges.')).toBe('The field X diverges.');
    expect(mask('We find \\(E = mc^2\\) here.')).toBe('We find X here.');
    expect(mask('so that $$\\int f = 0.$$ Hence')).toBe('so that X Hence');
    expect(mask('so that \\[ a = b \\] holds')).toBe('so that X holds');
    expect(mask('with\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\nfor all')).toBe('with\nX\nfor all');
  });

  it('keeps text arguments and drops markup around them', () => {
    expect(mask('This is \\emph{very} \\textbf{important}.')).toBe('This is very important.');
    expect(mask('\\section{Point splitting} We start')).toBe('Point splitting We start');
    expect(mask('a \\emph{nested $x$ case}')).toBe('a nested X case');
  });

  it('handles references, citations and comments', () => {
    expect(mask('as shown in Eq.~\\eqref{eq:main} and Fig.~\\ref{f1}')).toBe('as shown in Eq. 1 and Fig. 1');
    expect(mask('as \\citet{wald94} showed')).toBe('as Smith showed');
    expect(mask('known results \\cite{a,b} hold')).toBe('known results hold');
    expect(mask('known results~\\cite[p.~3]{a}.')).toBe('known results .');
    expect(mask('text % a comment\nmore')).toBe('text \nmore');
    expect(mask('label here\\label{sec:x} ok')).toBe('label here ok');
  });

  it('handles escapes, quotes and argument-less macros', () => {
    expect(mask('costs 5\\% and \\$3')).toBe('costs 5% and $3');
    expect(mask("``quoted'' text")).toBe('"quoted" text');
    expect(mask('\\noindent The \\LaTeX{} source')).toBe('The source');
  });

  it('leaves currency dollars alone (pandoc rule)', () => {
    expect(mask('It costs $5 and $10 today.')).toBe('It costs $5 and $10 today.');
    expect(mask('a $ b $ c')).toBe('a $ b $ c');
  });

  it('maps every prose character back to the original', () => {
    const src = 'The \\emph{field} $\\phi$ is \\textbf{renormalised} here.';
    const m = maskLatex(src);
    for (let k = 0; k < m.text.length; k++) if (!m.synthetic[k]) expect(src[m.map[k]!]).toBe(m.text[k]);
  });

  it('keeps inline math verbatim in prose mode', () => {
    expect(maskLatex('field $\\phi$ and \\[x\\] end', 'prose').text).toBe('field $\\phi$ and  [equation]  end');
  });
});

describe('mapping issues back', () => {
  it('drops issues on markup and maps the rest', () => {
    const src = 'Their is a \\emph{mispeled} word near $\\phi$.';
    const m = maskLatex(src);
    const at = (w: string) => ({ from: m.text.indexOf(w), to: m.text.indexOf(w) + w.length });
    const issues = mapBack(m, src, [at('Their'), at('mispeled'), at('X')]);
    expect(issues.map((i) => i.text)).toEqual(['Their', 'mispeled']);
  });
});

describe('grammar engines on LaTeX', () => {
  it('Harper flags prose errors but nothing in math, commands or citations', async () => {
    const cfg = { ...defaultSettings('/tmp').grammar, engine: 'harper' as const };
    const src =
      'Their are several ways to renormalize the stress tensor $\\langle T_{\\mu\\nu} \\rangle$ on curved backgrounds~\\cite{wald1994quantum}, see \\eqref{eq:hadamard} and \\textbf{teh} discussion in \\S\\ref{sec:pointsplit}.';
    const issues = await checkGrammar(src, cfg);
    for (const i of issues) {
      expect(src.slice(i.from, i.to)).toBe(i.text);
      expect(i.text).not.toMatch(/[\\${}]/);
    }
    const texts = issues.map((i) => i.text);
    expect(texts).toContain('Their');
    expect(texts).toContain('teh');
    expect(texts.join(' ')).not.toMatch(/wald|hadamard|langle|mu|pointsplit/);
  });
});

describe('style checks and metrics on LaTeX', () => {
  const moves = [newMove({ title: 'Short openers' })];
  const paragraph = 'In this section we will discuss the expectation value $\\langle T_{\\mu\\nu}\\rangle$ in detail, following \\cite{wald}.';

  it('drops rewrites that lose math or references', () => {
    const reply = (rewrite: string) =>
      JSON.stringify({ suggestions: [{ move_id: 'short-openers', quote: paragraph, issue: 'i', rewrite, explanation: 'e' }] });
    expect(parseSuggestions(reply('The expectation value matters.'), { paragraph, moves })).toHaveLength(0);
    expect(parseSuggestions(reply('We compute $\\langle T_{\\mu\\nu} \\rangle$ following \\cite{wald}.'), { paragraph, moves })).toHaveLength(1);
  });

  it('rewriteKeepsLatex ignores whitespace inside math', () => {
    expect(rewriteKeepsLatex('see $a+b$', 'look at $a + b$')).toBe(true);
    expect(rewriteKeepsLatex('see \\eqref{x}', 'see the equation')).toBe(false);
  });

  it('measures prose, not markup', () => {
    const latex = computeMetrics('We find $\\int_0^\\infty e^{-x^2} dx$ is finite~\\cite{a,b,c}. It converges.');
    expect(latex.words).toBe(proseOf('We find X is finite. It converges.').split(/\s+/).length);
  });
});

describe('project language', () => {
  it('picks the Harper dialect from the language and skips non-English', async () => {
    const { harperDialectFor } = await import('@shared/language');
    expect(harperDialectFor('en-US', 'british')).toBe('american');
    expect(harperDialectFor('auto', 'british')).toBe('british');
    expect(harperDialectFor('de-DE', 'british')).toBeNull();
    const cfg = { ...defaultSettings('/tmp').grammar, engine: 'harper' as const };
    expect(await checkGrammar('Their are mispeled words.', cfg, 'de-DE')).toEqual([]);
    expect((await checkGrammar('Their are mispeled words.', cfg, 'en-GB')).length).toBeGreaterThan(0);
  });

  it('round-trips the language of a project profile', async () => {
    const { parseProfile, serializeProfile } = await import('@shared/profile/markdown');
    const { newProfile } = await import('@shared/profile/model');
    const p = { ...newProfile('Thesis', 'project'), language: 'de-DE' };
    expect(parseProfile(serializeProfile(p)).language).toBe('de-DE');
    expect(parseProfile(serializeProfile(newProfile('x'))).language).toBeUndefined();
  });
});
