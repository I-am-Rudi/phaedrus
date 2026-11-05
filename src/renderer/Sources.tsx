// Source documents for extraction (profiles and rule sets): files or pasted
// text, with the warnings the reader attached (scanned PDF, unreadable file).

import { computeMetrics } from '@shared/metrics';
import type { SourceDoc } from '@shared/types';
import { errorText, plural, useApp } from './state';

export function SourcesEditor({
  sources,
  setSources,
  withAuthor = true,
  placeholder = 'Paste the text here',
}: {
  sources: SourceDoc[];
  setSources(s: SourceDoc[]): void;
  withAuthor?: boolean;
  placeholder?: string;
}) {
  const app = useApp();
  const words = sources.reduce((a, s) => a + computeMetrics(s.text).words, 0);
  const update = (i: number, patch: Partial<SourceDoc>) => setSources(sources.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <>
      <div className="row">
        <span className="grow small muted">{plural(sources.length, 'piece')}, {plural(words, 'word')}</span>
        <button
          className="btn small"
          onClick={async () => {
            try {
              setSources([...sources, ...(await app.backend.files.pickSources())]);
            } catch (e) {
              app.notify(errorText(e));
            }
          }}
        >
          Add files
        </button>
        <button className="btn small" onClick={() => setSources([...sources, { name: `Pasted text ${sources.length + 1}`, text: '' }])}>Paste text</button>
      </div>
      {sources.map((s, i) => (
        <div className="source" key={i}>
          <div className="row">
            <input type="text" className="grow" value={s.name} onChange={(e) => update(i, { name: e.target.value })} />
            {withAuthor && <input type="text" placeholder="author" value={s.author ?? ''} onChange={(e) => update(i, { author: e.target.value || undefined })} />}
            <button className="btn ghost small" onClick={() => setSources(sources.filter((_, k) => k !== i))}>Remove</button>
          </div>
          {s.warning && <div className="small" style={{ color: 'var(--accent-ink)' }}>{s.warning}</div>}
          <textarea rows={s.text.length > 400 ? 6 : 4} value={s.text} placeholder={placeholder} onChange={(e) => update(i, { text: e.target.value })} />
        </div>
      ))}
      {!sources.length && (
        <div className="muted small">PDF, EPUB, Markdown, plain text and LaTeX files work. Text is pulled from PDFs and e-books automatically; scanned PDFs are read by the model.</div>
      )}
    </>
  );
}
