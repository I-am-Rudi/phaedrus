import { useEffect, useState } from 'react';
import { computeMetrics } from '@shared/metrics';
import { mergeDiff, type DiffEntry } from '@shared/profile/diff';
import type { SourceDoc, StyleMove, TasteProfile } from '@shared/types';
import { errorText, plural, useApp } from '../state';

export function ExtractView() {
  const app = useApp();
  const { backend } = app;
  const [target, setTarget] = useState<string>(app.viewArg ?? '');
  const [targetProfile, setTargetProfile] = useState<TasteProfile | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TasteProfile['kind']>('general');
  const [sources, setSources] = useState<SourceDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<TasteProfile | null>(null);
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);

  useEffect(() => {
    setResult(null);
    setDiff(null);
    if (!target) return setTargetProfile(null);
    void backend.profiles.get(target).then((p) => {
      setTargetProfile(p);
      setName(p.name);
      setKind(p.kind);
    });
  }, [target, backend]);

  const words = sources.reduce((a, s) => a + computeMetrics(s.text).words, 0);

  async function addFiles() {
    try {
      const docs = await backend.files.pickSources();
      setSources([...sources, ...docs]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function run() {
    setBusy(true);
    setError('');
    setResult(null);
    setDiff(null);
    try {
      const extracted = await backend.coach.extract(sources.filter((s) => s.text.trim()), name || 'New profile', kind);
      setResult(extracted);
      if (targetProfile) setDiff(await backend.coach.diff(targetProfile, extracted));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveNew(use: boolean) {
    if (!result) return;
    const p = await backend.profiles.save(result, 'extraction');
    if (use) await app.updateSettings(p.kind === 'project' ? { activeProjectProfile: p.id } : { activeGeneralProfile: p.id });
    await app.refreshProfiles();
    app.go('profiles', p.id);
  }

  async function saveMerge() {
    if (!result || !targetProfile || !diff) return;
    const merged = mergeDiff(targetProfile, result, diff);
    const p = await backend.profiles.save(merged, 're-extraction');
    app.profileChanged(p);
    await app.refreshProfiles();
    app.go('profiles', p.id);
  }

  return (
    <div className="pane">
      <div className="pane-inner">
        <h1>Extract a taste profile</h1>
        <p className="muted" style={{ margin: 0 }}>
          Add writing you want to learn from. The model describes what these authors do as concrete moves; you can edit every move afterwards.
          More text from several pieces gives steadier results; a few thousand words per author is a good start.
        </p>

        <div className="grid3">
          <label className="field">
            Into
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">a new profile</option>
              {app.summaries.map((s) => <option key={s.id} value={s.id}>re-extract into {s.name}</option>)}
            </select>
          </label>
          <label className="field">Name<input type="text" value={name} disabled={!!target} placeholder="e.g. Feynman lectures" onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">
            Kind
            <select value={kind} disabled={!!target} onChange={(e) => setKind(e.target.value as TasteProfile['kind'])}>
              <option value="general">general</option>
              <option value="project">project</option>
            </select>
          </label>
        </div>

        <div className="section">
          <div className="row">
            <h2 className="grow">Sources <span className="muted small">{plural(sources.length, 'piece')}, {plural(words, 'word')}</span></h2>
            <button className="btn small" onClick={() => void addFiles()}>Add files</button>
            <button className="btn small" onClick={() => setSources([...sources, { name: `Pasted text ${sources.length + 1}`, text: '' }])}>Paste text</button>
          </div>
          {sources.map((s, i) => (
            <div className="source" key={i}>
              <div className="row">
                <input type="text" className="grow" value={s.name} onChange={(e) => setSources(sources.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                <input type="text" placeholder="author" value={s.author ?? ''} onChange={(e) => setSources(sources.map((x, k) => (k === i ? { ...x, author: e.target.value || undefined } : x)))} />
                <button className="btn ghost small" onClick={() => setSources(sources.filter((_, k) => k !== i))}>Remove</button>
              </div>
              <textarea rows={s.text.length > 400 ? 6 : 4} value={s.text} placeholder="Paste the text here" onChange={(e) => setSources(sources.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />
            </div>
          ))}
          {!sources.length && <div className="muted small">Markdown, plain text and LaTeX files work. For PDFs or e-books, export to text first.</div>}
        </div>

        <div className="row">
          <button className="btn primary" disabled={busy || !sources.some((s) => s.text.trim())} onClick={() => void run()}>
            {busy ? 'Extracting… (this can take a minute)' : 'Extract'}
          </button>
          {error && <span className="error">{error}</span>}
        </div>

        {result && !diff && (
          <div className="section">
            <div className="row">
              <h2 className="grow">{plural(result.moves.length, 'move')} found</h2>
              <button className="btn" onClick={() => void saveNew(false)}>Save</button>
              <button className="btn primary" onClick={() => void saveNew(true)}>Save and use for writing</button>
            </div>
            {result.description && <p style={{ margin: 0 }}>{result.description}</p>}
            {result.moves.map((m) => <MovePreview key={m.id} m={m} />)}
          </div>
        )}

        {diff && targetProfile && (
          <div className="section">
            <div className="row">
              <h2 className="grow">Changes against {targetProfile.name}</h2>
              <button className="btn primary" onClick={() => void saveMerge()}>Merge selected</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Weights, scopes, locks, notes, hint levels and your own examples are always kept. Only ticked entries change.
            </p>
            {diff.map((d, i) => (
              <div className="diff-entry" key={i}>
                <input type="checkbox" disabled={d.kind === 'unchanged'} checked={d.apply} onChange={(e) => setDiff(diff.map((x, k) => (k === i ? { ...x, apply: e.target.checked } : x)))} />
                <span className={`kindlabel kind-${d.kind}`}>{d.kind === 'missing' ? 'remove?' : d.kind}</span>
                <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <b>{(d.incoming ?? d.current)!.title}</b>
                  {d.kind === 'changed' ? (
                    <div className="cmp">
                      <div><div className="small muted">now</div>{d.current!.description}</div>
                      <div><div className="small muted">new</div>{d.incoming!.description}</div>
                    </div>
                  ) : (
                    <span className="small">{(d.incoming ?? d.current)!.description}</span>
                  )}
                  {d.note && <span className="small muted">{d.note}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MovePreview({ m }: { m: StyleMove }) {
  return (
    <div className="move">
      <div className="move-head" style={{ cursor: 'default' }}>
        <span className="title">{m.title}</span>
        <span className="w" title={`weight ${m.weight}`}><i style={{ width: `${m.weight * 100}%` }} /></span>
      </div>
      <div className="move-body" style={{ gap: 6 }}>
        <div>{m.description}</div>
        {m.rationale && <div className="small muted">{m.rationale}</div>}
        {m.examples.map((e, i) => (
          <div key={i} style={{ fontFamily: 'var(--serif)', borderLeft: '2px solid var(--line-strong)', paddingLeft: 10 }}>
            {e.text} {e.source && <span className="small muted">({e.source})</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
