// In-memory backend for `npm run web`: real profile logic and real Harper
// grammar checks, with a rule-based stand-in for the language model. Lets the
// UI be developed and demoed without Electron or an LLM.

import type { Backend, ProfileSummary, Snapshot } from '@shared/api';
import { checkStyle, editFeedback, extractProfile, extractRules, findBlendConflicts, type LLM } from '@shared/coach';
import { applyRuleEvent, newRule, newRuleSet, parseRuleSet, serializeRuleSet, type RuleSet } from '@shared/rules';
import { harperDialectFor } from '@shared/language';
import { hasLatex, mapBack, maskLatex } from '@shared/latex';
import { computeMetrics, splitSentences, words } from '@shared/metrics';
import { diffProfiles } from '@shared/profile/diff';
import { exportBundle, exportMarkdown, importProfile } from '@shared/profile/exchange';
import { applyEvent } from '@shared/profile/feedback';
import { parseProfile, serializeProfile } from '@shared/profile/markdown';
import { newMove, newProfile, touch } from '@shared/profile/model';
import type { GrammarIssue, Settings, TasteProfile } from '@shared/types';

const SAMPLE_SOURCE = `Nature is simple. We do not know why, but she is. When we look at a falling apple and at the Moon going around the Earth, we find the same law at work, and that is the whole surprise.

So let us start with something concrete. Take a ball on a string and swing it around. What holds it in? The string pulls. Now cut the string. The ball flies off in a straight line, not in a curve. That one observation is most of mechanics.

You might ask whether this is the right way to think about it. I do not know a better one. The test of any idea is whether it predicts what we see, and this one does, every time we have tried.`;

function sampleProfiles(): TasteProfile[] {
  const general = newProfile('Plain physics');
  general.language = 'en-GB';
  general.description = 'Short declarative claims, a concrete case before the general rule, and the reader addressed directly.';
  general.sources = [{ title: 'Lecture notes (sample)', author: 'sample author' }];
  general.metrics = computeMetrics(SAMPLE_SOURCE);
  general.moves = [
    newMove({
      title: 'Short declarative openers',
      description: 'Open a paragraph with a short sentence that states the point plainly, then unpack it.',
      rationale: 'The reader knows where the paragraph is going before the detail arrives.',
      weight: 0.85,
      origin: 'extracted',
      examples: [{ text: 'Nature is simple.', source: 'Lecture notes (sample)', kind: 'author' }],
    }),
    newMove(
      {
        title: 'Concrete case before the rule',
        description: 'Introduce an idea with a specific, physical example and only then state the general principle.',
        rationale: 'Abstractions land when the reader already holds a picture.',
        weight: 0.7,
        origin: 'extracted',
        examples: [{ text: 'Take a ball on a string and swing it around.', source: 'Lecture notes (sample)', kind: 'author' }],
      },
      ['short-declarative-openers'],
    ),
    newMove(
      {
        title: 'No throat clearing',
        description: 'Cut announcements of what the text is about to do ("In this section we will", "It is important to note that"). Say the thing.',
        rationale: 'Signposting delays the content and adds nothing the heading does not already say.',
        weight: 0.9,
        origin: 'manual',
      },
      ['short-declarative-openers', 'concrete-case-before-the-rule'],
    ),
  ];
  const thesis = newProfile('Thesis', 'project');
  thesis.language = 'en-GB';
  thesis.description = 'Project-specific moves for the thesis.';
  thesis.moves = [
    newMove({
      title: 'Define symbols at first use',
      description: 'Every symbol is defined in the sentence where it first appears.',
      weight: 0.8,
      scope: { docTypes: ['paper', 'thesis'], sections: [] },
    }),
  ];
  return [general, thesis];
}

function sampleRules(): RuleSet {
  const set = newRuleSet('Thesis rules');
  set.language = 'en-GB';
  set.description = 'House rules for the thesis.';
  set.rules = [
    newRule({ title: 'No contractions', description: 'Write "do not", "it is", "cannot" in full.', good: ['It is finite.'], bad: ["It's finite."] }),
    newRule({ title: 'Define acronyms at first use', description: 'Spell out an acronym the first time it appears, with the acronym in parentheses.', good: ['quantum field theory (QFT)'] }, ['no-contractions']),
  ];
  return set;
}

/** Rule-based stand-in for an LLM, answering in the same JSON the real prompts ask for. */
const fakeLLM: LLM = {
  async complete(req) {
    await new Promise((r) => setTimeout(r, 300));
    if (req.prompt.includes('<paragraph>') && req.prompt.includes('"suggestions"')) {
      const paragraph = /<paragraph>([\s\S]*?)<\/paragraph>/.exec(req.prompt)?.[1] ?? '';
      const suggestions: unknown[] = [];
      const clearing = /\b(In this (?:section|paper|chapter|paragraph),? we will (?:now )?(?:discuss|present|show|look at)|It is (?:important|worth) (?:to note|noting) that)\b/i.exec(paragraph);
      if (clearing && req.prompt.includes('no-throat-clearing')) {
        suggestions.push({
          move_id: 'no-throat-clearing',
          quote: clearing[0],
          issue: 'The sentence announces what is coming instead of saying it.',
          rewrite: '',
          explanation: 'Dropping the announcement lets the paragraph start with its actual claim.',
          hint_specific: 'What is the claim hiding behind this announcement? Could the sentence start there?',
          hint_general: 'No throat clearing: look at how this sentence begins.',
        });
      }
      const contraction = /\b(?:it's|don't|can't|isn't|won't|doesn't|we're|they're|that's)\b/i.exec(paragraph);
      const ruleId = /- rule: (\S+) \| No contractions/.exec(req.prompt)?.[1];
      if (contraction && ruleId) {
        const full: Record<string, string> = { "it's": 'it is', "don't": 'do not', "can't": 'cannot', "isn't": 'is not', "won't": 'will not', "doesn't": 'does not', "we're": 'we are', "they're": 'they are', "that's": 'that is' };
        suggestions.push({
          rule_id: ruleId,
          quote: contraction[0],
          issue: 'The rule asks for no contractions.',
          rewrite: ((w) => (/^[A-Z]/.test(contraction[0]) ? w[0]!.toUpperCase() + w.slice(1) : w))(full[contraction[0].toLowerCase()] ?? contraction[0]),
          explanation: 'Write the words out in full.',
          hint_specific: 'Which two words is this short for?',
          hint_general: 'No contractions: look at this word.',
        });
      }
      const first = splitSentences(paragraph)[0] ?? '';
      if (words(first).length > 28 && req.prompt.includes('short-declarative-openers')) {
        suggestions.push({
          move_id: 'short-declarative-openers',
          quote: first,
          issue: `The opening sentence runs ${words(first).length} words before the reader learns the point.`,
          rewrite: first.split(/,\s+(?:which|and|but)\s+/)[0] + '.',
          explanation: 'A short first sentence states the point; the qualifications can follow.',
          hint_specific: 'Which few words of this sentence carry the point? Could they stand alone first?',
          hint_general: 'Short declarative openers: look at the first sentence.',
        });
      }
      return JSON.stringify({ suggestions });
    }
    if (req.prompt.includes('<revised>')) {
      const original = /<original>([\s\S]*?)<\/original>/.exec(req.prompt)?.[1] ?? '';
      const revised = /<revised>([\s\S]*?)<\/revised>/.exec(req.prompt)?.[1] ?? '';
      const shorter = words(revised).length < words(original).length * 0.8;
      return JSON.stringify(
        shorter
          ? { verdict: 'landed', feedback: 'Shorter and the point comes first. That is the move.', exemplary: words(revised).length > 3 }
          : { verdict: 'partly', feedback: 'Still about as long as before. Try letting the main claim stand on its own first.', exemplary: false },
      );
    }
    if (req.prompt.includes('"conflicts"')) return JSON.stringify({ conflicts: [] });
    if (req.prompt.includes('Extract the writing rules')) {
      const lines = [...req.prompt.matchAll(/^\s*(?:[-*]|\d+\.)\s+(.{8,140})$/gm)].map((m) => m[1]!).filter((l) => !l.startsWith('"'));
      return JSON.stringify({
        rules: lines.slice(0, 8).map((l) => ({ title: l.split(/[.:;]/)[0]!.slice(0, 60), description: l, do: [], dont: [], applies_to: '', source: 'pasted document' })),
      });
    }
    if (req.prompt.includes('<source')) {
      return JSON.stringify({
        description: 'Mock extraction: the stand-in model only looks at sentence length.',
        moves: [
          { title: 'Short declarative openers', description: 'Open with a short claim.', rationale: 'Orients the reader.', importance: 0.8, examples: [] },
          { title: 'Address the reader directly', description: 'Use "you" and "we" to bring the reader along.', rationale: 'Keeps the tone conversational.', importance: 0.6, examples: [] },
        ],
      });
    }
    return '{"ok": true}';
  },
};

let harperLinter: Promise<any> | null = null;
async function harperCheck(text: string, language: string): Promise<GrammarIssue[]> {
  if (!harperDialectFor(language, 'british')) return [];
  if (!hasLatex(text)) return harperRaw(text);
  const masked = maskLatex(text);
  return mapBack(masked, text, await harperRaw(masked.text));
}

async function harperRaw(text: string): Promise<GrammarIssue[]> {
  harperLinter ??= (async () => {
    const { LocalLinter, Dialect } = await import('harper.js');
    const { binaryInlined } = await import('harper.js/binaryInlined');
    return new LocalLinter({ binary: binaryInlined, dialect: Dialect.British });
  })();
  const linter = await harperLinter;
  const lints = await linter.lint(text, { language: 'plaintext' });
  return lints
    .filter((l: any) => !['Style', 'Readability', 'Enhancement', 'WordChoice', 'Regionalism'].includes(l.lint_kind()))
    .map((l: any) => ({
      category: ['Spelling', 'Typo'].includes(l.lint_kind()) ? 'spelling' : 'grammar',
      from: l.span().start,
      to: l.span().end,
      text: text.slice(l.span().start, l.span().end),
      message: l.message(),
      replacements: l.suggestions().slice(0, 5).map((s: any) => s.get_replacement_text()),
      ruleId: l.lint_kind(),
      engine: 'harper',
    }));
}

export function createMockBackend(): Backend {
  const profiles = new Map<string, string>();
  const ruleSets = new Map<string, RuleSet>([[sampleRules().id, sampleRules()]]);
  const history = new Map<string, { snap: Snapshot; text: string }[]>();
  for (const p of sampleProfiles()) profiles.set(p.id, serializeProfile(p));
  let settings: Settings = {
    provider: 'claude-cli',
    anthropic: { apiKey: '', fastModel: 'claude-haiku-5-5', strongModel: 'claude-sonnet-5-5' },
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', fastModel: '', strongModel: '' },
    claudeCli: { binary: 'claude', fastModel: 'haiku', strongModel: 'sonnet' },
    codexCli: { binary: 'codex', model: '' },
    grammar: { engine: 'harper', languageToolUrl: 'http://localhost:8081', language: 'auto', harperDialect: 'british' },
    profilesDir: '(in memory)',
    activeGeneralProfile: null,
    generalByLanguage: { en: 'plain-physics' },
    activeProjectProfile: 'thesis',
    rulesByProject: { thesis: ['thesis-rules'] },
    mode: 'assistant',
    dictionary: [],
    theme: 'system',
    vim: false,
    vimEscape: { sequence: '', timeoutMs: 300, ctrlC: true },
    styleDebounceMs: 1200,
    grammarDebounceMs: 500,
  };

  const get = (id: string) => {
    const t = profiles.get(id);
    if (!t) throw new Error(`No profile "${id}"`);
    return { ...parseProfile(t, id), id };
  };
  const save = (p: TasteProfile, reason: string) => {
    const prev = profiles.get(p.id);
    if (prev) {
      const at = new Date().toISOString();
      const list = history.get(p.id) ?? [];
      list.push({ snap: { id: at.replace(/[:.]/g, '-'), at, reason }, text: prev });
      history.set(p.id, list);
    }
    const saved = touch(p);
    profiles.set(p.id, serializeProfile(saved));
    return saved;
  };
  const download = (name: string, data: string | Uint8Array, type: string) => {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  };
  const pickFiles = (accept: string, multiple: boolean) =>
    new Promise<File[]>((resolve) => {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept, multiple });
      input.onchange = () => resolve([...(input.files ?? [])]);
      input.click();
    });

  return {
    settings: {
      get: async () => settings,
      set: async (patch) => (settings = { ...settings, ...patch }),
    },
    profiles: {
      list: async () =>
        [...profiles.keys()].map((id): ProfileSummary => {
          const p = get(id);
          return { id, name: p.name, kind: p.kind, language: p.language, moves: p.moves.length, updated: p.updated };
        }),
      get: async (id) => get(id),
      save: async (p, reason) => save(p, reason),
      remove: async (id) => void profiles.delete(id),
      applyEvent: async (id, ev) => {
        const cur = get(id);
        const next = applyEvent(cur, ev);
        return next === cur ? cur : save(next, `auto: ${ev.type} ${ev.moveId}`);
      },
      history: async (id) => (history.get(id) ?? []).map((h) => h.snap).reverse(),
      readSnapshot: async (id, snap) => ({ ...parseProfile(history.get(id)!.find((h) => h.snap.id === snap)!.text, id), id }),
      rollback: async (id, snap) => save({ ...parseProfile(history.get(id)!.find((h) => h.snap.id === snap)!.text, id), id }, `before rollback to ${snap}`),
      exportTo: async (id, format, policy) => {
        const p = get(id);
        if (format === 'zip') download(`${id}.zip`, exportBundle(p, policy), 'application/zip');
        else download(`${id}.md`, exportMarkdown(p, policy), 'text/markdown');
        return `${id}.${format}`;
      },
      importFrom: async () => {
        const [f] = await pickFiles('.md,.zip', false);
        if (!f) return null;
        const data = f.name.endsWith('.zip') ? new Uint8Array(await f.arrayBuffer()) : await f.text();
        const p = importProfile(data, f.name);
        let id = p.id;
        for (let i = 2; profiles.has(id); i++) id = `${p.id}-${i}`;
        return save({ ...p, id }, 'import');
      },
      reveal: async () => {},
    },
    rules: {
      list: async () => [...ruleSets.values()].map((s) => ({ id: s.id, name: s.name, language: s.language, rules: s.rules.length, updated: s.updated })),
      get: async (id) => structuredClone(ruleSets.get(id)!),
      save: async (s) => {
        const saved = { ...structuredClone(s), updated: new Date().toISOString() };
        ruleSets.set(s.id, saved);
        return saved;
      },
      remove: async (id) => void ruleSets.delete(id),
      applyEvent: async (id, ev) => {
        const next = applyRuleEvent(ruleSets.get(id)!, ev);
        ruleSets.set(id, next);
        return next;
      },
      exportTo: async (id) => {
        download(`${id}.md`, serializeRuleSet(ruleSets.get(id)!), 'text/markdown');
        return `${id}.md`;
      },
      importFrom: async () => {
        const [f] = await pickFiles('.md', false);
        if (!f) return null;
        const s = parseRuleSet(await f.text(), f.name.replace(/\.md$/, ''));
        ruleSets.set(s.id, s);
        return s;
      },
    },
    coach: {
      extractRules: (docs, takenIds) => extractRules(fakeLLM, docs, { takenIds }),
      extract: (sources, name, kind, language) => extractProfile(fakeLLM, sources, { name, kind, language, takenIds: [...profiles.keys()] }),
      diff: async (a, b) => diffProfiles(a, b),
      checkStyle: (req) => checkStyle(fakeLLM, req),
      editFeedback: (req) => editFeedback(fakeLLM, req),
      blendConflicts: (p) => findBlendConflicts(fakeLLM, p),
    },
    grammar: { check: (text, language) => harperCheck(text, language || settings.grammar.language) },
    providers: {
      status: async () => ({ id: settings.provider, ok: true, detail: 'mock backend (browser preview)' }),
      login: async () => 'Sign-in is only available in the desktop app.',
      test: async () => fakeLLM.complete({ system: '', prompt: 'ping', tier: 'fast' }),
    },
    files: {
      pickSources: async () => Promise.all((await pickFiles('.md,.txt,.tex', true)).map(async (f) => ({ name: f.name.replace(/\.[^.]+$/, ''), text: await f.text() }))),
      openDocument: async () => {
        const [f] = await pickFiles('.md,.txt,.tex', false);
        return f ? { path: f.name, name: f.name, text: await f.text() } : null;
      },
      saveDocument: async (path, text) => {
        download(path ?? 'untitled.md', text, 'text/plain');
        return path ?? 'untitled.md';
      },
    },
  };
}
