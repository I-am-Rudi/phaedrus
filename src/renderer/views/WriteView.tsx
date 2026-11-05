import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DOC_TYPES, parseDocumentFull, serializeDocument, type DocBlock } from '@shared/document';
import { baseLabel, baseLanguage, harperDialectFor, languageLabel, languageMatches } from '@shared/language';
import { hintFor } from '@shared/profile/feedback';
import type { Category, Mode } from '@shared/types';
import { Checker, type Entry, type FeedbackEntry, type StyleEntry } from '../editor/checker';
import { BlockSeparators, blocks, IssuesExtension, LatexHeadings } from '../editor/issues';
import { cycleView } from '../vim/app';
import { Vim, type IssueAction } from '../vim/editorVim';
import { SAMPLE_DOCUMENT } from '../sample';
import { errorText, useApp } from '../state';

/** Whitespace around the blocks of the open file, kept so it saves back unchanged. */
type Frame = { leading: string; trailing: string };

function toContent(text: string, name = '') {
  const parsed = parseDocumentFull(text, name);
  const doc = {
    type: 'doc',
    content: parsed.blocks.map((b) =>
      b.type === 'heading'
        ? { type: 'heading', attrs: { level: Math.min(b.level, 6), sep: b.sep ?? null }, content: b.text ? [{ type: 'text', text: b.text }] : [] }
        : {
            type: 'paragraph',
            attrs: { sep: b.sep ?? null },
            content: b.text.split('\n').flatMap((line, i) => [
              ...(i > 0 ? [{ type: 'hardBreak' }] : []),
              ...(line ? [{ type: 'text', text: line }] : []),
            ]),
          },
    ),
  };
  return { doc, frame: { leading: parsed.leading, trailing: parsed.trailing || '\n' } as Frame, latex: parsed.latex };
}

const CATEGORY_LABEL: Record<Category, string> = { spelling: 'Spelling', grammar: 'Grammar', style: 'Style', rules: 'Rules' };

export function WriteView() {
  const app = useApp();
  const { backend, settings, general, project, mock } = app;
  const [doc, setDoc] = useState<{ path: string | null; name: string }>({ path: null, name: 'untitled.md' });
  const [dirty, setDirty] = useState(false);
  const [docType, setDocType] = useState('paper');
  const [filters, setFilters] = useState<Record<Category, boolean>>({ spelling: true, grammar: true, style: true, rules: true });
  const [selected, setSelected] = useState<string | null>(null);
  /** Suggestion shown in place, under its underline. */
  const [popover, setPopover] = useState<string | null>(null);
  const [popoverTick, setPopoverTick] = useState(0);

  // Live values for the checker without re-creating it.
  const live = useRef({ settings, general, project, docType, language: app.language, profileChanged: app.profileChanged });
  live.current = { settings, general, project, docType, language: app.language, profileChanged: app.profileChanged };

  const checkerRef = useRef<Checker | null>(null);
  const frameRef = useRef<Frame>({ leading: '', trailing: '\n' });
  const asideRef = useRef<HTMLElement>(null);
  const orderedRef = useRef<Entry[]>([]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const issueRef = useRef<(action: IssueAction, n?: number) => void>(() => {});
  const popoverKeyRef = useRef<(key: string) => boolean>(() => false);
  const issueUnderCursorRef = useRef<() => string | null>(() => null);
  const vim = useMemo(
    () =>
      new Vim({
        prompt: (prefix, onSubmit) => app.openPrompt(prefix, onSubmit, () => editorRef.current?.commands.focus()),
        command: (line) => liveApp.current.runCommand(line),
        issue: (action, n) => issueRef.current(action, n),
        panel: () => focusPanel(),
        view: (dir) => liveApp.current.go(cycleView(liveApp.current.view, dir)),
        leader: () => liveApp.current.setLeaderOpen(true),
        popoverKey: (key) => popoverKeyRef.current(key),
        onIssue: () => issueUnderCursorRef.current() !== null,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const liveApp = useRef(app);
  liveApp.current = app;
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bold: false, italic: false, strike: false, code: false, codeBlock: false, blockquote: false,
        bulletList: false, orderedList: false, listItem: false, listKeymap: false, horizontalRule: false,
        link: false, underline: false,
      }),
      vim.extension(),
      BlockSeparators,
      LatexHeadings,
      IssuesExtension((id) => {
        setSelected(id);
        setPopover(id);
        checkerRef.current?.select(id);
        if (id) document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }),
    ],
    content: toContent(mock ? SAMPLE_DOCUMENT : '').doc,
    onUpdate: () => setDirty(true),
  });
  editorRef.current = editor;
  useEffect(() => {
    if (editor) vim.attach(editor);
    vim.setEnabled(settings.vim);
  }, [editor, vim, settings.vim]);
  useEffect(() => vim.setEscape(settings.vimEscape ?? { sequence: '', timeoutMs: 300, ctrlC: true }), [vim, settings.vimEscape]);
  const vimState = useSyncExternalStore(
    (fn) => vim.subscribe(fn),
    () => `${vim.mode}|${vim.pending}`,
  );
  const [vimMode, vimPending] = vimState.split('|');

  const checker = useMemo(() => {
    if (!editor) return null;
    const c = new Checker(editor, {
      backend,
      settings: () => live.current.settings,
      profiles: () => ({ general: live.current.general, project: live.current.project }),
      ruleSets: () => liveApp.current.ruleSets,
      onRuleEvent: (setId, ev) => {
        void liveApp.current.backend.rules.applyEvent(setId, ev).then((s) => liveApp.current.ruleSetChanged(s));
      },
      docType: () => live.current.docType,
      language: () => live.current.language,
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
    () => (checker ? `${checker.entries.size}:${checker.feedback.length}:${checker.grammarPhase}:${checker.stylePhase}:${checker.message}:${checker.styleProgress.waiting}/${checker.styleProgress.checking}/${checker.styleProgress.total}:${[...checker.entries.values()].map((e) => (e.kind === 'style' ? e.status : '')).join('')}` : ''),
  );

  // Context changes that invalidate style results.
  const profileKey = `${general?.id}:${general?.moves.map((m) => m.id + m.description + m.enabled + m.scope.docTypes + m.scope.sections).join()}|${project?.id}:${project?.moves.map((m) => m.id + m.description + m.enabled).join()}`;
  const rulesKey = app.ruleSets.map((s) => s.id + s.rules.map((r) => r.id + r.description + r.enabled + r.notes.length + r.scope.sections).join()).join('|');
  useEffect(() => checker?.invalidate('style'), [checker, profileKey, rulesKey, docType]);
  const language = app.language;
  useEffect(() => checker?.invalidate('grammar'), [checker, settings.grammar.engine, language, settings.grammar.harperDialect, settings.dictionary.length]);
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

  const counts = { spelling: 0, grammar: 0, style: 0, rules: 0 } as Record<Category, number>;
  for (const e of ordered) counts[e.category]++;
  const visible = ordered.filter((e) => filters[e.category]);
  orderedRef.current = visible;

  function selectIssue(id: string, moveCursor: boolean) {
    setSelected(id);
    checker?.select(id);
    const r = checker?.range(id);
    if (moveCursor && r && editor) editor.chain().setTextSelection(r.from).scrollIntoView().run();
    document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'nearest' });
  }

  function issueUnderCursor(): string | null {
    if (!editor || !checker) return null;
    const head = editor.state.selection.head;
    const hit = orderedRef.current.find((e) => {
      const r = checker.range(e.id);
      return r && head >= r.from && head <= r.to;
    });
    return hit?.id ?? null;
  }
  issueUnderCursorRef.current = issueUnderCursor;

  /** The issue under the cursor, else the selected card if it still exists. */
  function currentIssue(): string | null {
    const sel = selectedRef.current;
    return issueUnderCursor() ?? (sel && checker?.entries.has(sel) ? sel : null);
  }

  function act(action: IssueAction, id: string | null, n?: number) {
    if (!checker || !editor) return;
    if (action === 'next' || action === 'prev') {
      const list = orderedRef.current.map((e) => ({ id: e.id, r: checker.range(e.id)! })).filter((x) => x.r);
      if (!list.length) return app.notify('No suggestions.');
      let head = editor.state.selection.head;
      let target = list[0]!;
      for (let k = 0; k < (n ?? 1); k++) {
        target = action === 'next'
          ? list.find((x) => x.r.from > head) ?? list[0]!
          : [...list].reverse().find((x) => x.r.from < head) ?? list[list.length - 1]!;
        head = target.r.from;
      }
      selectIssue(target.id, true);
      return setPopover(target.id);
    }
    if (action === 'open' && !id) return act('next', null, 1);
    const target = id;
    if (!target) return app.notify('No suggestion under the cursor.');
    const e = checker.entries.get(target);
    if (!e) return;
    switch (action) {
      case 'open':
        selectIssue(target, false);
        return setPopover(target);
      case 'pick':
        if (e.kind === 'grammar') {
          const r = e.issue.replacements[(n ?? 1) - 1];
          if (r !== undefined) checker.applyReplacement(target, r);
        } else if (n === 1 && settings.mode === 'assistant') void checker.accept(target);
        return;
      case 'accept':
        if (e.kind === 'grammar') {
          const r = e.issue.replacements[0];
          if (r !== undefined) checker.applyReplacement(target, r);
        } else if (settings.mode === 'assistant') void checker.accept(target);
        else app.notify('Teacher mode: revise the passage yourself, then zc.');
        return;
      case 'dismiss':
        return checker.dismiss(target);
      case 'reject':
        if (e.kind !== 'style') return checker.dismiss(target);
        return app.openPrompt('not for me, why? ', (reason) => void checker.reject(target, reason), () => editor.commands.focus());
      case 'check':
        if (e.kind === 'style') void checker.requestFeedback(target);
        return;
      case 'addword':
        if (e.kind === 'grammar' && e.category === 'spelling') void app.updateSettings({ dictionary: [...settings.dictionary, e.issue.text] });
        return;
    }
  }
  issueRef.current = (action, n) =>
    act(action, action === 'next' || action === 'prev' ? null : action === 'open' ? issueUnderCursor() : currentIssue(), n);

  const popoverRef = useRef<string | null>(null);
  popoverRef.current = popover;
  /** Single keys while a suggestion is open in the text (vim normal mode). */
  popoverKeyRef.current = (key) => {
    const id = popoverRef.current;
    if (!id || !checker?.entries.has(id)) return false;
    const e = checker.entries.get(id)!;
    switch (key) {
      case '<Esc>':
      case '<C-[>':
      case '<C-c>':
        setPopover(null);
        return true;
      case 'Enter':
      case '<CR>':
      case 'a':
        act(e.kind === 'style' && settings.mode === 'teacher' ? 'check' : 'accept', id);
        return true;
      case 'x':
        act('dismiss', id);
        return true;
      case 'r':
        act('reject', id);
        return true;
      case 'c':
        act('check', id);
        return true;
      case '+':
        act('addword', id);
        setPopover(null);
        return true;
      case 'Tab':
        act('next', null, 1);
        return true;
      case '<S-Tab>':
        act('prev', null, 1);
        return true;
      default:
        if (/^[1-9]$/.test(key)) {
          act('pick', id, Number(key));
          return true;
        }
        setPopover(null);
        return false;
    }
  };

  function focusPanel() {
    if (!orderedRef.current.length) return app.notify('No suggestions.');
    const id = currentIssue() ?? orderedRef.current[0]!.id;
    selectIssue(id, false);
    asideRef.current?.focus();
  }

  function focusEditor() {
    const r = selectedRef.current ? checker?.range(selectedRef.current) : undefined;
    if (r) editor?.chain().focus().setTextSelection(r.from).scrollIntoView().run();
    else editor?.commands.focus();
  }

  const panelZ = useRef(false);
  function onPanelKey(ev: React.KeyboardEvent) {
    if (!settings.vim || ev.target !== asideRef.current) return;
    const list = orderedRef.current;
    const at = list.findIndex((e) => e.id === selectedRef.current);
    const sel = selectedRef.current;
    const done = () => ev.preventDefault();
    if (panelZ.current) {
      panelZ.current = false;
      if (ev.key === 'g') return done(), act('addword', sel);
      if (ev.key === '=') return done();
    }
    switch (ev.key) {
      case 'j':
      case 'ArrowDown':
        if (list.length) selectIssue(list[Math.min(list.length - 1, at + 1)]!.id, false);
        return done();
      case 'k':
      case 'ArrowUp':
        if (list.length) selectIssue(list[Math.max(0, at - 1)]!.id, false);
        return done();
      case 'Enter':
      case 'a': {
        const e = sel ? checker?.entries.get(sel) : undefined;
        if (e?.kind === 'style' && settings.mode === 'teacher') act('check', sel);
        else act('accept', sel);
        return done();
      }
      case 'x':
      case 'd':
        act('dismiss', sel);
        return done();
      case 'r':
        act('reject', sel);
        return done();
      case 'c':
        act('check', sel);
        return done();
      case 'z':
        panelZ.current = true;
        return done();
      case 'Escape':
      case 'h':
      case 'i':
        focusEditor();
        return done();
      default:
        if (/^[1-9]$/.test(ev.key)) {
          act('pick', sel, Number(ev.key));
          return done();
        }
    }
  }

  useEffect(
    () =>
      app.registerCommands({
        w: () => void save(),
        e: () => void open(),
        check: () => checker?.invalidate('all'),
        issue: (arg) => {
          const action = arg.trim() as IssueAction;
          const known: IssueAction[] = ['next', 'prev', 'open', 'accept', 'dismiss', 'reject', 'check', 'addword'];
          if (!known.includes(action)) return app.notify(`:issue ${known.join('|')}`);
          if (app.view !== 'write') app.go('write');
          issueRef.current(action, 1);
        },
        doctype: (v) => (DOC_TYPES.includes(v as (typeof DOC_TYPES)[number]) ? setDocType(v) : app.notify(`Document types: ${DOC_TYPES.join(', ')}`)),
        __editor: () => focusEditor(),
        __panel: () => focusPanel(),
      }),
  );

  // Close the popover once its suggestion is gone (applied, dismissed, edited away).
  useEffect(() => {
    if (popover && checker && !checker.entries.has(popover)) setPopover(null);
  }, [popover, checker, version]);

  async function open() {
    try {
      const d = await backend.files.openDocument();
      if (!d || !editor) return;
      const loaded = toContent(d.text, d.name);
      frameRef.current = loaded.frame;
      editor.commands.setContent(loaded.doc, { emitUpdate: false });
      setDoc({ path: d.path, name: d.name });
      setDirty(false);
      if (loaded.latex) setDocType('paper');
      checker?.reset();
    } catch (e) {
      app.notify(errorText(e));
    }
  }

  async function save() {
    if (!editor) return;
    const text = serializeDocument(
      blocks(editor.state.doc).map((b): DocBlock =>
        b.type === 'heading' ? { type: 'heading', level: b.level, text: b.text, sep: b.sep } : { type: 'paragraph', text: b.text, sep: b.sep },
      ),
      frameRef.current,
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
  const sp = checker?.styleProgress ?? { waiting: 0, checking: 0, total: 0 };
  const styleLeft = sp.waiting + sp.checking;
  const styleDone = Math.max(0, sp.total - styleLeft);
  const lastSecs = checker?.lastStyleMs ? (checker.lastStyleMs / 1000).toFixed(1) : null;
  const err = checker && (checker.grammarPhase === 'error' || checker.stylePhase === 'error' || !!checker.message);
  const projects = app.summaries.filter((s) => s.kind === 'project');
  const generals = app.summaries.filter((s) => s.kind === 'general' && languageMatches(s.language, app.language));

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
          value={general?.id ?? ''}
          onChange={(e) => void app.setActiveGeneral(e.target.value || null)}
          title={`General taste profile for ${languageLabel(app.language)}`}
        >
          <option value="">{generals.length ? 'No general profile' : `No ${baseLabel(baseLanguage(app.language))} profiles`}</option>
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
        <RulesPicker />
        <span className="tag" title={project?.language ? `Language of the project profile ${project.name}` : 'Default language from Settings'}>{languageLabel(language)}</span>
        <div className="seg" role="tablist">
          <button className={settings.mode === 'assistant' ? 'on' : ''} onClick={() => setMode('assistant')}>Assistant</button>
          <button className={settings.mode === 'teacher' ? 'on' : ''} onClick={() => setMode('teacher')}>Teacher</button>
        </div>
        <span className="status">
          {settings.vim && (
            <span className={`vim-mode vim-mode-${vimMode}`}>
              {vimMode === 'visual-line' ? 'V-LINE' : vimMode!.toUpperCase()}
              {vimPending && <span className="kbd">{vimPending}</span>}
            </span>
          )}
          <span className={`dot ${err ? 'err' : busy ? 'busy' : 'ok'}`} />
          {err ? (
            <span className="error" title={checker?.message}>{checker?.message.slice(0, 80)}</span>
          ) : styleLeft ? (
            <span title={lastSecs ? `Last style request took ${lastSecs} s` : undefined}>Checking style · {styleDone} of {sp.total}</span>
          ) : busy ? (
            'Checking spelling'
          ) : (
            <span title={lastSecs ? `Last style request took ${lastSecs} s` : undefined}>Up to date</span>
          )}
        </span>
      </div>
      <div className="write">
        <div className="page-scroll" onScroll={() => popover && setPopoverTick((t) => t + 1)}>
          <div className={`page ${settings.mode}`}>
            <EditorContent editor={editor} />
          </div>
          {popover && checker && editor && checker.entries.has(popover) && (
            <InlinePopover
              key={popover}
              entry={checker.entries.get(popover)!}
              anchor={checker.range(popover)}
              editorView={editor.view}
              tick={popoverTick + Number(version.length)}
              onClose={() => setPopover(null)}
            >
              <SuggestionCard
                e={checker.entries.get(popover)!}
                mode={settings.mode}
                selected={false}
                inline
                checker={checker}
                onSelect={() => {}}
                onAddWord={(w) => {
                  void app.updateSettings({ dictionary: [...settings.dictionary, w] });
                  setPopover(null);
                }}
              />
              {settings.vim && (
                <div className="popover-keys">
                  {checker.entries.get(popover)!.kind === 'grammar'
                    ? <><span className="kbd">1-9</span> pick <span className="kbd">x</span> ignore <span className="kbd">+</span> add word</>
                    : settings.mode === 'teacher'
                      ? <><span className="kbd">Enter</span> check revision <span className="kbd">x</span> skip <span className="kbd">r</span> not for me</>
                      : <><span className="kbd">Enter</span> accept <span className="kbd">x</span> dismiss <span className="kbd">r</span> not for me</>}
                  {' '}<span className="kbd">Tab</span> next <span className="kbd">Esc</span> close
                </div>
              )}
            </InlinePopover>
          )}
        </div>
        <aside className="side" ref={asideRef} tabIndex={-1} data-vim-scope onKeyDown={onPanelKey}>
          <div className="side-head">
            <div className="chips">
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <button key={c} className={`chip${filters[c] ? '' : ' off'}`} onClick={() => setFilters({ ...filters, [c]: !filters[c] })}>
                  <span className="sw" style={{ background: `var(--${c})` }} />
                  {CATEGORY_LABEL[c]} <span className="n">{counts[c]}</span>
                </button>
              ))}
            </div>
            {styleLeft > 0 && (
              <div className="progress" title="Paragraphs waiting are marked in the margin">
                <div className="small">
                  Checking style{app.ruleSets.length ? ' and rules' : ''}: {styleDone} of {sp.total} paragraphs{sp.checking ? `, ${sp.checking} in progress` : ''}
                  {lastSecs && <span className="muted"> · last request {lastSecs} s</span>}
                </div>
                <div className="bar"><i style={{ width: `${sp.total ? (styleDone / sp.total) * 100 : 0}%` }} /></div>
              </div>
            )}
            {settings.mode === 'teacher' && (
              <div className="small muted">Style issues show a hint only. Revise the passage; feedback comes when you leave the paragraph.</div>
            )}
            {settings.grammar.engine === 'harper' && !harperDialectFor(app.language, settings.grammar.harperDialect) && (
              <div className="small muted">
                Harper checks English only, so spelling and grammar are off for {languageLabel(app.language)}.{' '}
                <a href="#" onClick={(e) => (e.preventDefault(), app.go('settings'))}>Use LanguageTool</a>
              </div>
            )}
            {app.generalMismatch && (
              <div className="small muted">
                {app.generalMismatch.name} is a {languageLabel(app.generalMismatch.language ?? '')} profile and is not used for {languageLabel(app.language)} text.
              </div>
            )}
            {!general && !project && !app.ruleSets.length && (
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

function SuggestionCard({ e, mode, selected, checker, onSelect, onAddWord, inline = false }: {
  e: Entry; mode: Mode; selected: boolean; checker: Checker; onSelect(): void; onAddWord(w: string): void; inline?: boolean;
}) {
  const domId = inline ? undefined : `card-${e.id}`;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const stop = (fn: () => void) => (ev: React.MouseEvent) => {
    ev.stopPropagation();
    fn();
  };

  if (e.kind === 'grammar') {
    const i = e.issue;
    return (
      <div id={domId} className={`card ${e.category}${selected ? ' selected' : ''}`} onClick={onSelect}>
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
    <div id={domId} className={`card ${e.category}${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="kind">{e.category === 'rules' ? 'Rule' : 'Style'} <span>·</span> <span style={{ textTransform: 'none', letterSpacing: 0 }}>{e.move.title}</span></div>
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

/** A suggestion card floating under its underline in the text. */
function InlinePopover({ entry, anchor, editorView, tick, onClose, children }: {
  entry: Entry;
  anchor: { from: number; to: number } | undefined;
  editorView: import('@tiptap/pm/view').EditorView;
  tick: number;
  onClose(): void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchor) return;
    try {
      const start = editorView.coordsAtPos(anchor.from);
      const end = editorView.coordsAtPos(anchor.to, -1);
      const width = 340;
      const height = ref.current?.offsetHeight ?? 160;
      const below = end.bottom + 6;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, start.top - height - 6) : below;
      const left = Math.max(72, Math.min(start.left, window.innerWidth - width - 12));
      setPos({ top, left });
    } catch {
      setPos(null);
    }
  }, [anchor?.from, anchor?.to, editorView, tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('.issue')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  if (!anchor) return null;
  return (
    <div
      ref={ref}
      className={`popover ${entry.category}`}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      role="dialog"
      aria-label="Suggestion"
    >
      {children}
    </div>
  );
}

/** Choose which rule sets apply to the current project. */
function RulesPicker() {
  const app = useApp();
  const options = app.ruleSummaries.filter((r) => languageMatches(r.language, app.language));
  const active = new Set(app.activeRuleIds);
  const n = options.filter((o) => active.has(o.id)).length;
  return (
    <details className="rules-picker">
      <summary className="btn ghost small" title="Rule sets checked for this project">Rules{n ? ` (${n})` : ''}</summary>
      <div className="rules-menu">
        {options.map((o) => (
          <label key={o.id} className="inline">
            <input
              type="checkbox"
              checked={active.has(o.id)}
              onChange={(e) => void app.setActiveRules(e.target.checked ? [...app.activeRuleIds, o.id] : app.activeRuleIds.filter((x) => x !== o.id))}
            />
            {o.name} <span className="small muted">{o.rules}</span>
          </label>
        ))}
        {!options.length && <span className="small muted">No rule sets in {languageLabel(app.language)} yet.</span>}
        <a href="#" className="small" onClick={(e) => (e.preventDefault(), app.go('rules'))}>Edit rule sets</a>
      </div>
    </details>
  );
}
