/** Pull the first JSON object or array out of a model reply (handles code fences and chatter). */
export function extractJson<T = unknown>(text: string): T {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((x): x is string => !!x);
  for (const c of candidates) {
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      /* fall through */
    }
    for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
      const start = trimmed.indexOf(open);
      const end = trimmed.lastIndexOf(close);
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1)) as T;
        } catch {
          /* try next */
        }
      }
    }
  }
  throw new Error('The model reply did not contain valid JSON.');
}

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
