// Export and import of taste profiles: a single Markdown file or a zip bundle.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { words } from '../metrics';
import type { TasteProfile } from '../types';
import { parseProfile, serializeProfile } from './markdown';

/**
 * all   — keep every author excerpt (fine for local use)
 * short — keep excerpts of at most SHORT_EXCERPT_WORDS words
 * none  — drop author excerpts; move descriptions carry the profile
 * Your own example sentences are always kept.
 */
export type ExcerptPolicy = 'all' | 'short' | 'none';
export const SHORT_EXCERPT_WORDS = 25;

export function applyExcerptPolicy(p: TasteProfile, policy: ExcerptPolicy): TasteProfile {
  if (policy === 'all') return p;
  return {
    ...p,
    moves: p.moves.map((m) => ({
      ...m,
      examples: m.examples.filter(
        (e) => e.kind === 'user' || (policy === 'short' && words(e.text).length <= SHORT_EXCERPT_WORDS),
      ),
    })),
  };
}

export function exportMarkdown(p: TasteProfile, policy: ExcerptPolicy = 'all'): string {
  return serializeProfile(applyExcerptPolicy(p, policy));
}

const BUNDLE_README = `This is a stylecoach taste-profile bundle.

profile.md   the profile: YAML frontmatter, then one "## Move" section per style move
sources.md   the works the profile was extracted from

Import it in stylecoach (Profiles > Import), or read and edit profile.md in any text editor.
`;

export function exportBundle(p: TasteProfile, policy: ExcerptPolicy = 'all'): Uint8Array {
  const sources =
    `# Sources for ${p.name}\n\n` +
    (p.sources.length ? p.sources.map((s) => `- ${s.title}${s.author ? ` — ${s.author}` : ''}`).join('\n') : '_none recorded_') +
    '\n';
  return zipSync({
    'profile.md': strToU8(exportMarkdown(p, policy)),
    'sources.md': strToU8(sources),
    'README.txt': strToU8(BUNDLE_README),
  });
}

/** Import from a .md file's text or a .zip bundle's bytes. */
export function importProfile(data: string | Uint8Array, fileName = 'profile'): TasteProfile {
  if (typeof data === 'string') return parseProfile(data, stem(fileName));
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const files = unzipSync(data);
    const names = Object.keys(files);
    const pick = names.find((n) => n.endsWith('profile.md')) ?? names.find((n) => n.endsWith('.md') && !n.endsWith('sources.md'));
    if (!pick) throw new Error('No profile.md found in the bundle.');
    return parseProfile(strFromU8(files[pick]!), stem(fileName));
  }
  return parseProfile(strFromU8(data), stem(fileName));
}

function stem(name: string): string {
  return name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'profile';
}
