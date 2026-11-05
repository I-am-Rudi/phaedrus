import { useState } from 'react';
import { blendProfiles, resolveConflict, type ConflictChoice } from '@shared/profile/blend';
import { baseLabel, baseLanguage, languageMatches } from '@shared/language';
import type { BlendConflict, TasteProfile } from '@shared/types';
import { errorText, plural, useApp } from '../state';

const CHOICES: [ConflictChoice, string][] = [
  ['a', 'keep first'],
  ['b', 'keep second'],
  ['merge', 'merge into one'],
  ['both', 'keep both'],
];

export function BlendView() {
  const app = useApp();
  const { backend, summaries } = app;
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [name, setName] = useState('Blend');
  const [base, setBase] = useState<string | null>(baseLanguage(app.language));
  const bases = [...new Set(summaries.map((s) => baseLanguage(s.language)))];
  const candidates = summaries.filter((s) => languageMatches(s.language, base ?? undefined) && (base === null ? !s.language : true));
  const [draft, setDraft] = useState<TasteProfile | null>(null);
  const [conflicts, setConflicts] = useState<(BlendConflict & { choice: ConflictChoice })[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const chosen = Object.entries(weights).filter(([id, w]) => w > 0 && candidates.some((c) => c.id === id));
  const total = chosen.reduce((a, [, w]) => a + w, 0) || 1;

  async function blend() {
    setError('');
    try {
      const inputs = await Promise.all(chosen.map(async ([id, weight]) => ({ profile: await backend.profiles.get(id), weight })));
      const r = blendProfiles(inputs, name, summaries.map((s) => s.id));
      const lang = inputs.map((i) => i.profile.language).find(Boolean);
      if (lang) r.profile.language = lang;
      setDraft(r.profile);
      setConflicts(r.conflicts.map((c) => ({ ...c, choice: 'merge' as ConflictChoice })));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function checkWithModel() {
    if (!draft) return;
    setChecking(true);
    setError('');
    try {
      const found = await backend.coach.blendConflicts(draft);
      const key = (c: BlendConflict) => [c.a.moveId, c.b.moveId].sort().join('|');
      const known = new Set(conflicts.map(key));
      setConflicts([...conflicts, ...found.filter((c) => !known.has(key(c))).map((c) => ({ ...c, choice: 'both' as ConflictChoice }))]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (!draft) return;
    let p = draft;
    for (const c of conflicts) p = resolveConflict(p, c, c.choice);
    const saved = await backend.profiles.save(p, 'blend');
    await app.refreshProfiles();
    app.go('profiles', saved.id);
  }

  return (
    <div className="pane">
      <div className="pane-inner">
        <h1>Blend profiles</h1>
        <p className="muted" style={{ margin: 0 }}>
          Combine profiles with weights, for example 70 % one author's rhythm and 30 % another's precision. Moves keep their own weight, scaled by the profile's share.
        </p>
        <div className="row">
          <span className="small muted">Profiles in</span>
          <div className="seg">
            {bases.map((b) => (
              <button key={b ?? 'any'} className={b === base ? 'on' : ''} onClick={() => { setBase(b); setDraft(null); }}>{baseLabel(b)}</button>
            ))}
          </div>
          <span className="small muted">Only profiles of one language can be blended.</span>
        </div>
        <div className="section">
          {candidates.map((s) => (
            <div className="row" key={s.id}>
              <span style={{ width: 220 }}>{s.name} <span className="small muted">{plural(s.moves, 'move')}</span></span>
              <input type="range" className="grow" min={0} max={100} step={5} value={(weights[s.id] ?? 0) * 100} onChange={(e) => setWeights({ ...weights, [s.id]: Number(e.target.value) / 100 })} />
              <span style={{ width: 50, textAlign: 'right' }}>{weights[s.id] ? `${Math.round(((weights[s.id] ?? 0) / total) * 100)} %` : 'off'}</span>
            </div>
          ))}
        </div>
        <div className="row">
          <label className="field" style={{ width: 260 }}>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={chosen.length < 2} onClick={() => void blend()}>Blend</button>
          {error && <span className="error" style={{ alignSelf: 'flex-end' }}>{error}</span>}
        </div>

        {draft && (
          <div className="section">
            <div className="row">
              <h2 className="grow">{plural(draft.moves.length, 'move')}, {plural(conflicts.length, 'overlap')} to resolve</h2>
              <button className="btn" disabled={checking} onClick={() => void checkWithModel()}>{checking ? 'Checking…' : 'Find contradictions with the model'}</button>
              <button className="btn primary" onClick={() => void save()}>Save blended profile</button>
            </div>
            {conflicts.map((c, i) => (
              <div className="diff-entry" key={i} style={{ flexDirection: 'column' }}>
                <div><b>{c.a.title}</b> <span className="muted">({c.a.profileId})</span> and <b>{c.b.title}</b> <span className="muted">({c.b.profileId})</span></div>
                <div className="small muted">{c.reason}</div>
                <div className="row">
                  {CHOICES.map(([v, label]) => (
                    <label className="inline small" key={v}>
                      <input type="radio" name={`c${i}`} checked={c.choice === v} onChange={() => setConflicts(conflicts.map((x, k) => (k === i ? { ...x, choice: v } : x)))} /> {label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {!conflicts.length && <div className="muted small">No overlapping moves found by title. The model check looks for contradictions between differently named moves.</div>}
            <div className="small muted">After saving, the blend opens in the profile editor where every move can be adjusted.</div>
          </div>
        )}
      </div>
    </div>
  );
}
