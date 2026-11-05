// Cheap, deterministic style measurements. Used to describe source authors
// during extraction and to flag obvious rhythm drift without calling an LLM.

import type { StyleMetrics } from './types';

const HEDGES = [
  'perhaps', 'maybe', 'possibly', 'probably', 'arguably', 'somewhat', 'rather', 'quite',
  'seems', 'seem', 'seemed', 'appears', 'appear', 'suggests', 'suggest', 'likely', 'might',
  'could', 'may', 'fairly', 'relatively', 'generally', 'typically', 'presumably',
];
const FIRST_PERSON = new Set(['i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours']);
const BE_FORMS = '(?:is|are|was|were|be|been|being|am)';
const PASSIVE = new RegExp(`\\b${BE_FORMS}\\s+(?:\\w+ly\\s+)?\\w+(?:ed|en|wn|lt|pt|ung|ought)\\b`, 'i');
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|cf|vs|Dr|Mr|Mrs|Ms|Prof|Fig|Eq|Sec|al|approx|resp)\.$/i;

export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function splitSentences(paragraph: string): string[] {
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const parts: string[] = [];
  let start = 0;
  const re = /[.!?]+["')\]]*(?=\s+["'(\[]?[A-Z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) {
    const end = m.index + m[0].length;
    const candidate = flat.slice(start, end).trim();
    if (ABBREVIATIONS.test(candidate) || /\b[A-Z]\.$/.test(candidate)) continue;
    parts.push(candidate);
    start = end;
  }
  const rest = flat.slice(start).trim();
  if (rest) parts.push(rest);
  return parts;
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function computeMetrics(text: string): StyleMetrics {
  const paragraphs = splitParagraphs(text);
  const sentences = paragraphs.flatMap(splitSentences);
  const sentenceLengths = sentences.map((s) => words(s).length).filter((n) => n > 0);
  const allWords = words(text);
  const n = allWords.length || 1;
  const hedges = allWords.filter((w) => HEDGES.includes(w)).length;
  const firstPerson = allWords.filter((w) => FIRST_PERSON.has(w)).length;
  // Type-token ratio over a fixed window so long sources are comparable to short ones.
  const window = allWords.slice(0, 1000);
  return {
    sentenceLengthMean: round(mean(sentenceLengths), 1),
    sentenceLengthStd: round(std(sentenceLengths), 1),
    paragraphLengthMean: round(mean(paragraphs.map((p) => words(p).length)), 1),
    wordLengthMean: round(mean(allWords.map((w) => w.length))),
    typeTokenRatio: round(window.length ? new Set(window).size / window.length : 0),
    hedgeRate: round((hedges / n) * 100),
    passiveRate: round(sentences.length ? sentences.filter((s) => PASSIVE.test(s)).length / sentences.length : 0),
    questionRate: round(sentences.length ? sentences.filter((s) => s.trim().endsWith('?')).length / sentences.length : 0),
    firstPersonRate: round((firstPerson / n) * 100),
    words: allWords.length,
  };
}

/** Word-weighted average of several metric sets. */
export function combineMetrics(sets: { metrics: StyleMetrics; weight: number }[]): StyleMetrics | undefined {
  const usable = sets.filter((s) => s.weight > 0 && s.metrics);
  if (!usable.length) return undefined;
  const total = usable.reduce((a, s) => a + s.weight, 0);
  const keys = Object.keys(usable[0]!.metrics) as (keyof StyleMetrics)[];
  const out = {} as StyleMetrics;
  for (const k of keys) {
    if (k === 'words') out.words = usable.reduce((a, s) => a + s.metrics.words, 0);
    else out[k] = round(usable.reduce((a, s) => a + s.metrics[k] * s.weight, 0) / total);
  }
  return out;
}

export interface MetricDrift {
  key: keyof StyleMetrics;
  label: string;
  yours: number;
  target: number;
}

/**
 * Compare a passage to the profile's metrics and report clear deviations.
 * Only robust signals are used; short passages report nothing.
 */
export function metricDrift(passage: string, target: StyleMetrics | undefined): MetricDrift[] {
  if (!target) return [];
  const m = computeMetrics(passage);
  if (m.words < 40) return [];
  const drifts: MetricDrift[] = [];
  const tol = Math.max(target.sentenceLengthStd, 4);
  if (Math.abs(m.sentenceLengthMean - target.sentenceLengthMean) > 1.5 * tol) {
    drifts.push({ key: 'sentenceLengthMean', label: 'average sentence length (words)', yours: m.sentenceLengthMean, target: target.sentenceLengthMean });
  }
  if (target.sentenceLengthStd > 0 && m.sentenceLengthStd < 0.4 * target.sentenceLengthStd && m.words > 80) {
    drifts.push({ key: 'sentenceLengthStd', label: 'variation in sentence length', yours: m.sentenceLengthStd, target: target.sentenceLengthStd });
  }
  if (m.hedgeRate > 2 * target.hedgeRate + 1) {
    drifts.push({ key: 'hedgeRate', label: 'hedges per 100 words', yours: m.hedgeRate, target: target.hedgeRate });
  }
  if (m.passiveRate > target.passiveRate + 0.3) {
    drifts.push({ key: 'passiveRate', label: 'share of passive sentences', yours: m.passiveRate, target: target.passiveRate });
  }
  return drifts;
}
