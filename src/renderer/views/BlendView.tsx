import { useState, type ReactNode } from 'react';
import { blendRuleSets, type RuleBlend, type RuleSet } from '@shared/rules';
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
  const [what, setWhat] = useState<'profiles' | 'rules'>('profiles');
  const toggle = (
    <div className="seg">
      <button className={what === 'profiles' ? 'on' : ''} onClick={() => setWhat('profiles')}>Taste profiles</button>
      <button className={what === 'rules' ? 'on' : ''} onClick={() => setWhat('rules')}>Rule sets</button>
    </div>
  );
  return what === 'profiles' ? <BlendProfiles toggle={toggle} /> : <BlendRules toggle={toggle} />;
}

function BlendProfiles({ toggle }: { toggle: ReactNode }) {
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
        <div className="row">
          <h1 className="grow">Blend</h1>
          {toggle}
        </div>
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

/** Rule sets have no weights: the blend takes every rule once and lists the ones that repeat. */
function BlendRules({ toggle }: { toggle: ReactNode }) {
  const app = useApp();
  const { backend, ruleSummaries } = app;
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('Combined rules');
  const [base, setBase] = useState<string | null>(baseLanguage(app.language));
  const bases = [...new Set(ruleSummaries.map((s) => baseLanguage(s.language)))];
  const candidates = ruleSummaries.filter((s) => (base === null ? !s.language : languageMatches(s.language, base)));
  const [result, setResult] = useState<(RuleBlend & { keep: boolean[] }) | null>(null);
  const [error, setError] = useState('');
  const chosen = picked.filter((id) => candidates.some((c) => c.id === id));

  async function blend() {
    setError('');
    try {
      const sets: RuleSet[] = await Promise.all(chosen.map((id) => backend.rules.get(id)));
      const r = blendRuleSets(sets, name, ruleSummaries.map((s) => s.id));
      setResult({ ...r, keep: r.overlaps.map(() => false) });
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function save() {
    if (!result) return;
    const extra = result.overlaps.filter((_, i) => result.keep[i]).map((o) => {
      const { from, ...r } = o.dropped;
      return { ...r, source: r.source ?? from, id: `${r.id}-${from.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60) };
    });
    const saved = await backend.rules.save({ ...result.set, name, rules: [...result.set.rules, ...extra] }, 'blend');
    await app.refreshRules();
    app.go('rules', saved.id);
  }

  return (
    <div className="pane">
      <div className="pane-inner">
        <div className="row">
          <h1 className="grow">Blend</h1>
          {toggle}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Combine rule sets into one, for example a journal's author guide with your supervisor's rules. Rules are requirements, so there are no weights: each rule is taken once, and rules that say the same thing as one from an earlier set are listed so you can keep both.
        </p>
        <div className="row">
          <span className="small muted">Rule sets in</span>
          <div className="seg">
            {bases.map((b) => (
              <button key={b ?? 'any'} className={b === base ? 'on' : ''} onClick={() => { setBase(b); setResult(null); }}>{baseLabel(b)}</button>
            ))}
          </div>
        </div>
        <div className="section">
          {candidates.map((s) => (
            <label className="inline" key={s.id}>
              <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => { setResult(null); setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id)); }} />
              {s.name} <span className="small muted">{plural(s.rules, 'rule')}</span>
            </label>
          ))}
          {!candidates.length && <div className="muted small">No rule sets in this language.</div>}
          {chosen.length > 1 && <div className="small muted">Order: {chosen.map((id) => candidates.find((c) => c.id === id)!.name).join(', ')}. Where rules repeat, the earlier set's wording is kept.</div>}
        </div>
        <div className="row">
          <label className="field" style={{ width: 260 }}>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={chosen.length < 2} onClick={() => void blend()}>Blend</button>
          {error && <span className="error" style={{ alignSelf: 'flex-end' }}>{error}</span>}
        </div>
        {result && (
          <div className="section">
            <div className="row">
              <h2 className="grow">{plural(result.set.rules.length + result.keep.filter(Boolean).length, 'rule')}, {plural(result.overlaps.length, 'repeat')}</h2>
              <button className="btn primary" onClick={() => void save()}>Save combined rule set</button>
            </div>
            {result.overlaps.map((o, i) => (
              <div className="diff-entry" key={i}>
                <input type="checkbox" checked={result.keep[i]} onChange={(e) => setResult({ ...result, keep: result.keep.map((x, k) => (k === i ? e.target.checked : x)) })} />
                <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span><b>{o.dropped.title}</b> <span className="muted">({o.dropped.from})</span> repeats <b>{o.kept.title}</b> <span className="muted">({o.kept.from})</span></span>
                  <span className="small">{o.dropped.description}</span>
                  <span className="small muted">Tick to keep both.</span>
                </div>
              </div>
            ))}
            {!result.overlaps.length && <div className="muted small">No rule repeats another.</div>}
            <div className="small muted">After saving, the set opens on the Rules page, where every rule can be edited and the set switched on.</div>
          </div>
        )}
      </div>
    </div>
  );
}
