import { useEffect, useState } from 'react';
import { baseLabel, baseLanguage, LANGUAGES } from '@shared/language';
import { mergeRules, newRule, newRuleSet, type RuleSet, type WritingRule } from '@shared/rules';
import type { SourceDoc } from '@shared/types';
import { errorText, plural, useApp } from '../state';

export function RulesView() {
  const app = useApp();
  const { backend } = app;
  const [activeId, setActiveId] = useState<string | null>(app.ruleSummaries[0]?.id ?? null);
  const [draft, setDraft] = useState<RuleSet | null>(null);
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!activeId && app.ruleSummaries[0]) setActiveId(app.ruleSummaries[0].id);
  }, [app.ruleSummaries, activeId]);

  useEffect(() => {
    if (!activeId) return setDraft(null);
    void backend.rules.get(activeId).then(
      (s) => {
        setDraft(s);
        setSaved(JSON.stringify(s));
      },
      (e) => setError(errorText(e)),
    );
  }, [activeId, backend]);

  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const set = (patch: Partial<RuleSet>) => draft && setDraft({ ...draft, ...patch });
  const setRule = (id: string, patch: Partial<WritingRule>) => draft && set({ rules: draft.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  async function save(next = draft, reason = 'edit') {
    if (!next) return;
    try {
      const s = await backend.rules.save(next, reason);
      setDraft(s);
      setSaved(JSON.stringify(s));
      app.ruleSetChanged(s);
      await app.refreshRules();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function create() {
    const s = newRuleSet('New rules', app.ruleSummaries.map((r) => r.id));
    if (app.language !== 'auto') s.language = app.language;
    await backend.rules.save(s, 'create');
    await app.refreshRules();
    setActiveId(s.id);
  }

  const groups = new Map<string | null, typeof app.ruleSummaries>();
  for (const r of app.ruleSummaries) {
    const b = baseLanguage(r.language);
    groups.set(b, [...(groups.get(b) ?? []), r]);
  }

  return (
    <div className="split">
      <div className="list">
        <div className="head">
          <button className="btn small" onClick={() => void create()}>New rule set</button>
          <button
            className="btn ghost small"
            onClick={async () => {
              const s = await backend.rules.importFrom().catch((e) => (setError(errorText(e)), null));
              if (s) {
                await app.refreshRules();
                setActiveId(s.id);
              }
            }}
          >
            Import
          </button>
        </div>
        {[...groups.entries()].map(([b, items]) => (
          <div key={b ?? 'any'}>
            <div className="group">{baseLabel(b)}</div>
            {items.map((r) => (
              <div
                key={r.id}
                tabIndex={0}
                data-activate
                className={`item${r.id === activeId ? ' active' : ''}`}
                onClick={() => (dirty && !confirm('Discard unsaved changes?') ? null : setActiveId(r.id))}
              >
                <div className="name">{r.name}</div>
                <div className="row small muted">
                  {plural(r.rules, 'rule')}
                  {app.activeRuleIds.includes(r.id) && <span className="tag on">on for this project</span>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {!app.ruleSummaries.length && <div className="empty">No rule sets yet. Write rules by hand or extract them from a style guide.</div>}
      </div>

      <div className="pane">
        {error && <div className="notice error">{error}</div>}
        {draft ? (
          <div className="pane-inner">
            <div className="row">
              <h1 className="grow">{draft.name || 'Untitled'}</h1>
              <button
                className="btn"
                onClick={() => {
                  const on = app.activeRuleIds.includes(draft.id);
                  void app.setActiveRules(on ? app.activeRuleIds.filter((x) => x !== draft.id) : [...app.activeRuleIds, draft.id]);
                }}
              >
                {app.activeRuleIds.includes(draft.id) ? 'Turn off for this project' : 'Use for this project'}
              </button>
              <button className="btn" disabled={!dirty} onClick={() => setDraft(JSON.parse(saved))}>Revert</button>
              <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Rules are requirements: every clear violation is flagged, in a separate colour from style. They are checked in the same request as style, and active per project
              {app.project ? ` (now: ${app.project.name})` : ' (now: no project profile)'}.
            </p>
            <div className="grid3">
              <label className="field">Name<input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} /></label>
              <label className="field">
                Language
                <select value={draft.language ?? ''} onChange={(e) => set({ language: e.target.value || undefined })}>
                  <option value="">Any language</option>
                  {LANGUAGES.filter(([c]) => c !== 'auto').map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                </select>
              </label>
              <label className="field">File<input type="text" readOnly value={`rules/${draft.id}.md`} /></label>
            </div>
            <label className="field">Description<textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} /></label>
            {draft.sources.length > 0 && <div className="small muted">Extracted from: {draft.sources.map((s) => s.title).join('; ')}</div>}

            <div className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <h2 className="grow">{plural(draft.rules.length, 'rule')}</h2>
              <button
                className="btn small"
                onClick={() => {
                  const r = newRule({ title: 'New rule' }, draft.rules.map((x) => x.id));
                  set({ rules: [...draft.rules, r] });
                  setOpen(r.id);
                }}
              >
                Add a rule by hand
              </button>
              <button className="btn ghost small" onClick={async () => { const p = await backend.rules.exportTo(draft.id); if (p) app.notify(`Exported to ${p}`); }}>Export</button>
              <button
                className="btn ghost small danger"
                onClick={async () => {
                  if (!confirm(`Delete "${draft.name}"? A copy stays in the history folder.`)) return;
                  await backend.rules.remove(draft.id);
                  setActiveId(null);
                  await app.refreshRules();
                }}
              >
                Delete
              </button>
            </div>

            {draft.rules.map((r) => (
              <RuleEditor key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} set={(p) => setRule(r.id, p)} remove={() => set({ rules: draft.rules.filter((x) => x.id !== r.id) })} />
            ))}

            <ExtractRules
              takenIds={draft.rules.map((r) => r.id)}
              onAdd={(rules, sources) => {
                const { set: merged, skipped } = mergeRules(draft, rules, sources);
                if (skipped.length) app.notify(`Skipped ${plural(skipped.length, 'duplicate')}: ${skipped.join(', ')}`);
                void save(merged, 'extraction');
              }}
            />
          </div>
        ) : (
          <div className="empty">Select or create a rule set.</div>
        )}
      </div>
    </div>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function RuleEditor({ r, open, toggle, set, remove }: { r: WritingRule; open: boolean; toggle(): void; set(p: Partial<WritingRule>): void; remove(): void }) {
  return (
    <div className={`move${r.enabled ? '' : ' disabled'}`}>
      <div className="move-head" onClick={toggle} tabIndex={0} data-activate>
        <input type="checkbox" checked={r.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => set({ enabled: e.target.checked })} title="Enabled" />
        <span className="title">{r.title}</span>
        {r.locked && <span className="tag on">locked</span>}
        {r.scope.sections.length > 0 && <span className="tag">{r.scope.sections.join(', ')}</span>}
        <span className="tag">{r.origin}</span>
        <span className="small muted" title="Accepted / rejected">{r.stats.accepted}/{r.stats.rejected}</span>
      </div>
      {open && (
        <div className="move-body">
          <label className="field">Title<input type="text" value={r.title} onChange={(e) => set({ title: e.target.value })} /></label>
          <label className="field">Rule<textarea rows={3} value={r.description} onChange={(e) => set({ description: e.target.value })} /></label>
          <div className="grid2">
            <label className="field">Do (one example per line)<textarea rows={3} defaultValue={r.good.join('\n')} onBlur={(e) => set({ good: lines(e.target.value) })} /></label>
            <label className="field">Don't (one example per line)<textarea rows={3} defaultValue={r.bad.join('\n')} onBlur={(e) => set({ bad: lines(e.target.value) })} /></label>
          </div>
          <div className="grid3">
            <label className="field">Document types (empty = all)<input type="text" defaultValue={r.scope.docTypes.join(', ')} onBlur={(e) => set({ scope: { ...r.scope, docTypes: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} /></label>
            <label className="field">Sections (empty = all)<input type="text" defaultValue={r.scope.sections.join(', ')} onBlur={(e) => set({ scope: { ...r.scope, sections: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} /></label>
            <label className="field">Source<input type="text" value={r.source ?? ''} onChange={(e) => set({ source: e.target.value || undefined })} /></label>
          </div>
          <label className="field">Notes (from "not for me", or your own; one per line)<textarea rows={2} defaultValue={r.notes.join('\n')} onBlur={(e) => set({ notes: lines(e.target.value) })} /></label>
          <div className="row">
            <label className="inline small"><input type="checkbox" checked={r.locked} onChange={(e) => set({ locked: e.target.checked })} /> Lock: never add notes or stats automatically</label>
            <span className="grow" />
            <button className="btn ghost small danger" onClick={remove}>Delete rule</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExtractRules({ takenIds, onAdd }: { takenIds: string[]; onAdd(rules: WritingRule[], sources: { title: string }[]): void }) {
  const { backend } = useApp();
  const [docs, setDocs] = useState<SourceDoc[]>([]);
  const [found, setFound] = useState<(WritingRule & { pick: boolean })[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="section">
      <div className="row">
        <h2 className="grow">Extract rules from documents</h2>
        <button className="btn small" onClick={async () => setDocs([...docs, ...(await backend.files.pickSources())])}>Add files</button>
        <button className="btn small" onClick={() => setDocs([...docs, { name: `Pasted document ${docs.length + 1}`, text: '' }])}>Paste text</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        For documents that state rules: a journal's author guide, a style guide, your supervisor's comments. Only rules the documents state are extracted, not their own style.
      </p>
      {docs.map((d, i) => (
        <div className="source" key={i}>
          <div className="row">
            <input type="text" className="grow" value={d.name} onChange={(e) => setDocs(docs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
            <button className="btn ghost small" onClick={() => setDocs(docs.filter((_, k) => k !== i))}>Remove</button>
          </div>
          <textarea rows={4} value={d.text} placeholder="Paste the rules document" onChange={(e) => setDocs(docs.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />
        </div>
      ))}
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || !docs.some((d) => d.text.trim())}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const rules = await backend.coach.extractRules(docs.filter((d) => d.text.trim()), takenIds);
              setFound(rules.map((r) => ({ ...r, pick: true })));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Extracting…' : 'Extract rules'}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
      {found && (
        <>
          {found.map((r, i) => (
            <div className="diff-entry" key={r.id}>
              <input type="checkbox" checked={r.pick} onChange={(e) => setFound(found.map((x, k) => (k === i ? { ...x, pick: e.target.checked } : x)))} />
              <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <b>{r.title}</b>
                <span className="small">{r.description}</span>
                {r.source && <span className="small muted">from {r.source}</span>}
              </div>
            </div>
          ))}
          <div className="row">
            <button
              className="btn primary"
              disabled={!found.some((r) => r.pick)}
              onClick={() => {
                onAdd(found.filter((r) => r.pick).map(({ pick: _p, ...r }) => r), docs.map((d) => ({ title: d.name })));
                setFound(null);
                setDocs([]);
              }}
            >
              Add {plural(found.filter((r) => r.pick).length, 'rule')}
            </button>
            <button className="btn ghost" onClick={() => setFound(null)}>Discard</button>
          </div>
        </>
      )}
    </div>
  );
}
