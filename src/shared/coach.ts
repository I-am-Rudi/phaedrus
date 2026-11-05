// Everything that talks to a language model: profile extraction, style checks,
// teacher-mode edit feedback and blend conflict checks. Provider-agnostic: the
// caller passes an `LLM` that turns a system+user prompt into text.

import { extractJson, num, str } from './json';
import { hasLatex, maskLatex, proseOf, rewriteKeepsLatex } from './latex';
import { computeMetrics, metricDrift } from './metrics';
import { newMove, newProfile } from './profile/model';
import { findQuote } from './spans';
import type {
  BlendConflict,
  EditFeedback,
  Example,
  SourceDoc,
  StyleMetrics,
  StyleMove,
  StyleSuggestion,
  TasteProfile,
} from './types';

export type Tier = 'fast' | 'strong';

export interface LLMRequest {
  system: string;
  prompt: string;
  /** fast = style checks and feedback; strong = extraction and conflict checks. */
  tier: Tier;
  maxTokens?: number;
}

export interface LLM {
  complete(req: LLMRequest): Promise<string>;
}

// ---------------------------------------------------------------- extraction

const SOURCE_BUDGET_CHARS = 60_000;

/** Take evenly spread slices of long sources so the model sees beginning, middle and end. */
export function sampleSources(sources: SourceDoc[], budget = SOURCE_BUDGET_CHARS): SourceDoc[] {
  const per = Math.floor(budget / Math.max(1, sources.length));
  return sources.map((s) => {
    if (s.text.length <= per) return s;
    const chunks = 4;
    const size = Math.floor(per / chunks);
    const step = Math.floor((s.text.length - size) / (chunks - 1));
    const parts: string[] = [];
    for (let i = 0; i < chunks; i++) parts.push(s.text.slice(i * step, i * step + size).trim());
    return { ...s, text: parts.join('\n\n[…]\n\n') };
  });
}

const EXTRACT_SYSTEM = `You are a writing teacher who analyses prose style precisely.
You describe what authors do at the level of concrete, teachable moves: how sentences open and end, rhythm, how claims are qualified, how examples are introduced, how paragraphs are built, word choice, how the reader is addressed.
You never describe topic or content, only how the writing works.
Sources may be scientific texts converted from LaTeX: inline math stays as $...$ and displayed equations appear as [equation]. Moves about how equations, symbols and references are introduced in the prose are welcome; never describe the mathematics itself.
You answer with JSON only.`;

export function extractionPrompt(sources: SourceDoc[], metrics: StyleMetrics): string {
  const prose = sources.map((s) => (hasLatex(s.text) ? { ...s, text: maskLatex(s.text, 'prose').text } : s));
  const blocks = sampleSources(prose)
    .map((s, i) => `<source index="${i + 1}" title="${esc(s.name)}"${s.author ? ` author="${esc(s.author)}"` : ''}>\n${s.text}\n</source>`)
    .join('\n\n');
  return `Study these sources and extract the style moves that make this writing what it is.

${blocks}

Measured features of the sources:
${formatMetrics(metrics)}

Return JSON of this shape:
{
  "description": "two or three sentences characterising the overall style",
  "moves": [
    {
      "title": "short name of the move, 2-6 words",
      "description": "what the writer does, concretely enough that someone could check a paragraph for it",
      "rationale": "why it works for the reader",
      "importance": 0.0-1.0,
      "examples": [{ "text": "a short verbatim excerpt showing the move (max 40 words)", "source": "title or author" }]
    }
  ]
}

Rules:
- 6 to 14 moves, most characteristic first. Prefer moves several sources share.
- Each move must be something a writer can deliberately do or avoid; no vague praise like "clear writing".
- Excerpts must be copied exactly from the sources, at most 2 per move, each under 40 words.`;
}

export async function extractProfile(
  llm: LLM,
  sources: SourceDoc[],
  opts: { name: string; kind?: TasteProfile['kind']; takenIds?: string[] },
): Promise<TasteProfile> {
  if (!sources.length) throw new Error('Add at least one source.');
  const metrics = computeMetrics(sources.map((s) => s.text).join('\n\n'));
  const reply = await llm.complete({
    system: EXTRACT_SYSTEM,
    prompt: extractionPrompt(sources, metrics),
    tier: 'strong',
    maxTokens: 6000,
  });
  const data = extractJson<any>(reply);
  const rawMoves: any[] = Array.isArray(data?.moves) ? data.moves : [];
  if (!rawMoves.length) throw new Error('The model returned no style moves.');

  const profile = newProfile(opts.name, opts.kind ?? 'general', opts.takenIds ?? []);
  profile.description = str(data.description);
  profile.metrics = metrics;
  profile.sources = sources.map((s) => (s.author ? { title: s.name, author: s.author } : { title: s.name }));
  const taken: string[] = [];
  for (const rm of rawMoves) {
    const title = str(rm?.title).trim();
    if (!title) continue;
    const examples: Example[] = (Array.isArray(rm.examples) ? rm.examples : [])
      .map((e: any) => ({ text: str(e?.text).trim(), source: str(e?.source).trim() || undefined, kind: 'author' as const }))
      .filter((e: Example) => e.text);
    const move = newMove(
      {
        title,
        description: str(rm.description),
        rationale: str(rm.rationale),
        weight: num(rm.importance, 0.6),
        origin: 'extracted',
        examples,
      },
      taken,
    );
    taken.push(move.id);
    profile.moves.push(move);
  }
  return profile;
}

// ------------------------------------------------------------- style checks

const CHECK_SYSTEM = `You are a style coach. You compare one paragraph of the user's writing with a style profile and point out where it drifts from the moves in that profile.
You only comment on style. Never comment on spelling, grammar, punctuation or the content of the argument.
Only flag a passage when applying a move would clearly improve it. A paragraph that already fits gets no suggestions.
The text may contain LaTeX or Markdown math. Treat math ($...$, \\(...\\), \\[...\\], equation environments), commands (\\cite, \\ref, \\eqref, \\label, \\emph, ...) and comments as fixed: never comment on them, never change them, and copy them character for character into any rewrite whose quote contains them. Never quote a passage that consists only of markup.
You answer with JSON only.`;

export interface StyleCheckRequest {
  paragraph: string;
  before?: string;
  after?: string;
  moves: StyleMove[];
  docType: string;
  section: string;
  metrics?: StyleMetrics;
  /** Upper bound on suggestions returned for the paragraph. */
  limit?: number;
}

function formatMove(m: StyleMove): string {
  const ex = m.examples
    .slice(0, 2)
    .map((e) => `    e.g. "${oneLine(e.text)}"${e.kind === 'user' ? ' (the user\'s own sentence)' : ''}`)
    .join('\n');
  const notes = m.notes.filter((n) => !n.startsWith('from ')).map((n) => `    user note: ${oneLine(n)}`).join('\n');
  return [`- id: ${m.id} | weight ${m.weight.toFixed(2)} | ${m.title}`, `    ${oneLine(m.description)}`, ex, notes]
    .filter(Boolean)
    .join('\n');
}

export function styleCheckPrompt(req: StyleCheckRequest): string {
  const drift = metricDrift(req.paragraph, req.metrics);
  const driftText = drift.length
    ? `\nMeasured drift in this paragraph:\n${drift.map((d) => `- ${d.label}: ${d.yours} here vs ${d.target} in the profile`).join('\n')}\n`
    : '';
  return `Document type: ${req.docType || 'unspecified'}
Section: ${req.section || 'unspecified'}

Style moves (higher weight = the user cares more; respect user notes):
${req.moves.map(formatMove).join('\n')}
${driftText}
${req.before ? `Previous paragraph (context only, do not flag):\n<context>${req.before}</context>\n\n` : ''}Paragraph to check:
<paragraph>${req.paragraph}</paragraph>
${req.after ? `\nNext paragraph (context only, do not flag):\n<context>${req.after}</context>\n` : ''}
Return JSON:
{
  "suggestions": [
    {
      "move_id": "id of the move this is about",
      "quote": "exact, contiguous text copied from the paragraph that the suggestion is about, as short as possible (a phrase or one sentence)",
      "issue": "one sentence: what drifts from the move here",
      "rewrite": "replacement for exactly the quoted text, applying the move",
      "explanation": "one or two sentences on why the rewrite is closer to the move",
      "hint_specific": "a question or nudge that points at what to change here without giving the answer",
      "hint_general": "names the move and what to look at, without specifics"
    }
  ]
}
At most ${req.limit ?? 3} suggestions, most important first. "quote" must match the paragraph character for character.`;
}

export async function checkStyle(llm: LLM, req: StyleCheckRequest): Promise<StyleSuggestion[]> {
  // Skip paragraphs that are mostly equations or markup.
  if (!req.moves.length || proseOf(req.paragraph).replace(/\bX\b/g, '').trim().length < 20) return [];
  const reply = await llm.complete({ system: CHECK_SYSTEM, prompt: styleCheckPrompt(req), tier: 'fast', maxTokens: 1500 });
  return parseSuggestions(reply, req);
}

export function parseSuggestions(reply: string, req: Pick<StyleCheckRequest, 'paragraph' | 'moves' | 'limit'>): StyleSuggestion[] {
  const data = extractJson<any>(reply);
  const raw: any[] = Array.isArray(data) ? data : Array.isArray(data?.suggestions) ? data.suggestions : [];
  const known = new Set(req.moves.map((m) => m.id));
  const out: StyleSuggestion[] = [];
  for (const s of raw) {
    const moveId = str(s?.move_id ?? s?.moveId);
    const quote = str(s?.quote);
    if (!known.has(moveId) || !quote.trim()) continue;
    const range = findQuote(req.paragraph, quote);
    if (!range) continue; // the model misquoted; drop rather than guess
    const rewrite = str(s.rewrite);
    const quoted = req.paragraph.slice(range.from, range.to);
    // A rewrite must keep every equation and reference of the passage verbatim.
    if (!rewriteKeepsLatex(quoted, rewrite)) continue;
    out.push({
      moveId,
      quote: req.paragraph.slice(range.from, range.to),
      issue: str(s.issue),
      rewrite,
      explanation: str(s.explanation),
      hints: { specific: str(s.hint_specific ?? s.hintSpecific), general: str(s.hint_general ?? s.hintGeneral) },
    });
  }
  return out.slice(0, req.limit ?? 3);
}

// ------------------------------------------------------- teacher-mode feedback

const FEEDBACK_SYSTEM = `You are a style coach giving feedback on a revision the user just made.
Judge only whether the revision applies the style move. Be brief, concrete and honest; do not praise a revision that misses.
The text may contain LaTeX; judge the prose around it, not the markup.
You answer with JSON only.`;

export interface EditFeedbackRequest {
  move: StyleMove;
  issue: string;
  original: string;
  revised: string;
  paragraph: string;
}

export function editFeedbackPrompt(req: EditFeedbackRequest): string {
  return `Style move: ${req.move.title}
${req.move.description}
${req.move.examples.slice(0, 2).map((e) => `Example: "${oneLine(e.text)}"`).join('\n')}

The coach pointed out: ${req.issue}
Original passage: <original>${req.original}</original>
The user's revision: <revised>${req.revised}</revised>
Revised paragraph for context: <paragraph>${req.paragraph}</paragraph>

Return JSON:
{
  "verdict": "landed" | "partly" | "overcorrected" | "missed",
  "feedback": "one to three sentences: what works, and what to try next if it did not fully land",
  "exemplary": true if the revision is a clean, natural example of the move worth keeping as a reference, else false
}`;
}

export async function editFeedback(llm: LLM, req: EditFeedbackRequest): Promise<EditFeedback> {
  if (!req.revised.trim()) {
    return { verdict: 'missed', feedback: 'The passage was deleted, so there is nothing to compare. Undo or rewrite it to get feedback.', exemplary: false };
  }
  const reply = await llm.complete({ system: FEEDBACK_SYSTEM, prompt: editFeedbackPrompt(req), tier: 'fast', maxTokens: 600 });
  const data = extractJson<any>(reply);
  const verdict = ['landed', 'partly', 'overcorrected', 'missed'].includes(data?.verdict) ? data.verdict : 'partly';
  return { verdict, feedback: str(data?.feedback, 'No feedback returned.'), exemplary: data?.exemplary === true };
}

// ----------------------------------------------------------- blend conflicts

export async function findBlendConflicts(llm: LLM, profile: TasteProfile): Promise<BlendConflict[]> {
  if (profile.moves.length < 2) return [];
  const prompt = `These style moves come from different author profiles that are being blended into one.
Find pairs of moves that pull in opposite directions (a writer could not follow both in the same passage).

${profile.moves.map((m) => `- ${m.id}: ${m.title}: ${oneLine(m.description)} [${m.notes.find((n) => n.startsWith('from ')) ?? ''}]`).join('\n')}

Return JSON: { "conflicts": [ { "a": "move id", "b": "move id", "reason": "one sentence" } ] }
Return an empty list if nothing conflicts.`;
  const reply = await llm.complete({ system: 'You analyse writing style. You answer with JSON only.', prompt, tier: 'strong', maxTokens: 1500 });
  const data = extractJson<any>(reply);
  const byId = new Map(profile.moves.map((m) => [m.id, m]));
  const origin = (m: StyleMove) => m.notes.find((n) => n.startsWith('from '))?.slice(5) ?? profile.id;
  return (Array.isArray(data?.conflicts) ? data.conflicts : [])
    .map((c: any) => {
      const a = byId.get(str(c?.a));
      const b = byId.get(str(c?.b));
      if (!a || !b || a.id === b.id) return null;
      return {
        a: { profileId: origin(a), moveId: a.id, title: a.title },
        b: { profileId: origin(b), moveId: b.id, title: b.title },
        reason: str(c.reason),
      };
    })
    .filter((c: BlendConflict | null): c is BlendConflict => c !== null);
}

// ------------------------------------------------------------------ helpers

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function esc(s: string): string {
  return s.replace(/"/g, "'");
}

function formatMetrics(m: StyleMetrics): string {
  return [
    `- sentence length: mean ${m.sentenceLengthMean} words, spread ${m.sentenceLengthStd}`,
    `- paragraph length: mean ${m.paragraphLengthMean} words`,
    `- hedges per 100 words: ${m.hedgeRate}`,
    `- passive sentences: ${Math.round(m.passiveRate * 100)}%`,
    `- questions: ${Math.round(m.questionRate * 100)}%`,
    `- first person per 100 words: ${m.firstPersonRate}`,
    `- vocabulary variety (type/token): ${m.typeTokenRatio}`,
  ].join('\n');
}
