import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DOC_TYPES, parseDocument, serializeDocument, type DocBlock } from '@shared/document';
import { hintFor } from '@shared/profile/feedback';
import type { Category, Mode } from '@shared/types';
import { Checker, type Entry, type FeedbackEntry, type StyleEntry } from '../editor/checker';
import { blocks, IssuesExtension } from '../editor/issues';
import { SAMPLE_DOCUMENT } from '../sample';
import { errorText, useApp } from '../state';

function toContent(text: string) {
  return {
    type: 'doc',
    content: parseDocument(text).map((b) =>
      b.type === 'heading'
        ? { type: 'heading', attrs: { level: Math.min(b.level, 6) }, content: b.text ? [{ type: 'text', text: b.text }] : [] }
        : {
            type: 'paragraph',
            content: b.text.split('\n').flatMap((line, i) => [
              ...(i > 0 ? [{ type: 'hardBreak' }] : []),
              ...(line ? [{ type: 'text', text: line }] : []),
            ]),
          },
    ),
  };
}

const CATEGORY_LABEL: Record<Category, string> = { spelling: 'Spelling', grammar: 'Grammar', style: 'Style' };

export function WriteView() {
  const app = useApp();
  const { backend, settings, general, project, mock } = app;
  const [doc, setDoc] = useState<{ path: string | null; name: string }>({ path: null, name: 'untitled.md' });
  const [dirty, setDirty] = useState(false);
  const [docType, setDocType] = useState('paper');
  const [filters, setFilters] = useState<Record<Category, boolean>>({ spelling: true, grammar: true, style: true });
  const [selected, setSelected] = useState<string | null>(null);

  // Live values for the checker without re-creating it.
  const live = useRef({ settings, general, project, docType, profileChanged: app.profileChanged });
  live.current = { settings, general, project, docType, profileChanged: app.profileChanged };

  const checkerRef = useRef<Checker | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bold: false, italic: false, strike: false, code: false, codeBlock: false, blockquote: false,
        bulletList: false, orderedList: false, listItem: false, listKeymap: false, horizontalRule: false,
        link: false, underline: false,
      }),
      IssuesExtension((id) => {
        setSelected(id);
        checkerRef.current?.select(id);
        if (id) document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }),
    ],
    content: toContent(mock ? SAMPLE_DOCUMENT : ''),
    onUpdate: () => setDirty(true),
  });

  const checker = useMemo(() => {
    if (!editor) return null;
    const c = new Checker(editor, {
      backend,
      settings: () => live.current.settings,
      profiles: () => ({ general: live.current.general, project: live.current.project }),
      docType: () => live.current.docType,
      onProfile: (p) => live.current.profileChanged(p),
    });
    checkerRef.current = c;
    c.schedule(true);
    return c;
  }, [editor, backend]);
  useEffect(() => () => checker?.destroy(), [checker]);

  // Re-render on checker changes.
  const version = useSyncExternalStore(
    (fn) => checker?.subscribe(fn) ?? (() => {}),
    () => (checker ? `${checker.entries.size}:${checker.feedback.length}:${checker.grammarPhase}:${checker.stylePhase}:${checker.message}:${[...checker.entries.values()].map((e) => (e.kind === 'style' ? e.status : '')).join('')}` : ''),
  );

  // Context changes that invalidate style results.
  const profileKey = `${general?.id}:${general?.moves.map((m) => m.id + m.description + m.enabled + m.scope.docTypes + m.scope.sections).join()}|${project?.id}:${project?.moves.map((m) => m.id + m.description + m.enabled).join()}`;
  useEffect(() => checker?.invalidate('style'), [checker, profileKey, docType]);
  useEffect(() => checker?.invalidate('grammar'), [checker, settings.grammar.engine, settings.grammar.language, settings.grammar.harperDialect, settings.dictionary.length]);
  useEffect(() => checker?.setMode(settings.mode), [checker, settings.mode]);

  const ordered = useMemo(() => {
    if (!checker) return [];
    return [...checker.entries.values()]
      .map((e) => ({ e, r: checker.range(e.id) }))
      .filter((x) => x.r && !(settings.mode === 'teacher' && x.e.kind === 'style' && x.e.move.hintLevel === 0))
      .sort((a, b) => a.r!.from - b.r!.from)
      .map((x) => x.e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checker, version, settings.mode]);

  const counts = { spelling: 0, grammar: 0, style: 0 } as Record<Category, number>;
  for (const e of ordered) counts[e.category]++;
  const visible = ordered.filter((e) => filters[e.category]);

  async function open() {
    try {
      const d = await backend.files.openDocument();
      if (!d || !editor) return;
      editor.commands.setContent(toContent(d.text), { emitUpdate: false });
      setDoc({ path: d.path, name: d.name });
      setDirty(false);
      if (/\.tex$/.test(d.name)) setDocType('paper');
      checker?.reset();
    } catch (e) {
      app.notify(errorText(e));
    }
  }

  async function save() {
    if (!editor) return;
    const text = serializeDocument(
      blocks(editor.state.doc).map((b): DocBlock => (b.type === 'heading' ? { type: 'heading', level: b.level, text: b.text } : { type: 'paragraph', text: b.text })),
    );
    try {
      const path = await backend.files.saveDocument(doc.path, text);
      if (path) {
        setDoc({ path, name: path.replace(/^.*[\\/]/, '') });
        setDirty(false);
      }
    } catch (e) {
      app.notify(errorText(e));
    }
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
        ev.preventDefault();
        void save();
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'o') {
        ev.preventDefault();
        void open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setMode = (mode: Mode) => void app.updateSettings({ mode });
  const busy = checker && (checker.grammarPhase === 'busy' || checker.stylePhase === 'busy');
  const err = checker && (checker.grammarPhase === 'error' || checker.stylePhase === 'error' || !!checker.message);
  const projects = app.summaries.filter((s) => s.kind === 'project');
  const generals = app.summaries.filter((s) => s.kind === 'general');

  return (
    <>
      <div className="topbar">
        <span className={`docname${dirty ? ' dirty' : ''}`} title={doc.path ?? ''}>{doc.name}</span>
        <button className="btn ghost small" onClick={open}>Open</button>
        <button className="btn ghost small" onClick={save}>Save</button>
        <span className="muted">|</span>
        <select value={docType} onChange={(e) => setDocType(e.target.value)} title="Document type, used for move scopes">
          {DOC_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select
          value={settings.activeGeneralProfile ?? ''}
          onChange={(e) => void app.updateSettings({ activeGeneralProfile: e.target.value || null })}
          title="General taste profile"
        >
          <option value="">No general profile</option>
          {generals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          value={settings.activeProjectProfile ?? ''}
          onChange={(e) => void app.updateSettings({ activeProjectProfile: e.target.value || null })}
          title="Project taste profile (overrides general moves with the same id)"
        >
          <option value="">No project profile</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="seg" role="tablist">
          <button className={settings.mode === 'assistant' ? 'on' : ''} onClick={() => setMode('assistant')}>Assistant</button>
          <button className={settings.mode === 'teacher' ? 'on' : ''} onClick={() => setMode('teacher')}>Teacher</button>
        </div>
        <span className="status">
          <span className={`dot ${err ? 'err' : busy ? 'busy' : 'ok'}`} />
          {err ? <span className="error" title={checker?.message}>{checker?.message.slice(0, 80)}</span> : busy ? (checker?.stylePhase === 'busy' ? 'Checking style' : 'Checking') : 'Up to date'}
        </span>
      </div>
      <div className="write">
        <div className="page-scroll">
          <div className={`page ${settings.mode}`}>
            <EditorContent editor={editor} />
          </div>
        </div>
        <aside className="side">
          <div className="side-head">
            <div className="chips">
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <button key={c} className={`chip${filters[c] ? '' : ' off'}`} onClick={() => setFilters({ ...filters, [c]: !filters[c] })}>
                  <span className="sw" style={{ background: `var(--${c})` }} />
                  {CATEGORY_LABEL[c]} <span className="n">{counts[c]}</span>
                </button>
              ))}
            </div>
            {settings.mode === 'teacher' && (
              <div className="small muted">Style issues show a hint only. Revise the passage; feedback comes when you leave the paragraph.</div>
            )}
            {!general && !project && (
              <div className="small muted">
                No taste profile selected, so only spelling and grammar are checked.{' '}
                <a href="#" onClick={(e) => (e.preventDefault(), app.go('extract'))}>Extract one</a>
              </div>
            )}
          </div>
          <div className="cards">
            {checker?.feedback.map((f) => <FeedbackCard key={f.id} f={f} onClose={() => checker.closeFeedback(f.id)} />)}
            {visible.map((e) => (
              <SuggestionCard
                key={e.id}
                e={e}
                mode={settings.mode}
                selected={selected === e.id}
                checker={checker!}
                onSelect={() => {
                  setSelected(e.id);
                  checker?.select(e.id, true);
                }}
                onAddWord={(w) => void app.updateSettings({ dictionary: [...settings.dictionary, w] })}
              />
            ))}
            {!visible.length && !checker?.feedback.length && <div className="empty">{busy ? 'Checking…' : 'Nothing to flag here.'}</div>}
          </div>
        </aside>
      </div>
    </>
  );
}

function SuggestionCard({ e, mode, selected, checker, onSelect, onAddWord }: {
  e: Entry; mode: Mode; selected: boolean; checker: Checker; onSelect(): void; onAddWord(w: string): void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const stop = (fn: () => void) => (ev: React.MouseEvent) => {
    ev.stopPropagation();
    fn();
  };

  if (e.kind === 'grammar') {
    const i = e.issue;
    return (
      <div id={`card-${e.id}`} className={`card ${e.category}${selected ? ' selected' : ''}`} onClick={onSelect}>
        <div className="kind">{CATEGORY_LABEL[e.category]}</div>
        <div className="quote">{i.text}</div>
        <div className="msg">{i.message}</div>
        <div className="actions">
          {i.replacements.slice(0, 4).map((r, k) => (
            <button key={k} className="repl" onClick={stop(() => checker.applyReplacement(e.id, r))}>{r || <em className="muted">delete</em>}</button>
          ))}
          <span className="grow" />
          {e.category === 'spelling' && <button className="btn ghost small" onClick={stop(() => onAddWord(i.text))}>Add word</button>}
          <button className="btn ghost small" onClick={stop(() => checker.dismiss(e.id))}>Ignore</button>
        </div>
      </div>
    );
  }

  const s = e.s;
  const hint = hintFor(e.move.hintLevel, s.hints, e.move.title);
  return (
    <div id={`card-${e.id}`} className={`card style${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="kind">Style <span>·</span> <span style={{ textTransform: 'none', letterSpacing: 0 }}>{e.move.title}</span></div>
      {mode === 'assistant' ? (
        <>
          <div className="msg">{s.issue}</div>
          <div className="quote"><del>{s.quote}</del>{' '}{s.rewrite ? <ins>{s.rewrite}</ins> : <em className="muted">(remove)</em>}</div>
          {s.explanation && <div className="why">{s.explanation}</div>}
          {rejecting ? (
            <RejectBox reason={reason} setReason={setReason} onCancel={() => setRejecting(false)} onConfirm={() => void checker.reject(e.id, reason)} />
          ) : (
            <div className="actions" onClick={(ev) => ev.stopPropagation()}>
              <button className="btn primary small" onClick={() => void checker.accept(e.id)}>Accept</button>
              <button className="btn small" onClick={() => checker.dismiss(e.id)}>Dismiss</button>
              <button className="btn ghost small" onClick={() => setRejecting(true)} title="Tell the profile this move does not fit here">Not for me</button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="hint">{hint}</div>
          {e.status === 'open' && <div className="small muted">Revise the underlined passage in the editor.</div>}
          {rejecting ? (
            <RejectBox reason={reason} setReason={setReason} onCancel={() => setRejecting(false)} onConfirm={() => void checker.reject(e.id, reason)} />
          ) : (
            <div className="actions" onClick={(ev) => ev.stopPropagation()}>
              <button className="btn primary small" disabled={e.status !== 'revising'} onClick={() => void checker.requestFeedback(e.id)}>
                {e.status === 'checking' ? 'Checking…' : 'Check my revision'}
              </button>
              <button className="btn small" onClick={() => checker.dismiss(e.id)}>Skip</button>
              <button className="btn ghost small" onClick={() => setRejecting(true)}>Not for me</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RejectBox({ reason, setReason, onCancel, onConfirm }: { reason: string; setReason(s: string): void; onCancel(): void; onConfirm(): void }) {
  return (
    <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch' }} onClick={(e) => e.stopPropagation()}>
      <input type="text" autoFocus placeholder="Why not? (optional, saved as a note on the move)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onConfirm()} />
      <div className="row">
        <button className="btn small" onClick={onConfirm}>Save to profile</button>
        <button className="btn ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function FeedbackCard({ f, onClose }: { f: FeedbackEntry; onClose(): void }) {
  const labels = { landed: 'Landed', partly: 'Partly there', overcorrected: 'Overcorrected', missed: 'Missed' } as const;
  return (
    <div className="card feedback">
      <div className="kind">Feedback <span>·</span> <span style={{ textTransform: 'none', letterSpacing: 0 }}>{f.move.title}</span></div>
      <div><span className={`verdict ${f.feedback.verdict}`}>{labels[f.feedback.verdict]}</span></div>
      <div className="quote"><del>{f.original}</del> <ins>{f.revised}</ins></div>
      <div className="msg">{f.feedback.feedback}</div>
      {f.feedback.exemplary && f.feedback.verdict === 'landed' && <div className="small muted">Kept as an example of this move in your profile.</div>}
      <div className="actions"><button className="btn ghost small" onClick={onClose}>Done</button></div>
    </div>
  );
}

export type { StyleEntry };
