// Document languages. A project profile can set one; otherwise the default
// from Settings applies. Codes are LanguageTool's.

export const LANGUAGES: [code: string, label: string][] = [
  ['auto', 'Detect per paragraph'],
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)'],
  ['en-CA', 'English (Canada)'],
  ['en-AU', 'English (Australia)'],
  ['de-DE', 'German (Germany)'],
  ['de-AT', 'German (Austria)'],
  ['de-CH', 'German (Switzerland)'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['nl', 'Dutch'],
  ['ca', 'Catalan'],
  ['uk-UA', 'Ukrainian'],
  ['pl-PL', 'Polish'],
  ['ru-RU', 'Russian'],
  ['it', 'Italian'],
  ['sv', 'Swedish'],
  ['da-DK', 'Danish'],
  ['el-GR', 'Greek'],
];

export function languageLabel(code: string): string {
  return LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}

type Dialect = 'american' | 'british' | 'australian' | 'canadian';

/**
 * Harper only checks English. Returns the dialect for an English language code,
 * the fallback for "auto" or plain "en", and null for any other language.
 */
export function harperDialectFor(language: string, fallback: Dialect): Dialect | null {
  const l = language.toLowerCase();
  if (!l || l === 'auto' || l === 'en') return fallback;
  if (!l.startsWith('en')) return null;
  if (l.endsWith('gb') || l.endsWith('uk') || l.endsWith('nz') || l.endsWith('za')) return 'british';
  if (l.endsWith('us')) return 'american';
  if (l.endsWith('ca')) return 'canadian';
  if (l.endsWith('au')) return 'australian';
  return fallback;
}

/** "de-AT" -> "de"; "auto" or empty -> null (no particular language). */
export function baseLanguage(code: string | undefined): string | null {
  if (!code || code === 'auto') return null;
  return code.split('-')[0]!.toLowerCase();
}

/** A profile applies to a document if either has no language or both share the base language. */
export function languageMatches(profileLanguage: string | undefined, docLanguage: string | undefined): boolean {
  const p = baseLanguage(profileLanguage);
  const d = baseLanguage(docLanguage);
  return !p || !d || p === d;
}

export function baseLabel(base: string | null): string {
  if (!base) return 'Any language';
  const hit = LANGUAGES.find(([c]) => baseLanguage(c) === base);
  return hit ? hit[1].replace(/\s*\(.*\)$/, '') : base;
}
