import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@shared/api';
import { baseLabel, baseLanguage, LANGUAGES, languageLabel } from '@shared/language';
import type { ProfileSummary } from '@shared/api';
import type { ExcerptPolicy } from '@shared/profile/exchange';
import { newMove, newProfile } from '@shared/profile/model';
import type { Example, HintLevel, StyleMove, TasteProfile } from '@shared/types';
import { errorText, plural, useApp, useUnsavedGuard } from '../state';

const HINT_LABELS: Record<HintLevel, string> = {
  3: 'Specific hint',
  2: 'General hint',
  1: 'Underline only',
  0: 'Silent (learned)',
};

export function ProfilesView() {
  const app = useApp();
  const { backend, summaries } = app;
  const [activeId, setActiveId] = useState<string | null>(app.viewArg ?? summaries[0]?.id ?? null);
  const [draft, setDraft] = useState<TasteProfile | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!activeId && summaries[0]) setActiveId(summaries[0].id);
  }, [summaries, activeId]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    if (!activeId) return setDraft(null);
    backend.profiles.get(activeId).then(
      (p) => {
        if (cancelled) return;
        setDraft(p);
        setSaved(JSON.stringify(p));
      },
      (e) => setError(errorText(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [activeId, backend]);

  const dirty = draft && JSON.stringify(draft) !== saved;

  async function save(reason = 'edit') {
    if (!draft) return;
    try {
      const p = await backend.profiles.save(draft, reason);
      setDraft(p);
      setSaved(JSON.stringify(p));
      app.profileChanged(p);
      await app.refreshProfiles();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  const confirmLeave = useUnsavedGuard('profile', 'profiles', !!dirty, `Save changes to ${draft?.name ?? 'the profile'}?`, () => save());
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => app.registerCommands({ w: () => void saveRef.current() }, 'profiles'), [app.registerCommands]);

  async function create(kind: TasteProfile['kind']) {
    const p = newProfile(kind === 'project' ? 'New project profile' : 'New profile', kind, summaries.map((s) => s.id));
    await backend.profiles.save(p, 'create');
    await app.refreshProfiles();
    setActiveId(p.id);
  }

  async function importOne() {
    try {
      const p = await backend.profiles.importFrom();
      if (p) {
        await app.refreshProfiles();
        setActiveId(p.id);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="split">
      <div className="list">
        <div className="head">
          <button className="btn small" onClick={() => void create('general')}>New</button>
          <button className="btn small" onClick={() => void create('project')}>New project</button>
          <button className="btn ghost small" onClick={() => void importOne()}>Import</button>
          {!app.mock && <button className="btn ghost small" onClick={() => void backend.profiles.reveal()}>Open folder</button>}
        </div>
        {groupByLanguage(summaries).map(([base, items]) => (
          <div key={base ?? 'any'}>
            <div className="group">{baseLabel(base)}</div>
            {items.map((s) => (
              <div
                key={s.id}
                tabIndex={0}
                data-activate
                className={`item${s.id === activeId ? ' active' : ''}`}
                onClick={() => void confirmLeave().then((ok) => ok && setActiveId(s.id))}
              >
                <div className="name">{s.name}</div>
                <div className="row small muted">
                  <span className="tag">{s.kind}</span>
                  {plural(s.moves, 'move')}
                  {(app.activeGeneralId === s.id || app.settings.activeProjectProfile === s.id) && <span className="tag on">active</span>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {!summaries.length && <div className="empty">No profiles yet. Extract one from authors you like, or start from scratch.</div>}
      </div>
      <div className="pane">
        {error && <div className="notice error">{error}</div>}
        {draft ? (
          <ProfileEditor
            key={draft.id}
            draft={draft}
            setDraft={setDraft}
            dirty={!!dirty}
            onSave={() => void save()}
            onRevert={() => setDraft(JSON.parse(saved))}
            onDeleted={async () => {
              setActiveId(null);
              await app.refreshProfiles();
            }}
            onRolledBack={(p) => {
              setDraft(p);
              setSaved(JSON.stringify(p));
              app.profileChanged(p);
            }}
          />
        ) : (
          <div className="empty">Select a profile.</div>
        )}
      </div>
    </div>
  );
}

function ProfileEditor({ draft, setDraft, dirty, onSave, onRevert, onDeleted, onRolledBack }: {
  draft: TasteProfile;
  setDraft(p: TasteProfile): void;
  dirty: boolean;
  onSave(): void;
  onRevert(): void;
  onDeleted(): Promise<void>;
  onRolledBack(p: TasteProfile): void;
}) {
  const app = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [panel, setPanel] = useState<'moves' | 'history' | 'export'>('moves');
  const set = (patch: Partial<TasteProfile>) => setDraft({ ...draft, ...patch });
  const setMove = (id: string, patch: Partial<StyleMove>) => set({ moves: draft.moves.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const usedFor = baseLanguage(draft.language);
  const active =
    app.settings.activeProjectProfile === draft.id ||
    (usedFor ? app.settings.generalByLanguage[usedFor] === draft.id : app.settings.activeGeneralProfile === draft.id);

  const activate = () =>
    void (draft.kind === 'project' ? app.updateSettings({ activeProjectProfile: draft.id }) : app.setActiveGeneral(draft.id, draft.language ?? 'auto'));

  return (
    <div className="pane-inner">
      <div className="row">
        <h1 className="grow">{draft.name || 'Untitled'}</h1>
        {!active && <button className="btn" onClick={activate}>Use for writing</button>}
        <button className="btn" disabled={!dirty} onClick={onRevert}>Revert</button>
        <button className="btn primary" disabled={!dirty} onClick={onSave}>Save</button>
      </div>

      <div className="grid3">
        <label className="field">Name<input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="field">
          Kind
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as TasteProfile['kind'] })}>
            <option value="general">general (all writing)</option>
            <option value="project">project (overrides general)</option>
          </select>
        </label>
        <label className="field">
          {draft.kind === 'project' ? 'Document language' : 'Language this profile applies to'}
          <select value={draft.language ?? ''} onChange={(e) => set({ language: e.target.value || undefined })}>
            <option value="">{draft.kind === 'project' ? `Default (${languageLabel(app.settings.grammar.language)})` : 'Any language'}</option>
            {LANGUAGES.filter(([c]) => c !== 'auto').map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="small muted">File: {draft.id}.md</div>
      <label className="field">Description<textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} /></label>
      {draft.sources.length > 0 && (
        <div className="small muted">Sources: {draft.sources.map((s) => (s.author ? `${s.title} (${s.author})` : s.title)).join('; ')}</div>
      )}
      {draft.metrics && <Metrics m={draft.metrics} />}

      <div className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
        <div className="seg">
          <button className={panel === 'moves' ? 'on' : ''} onClick={() => setPanel('moves')}>Moves ({draft.moves.length})</button>
          <button className={panel === 'history' ? 'on' : ''} onClick={() => setPanel('history')}>History</button>
          <button className={panel === 'export' ? 'on' : ''} onClick={() => setPanel('export')}>Export</button>
        </div>
        <span className="grow" />
        <button className="btn ghost small" onClick={() => app.go('extract', draft.id)}>Re-extract from sources</button>
        <button
          className="btn ghost small danger"
          onClick={async () => {
            if (!confirm(`Delete "${draft.name}"? A snapshot is kept in the history folder.`)) return;
            await app.backend.profiles.remove(draft.id);
            await onDeleted();
          }}
        >
          Delete
        </button>
      </div>

      {panel === 'moves' && (
        <>
          {draft.moves.map((m) => (
            <MoveEditor key={m.id} m={m} open={open === m.id} toggle={() => setOpen(open === m.id ? null : m.id)} set={(p) => setMove(m.id, p)} remove={() => set({ moves: draft.moves.filter((x) => x.id !== m.id) })} />
          ))}
          <div>
            <button
              className="btn"
              onClick={() => {
                const m = newMove({ title: 'New move', origin: 'manual' }, draft.moves.map((x) => x.id));
                set({ moves: [...draft.moves, m] });
                setOpen(m.id);
              }}
            >
              Add a move by hand
            </button>
          </div>
        </>
      )}
      {panel === 'history' && <History id={draft.id} dirty={dirty} onRolledBack={onRolledBack} />}
      {panel === 'export' && <Export id={draft.id} dirty={dirty} />}
    </div>
  );
}

function Metrics({ m }: { m: NonNullable<TasteProfile['metrics']> }) {
  const cells: [string, string][] = [
    ['sentence length', `${m.sentenceLengthMean} ± ${m.sentenceLengthStd}`],
    ['paragraph length', `${m.paragraphLengthMean}`],
    ['hedges / 100 words', `${m.hedgeRate}`],
    ['passive sentences', `${Math.round(m.passiveRate * 100)} %`],
    ['questions', `${Math.round(m.questionRate * 100)} %`],
    ['first person / 100 words', `${m.firstPersonRate}`],
    ['type/token', `${m.typeTokenRatio}`],
    ['words measured', `${m.words.toLocaleString()}`],
  ];
  return (
    <div className="metrics">
      {cells.map(([k, v]) => (
        <div key={k}><div className="v">{v}</div><div className="k">{k}</div></div>
      ))}
    </div>
  );
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function MoveEditor({ m, open, toggle, set, remove }: { m: StyleMove; open: boolean; toggle(): void; set(p: Partial<StyleMove>): void; remove(): void }) {
  const setExample = (i: number, patch: Partial<Example>) => set({ examples: m.examples.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const scopeLabel = [...m.scope.docTypes, ...m.scope.sections].join(', ');
  return (
    <div className={`move${m.enabled ? '' : ' disabled'}`}>
      <div className="move-head" onClick={toggle} tabIndex={0} data-activate>
        <input type="checkbox" checked={m.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => set({ enabled: e.target.checked })} title="Enabled" />
        <span className="title">{m.title}</span>
        {m.locked && <span className="tag on">locked</span>}
        {scopeLabel && <span className="tag">{scopeLabel}</span>}
        <span className="tag">{m.origin}</span>
        <span className="small muted" title="Accepted / rejected / landed revisions">{m.stats.accepted}/{m.stats.rejected}/{m.stats.landed}</span>
        <span className="w" title={`weight ${m.weight}`}><i style={{ width: `${m.weight * 100}%` }} /></span>
      </div>
      {open && (
        <div className="move-body">
          <div className="grid2">
            <label className="field">Title<input type="text" value={m.title} onChange={(e) => set({ title: e.target.value })} /></label>
            <label className="field">
              Weight {m.weight.toFixed(2)}
              <input type="range" min={0} max={1} step={0.05} value={m.weight} onChange={(e) => set({ weight: Number(e.target.value) })} />
            </label>
          </div>
          <label className="field">What the writer does<textarea rows={3} value={m.description} onChange={(e) => set({ description: e.target.value })} /></label>
          <label className="field">Why it works<textarea rows={2} value={m.rationale} onChange={(e) => set({ rationale: e.target.value })} /></label>
          <div className="grid3">
            <label className="field">Document types (empty = all)<input type="text" defaultValue={m.scope.docTypes.join(', ')} placeholder="paper, blog" onBlur={(e) => set({ scope: { ...m.scope, docTypes: list(e.target.value) } })} /></label>
            <label className="field">Sections (empty = all)<input type="text" defaultValue={m.scope.sections.join(', ')} placeholder="introduction, abstract" onBlur={(e) => set({ scope: { ...m.scope, sections: list(e.target.value) } })} /></label>
            <label className="field">
              Teacher-mode hints
              <select value={m.hintLevel} onChange={(e) => set({ hintLevel: Number(e.target.value) as HintLevel })}>
                {([3, 2, 1, 0] as HintLevel[]).map((h) => <option key={h} value={h}>{HINT_LABELS[h]}</option>)}
              </select>
            </label>
          </div>
          <label className="inline small">
            <input type="checkbox" checked={m.locked} onChange={(e) => set({ locked: e.target.checked })} />
            Lock: never change this move automatically (accepts, rejects, revisions, re-extraction)
          </label>

          <div className="field">
            <span>Examples</span>
            {m.examples.map((ex, i) => (
              <div className="example" key={i}>
                <textarea rows={2} value={ex.text} onChange={(e) => setExample(i, { text: e.target.value })} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <select value={ex.kind} onChange={(e) => setExample(i, { kind: e.target.value as Example['kind'] })}>
                    <option value="author">author excerpt</option>
                    <option value="user">my own</option>
                  </select>
                  {ex.kind === 'author' && <input className="src" type="text" placeholder="source" value={ex.source ?? ''} onChange={(e) => setExample(i, { source: e.target.value || undefined })} />}
                  <button className="btn ghost small" onClick={() => set({ examples: m.examples.filter((_, k) => k !== i) })}>Remove</button>
                </div>
              </div>
            ))}
            <div><button className="btn small" onClick={() => set({ examples: [...m.examples, { text: '', kind: 'user' }] })}>Add example</button></div>
          </div>

          <div className="field">
            <span>Notes (from rejections, or your own)</span>
            {m.notes.map((n, i) => (
              <div className="row" key={i}>
                <input type="text" className="grow" value={n} onChange={(e) => set({ notes: m.notes.map((x, k) => (k === i ? e.target.value : x)) })} />
                <button className="btn ghost small" onClick={() => set({ notes: m.notes.filter((_, k) => k !== i) })}>Remove</button>
              </div>
            ))}
            <div><button className="btn small" onClick={() => set({ notes: [...m.notes, ''] })}>Add note</button></div>
          </div>

          <div className="row">
            <span className="small muted">id: {m.id}</span>
            <span className="grow" />
            <button className="btn ghost small" onClick={() => set({ stats: { accepted: 0, rejected: 0, landed: 0, missed: 0, streak: 0 }, hintLevel: 3 })}>Reset stats and hints</button>
            <button className="btn ghost small danger" onClick={remove}>Delete move</button>
          </div>
        </div>
      )}
    </div>
  );
}

function History({ id, dirty, onRolledBack }: { id: string; dirty: boolean; onRolledBack(p: TasteProfile): void }) {
  const { backend } = useApp();
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [preview, setPreview] = useState<{ snap: Snapshot; p: TasteProfile } | null>(null);
  useEffect(() => {
    void backend.profiles.history(id).then(setSnaps);
  }, [backend, id]);
  if (!snaps.length) return <div className="muted">No earlier versions yet. Every save, including automatic updates, keeps a snapshot here.</div>;
  return (
    <div>
      {dirty && <div className="notice">You have unsaved changes; rolling back discards them.</div>}
      {snaps.map((s) => (
        <div className="snapshot" key={s.id}>
          <span style={{ width: 150 }}>{new Date(s.at).toLocaleString()}</span>
          <span className="grow muted">saved {s.reason}</span>
          <button className="btn ghost small" onClick={async () => setPreview({ snap: s, p: await backend.profiles.readSnapshot(id, s.id) })}>Preview</button>
          <button
            className="btn small"
            onClick={async () => {
              const p = await backend.profiles.rollback(id, s.id);
              onRolledBack(p);
              setSnaps(await backend.profiles.history(id));
            }}
          >
            Roll back
          </button>
        </div>
      ))}
      {preview && (
        <div className="section">
          <h2>Version from {new Date(preview.snap.at).toLocaleString()}</h2>
          {preview.p.moves.map((m) => (
            <div key={m.id} className="small">
              <b>{m.title}</b> <span className="muted">weight {m.weight.toFixed(2)}{m.enabled ? '' : ', off'}</span>
              <div className="muted">{m.description}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Export({ id, dirty }: { id: string; dirty: boolean }) {
  const { backend, notify } = useApp();
  const [policy, setPolicy] = useState<ExcerptPolicy>('short');
  const go = async (format: 'md' | 'zip') => {
    try {
      const path = await backend.profiles.exportTo(id, format, policy);
      if (path) notify(`Exported to ${path}`);
    } catch (e) {
      notify(errorText(e));
    }
  };
  return (
    <div className="pane-inner" style={{ gap: 12 }}>
      {dirty && <div className="notice">Export uses the saved version. Save first to include your changes.</div>}
      <div className="field">
        <span>Author excerpts</span>
        {(
          [
            ['all', 'Keep all excerpts (fine for your own use)'],
            ['short', 'Keep only short excerpts (25 words or fewer), for sharing'],
            ['none', 'Drop author excerpts; move descriptions carry the profile'],
          ] as [ExcerptPolicy, string][]
        ).map(([v, label]) => (
          <label className="inline" key={v} style={{ color: 'var(--ink)', fontSize: 14 }}>
            <input type="radio" name="policy" checked={policy === v} onChange={() => setPolicy(v)} /> {label}
          </label>
        ))}
        <span className="small muted">Your own example sentences are always included.</span>
      </div>
      <div className="row">
        <button className="btn" onClick={() => void go('md')}>Export as Markdown</button>
        <button className="btn" onClick={() => void go('zip')}>Export as bundle (.zip)</button>
      </div>
    </div>
  );
}

/** Profiles grouped by base language; "any language" last. */
function groupByLanguage(list: ProfileSummary[]): [string | null, ProfileSummary[]][] {
  const groups = new Map<string | null, ProfileSummary[]>();
  for (const s of list) {
    const b = baseLanguage(s.language);
    groups.set(b, [...(groups.get(b) ?? []), s]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : baseLabel(a).localeCompare(baseLabel(b))));
}
