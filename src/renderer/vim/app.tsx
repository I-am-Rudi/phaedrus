// App-wide vim support: the ":" command line, the key reference, and keys for
// the views outside the editor (j/k focus, gg/G, Enter, gt/gT, Ctrl-w).

import { useEffect, useRef, useState } from 'react';
import { useApp, type ViewId } from '../state';

const VIEW_ORDER: ViewId[] = ['write', 'profiles', 'rules', 'extract', 'blend', 'settings'];

export function cycleView(current: ViewId, dir: 1 | -1): ViewId {
  const i = VIEW_ORDER.indexOf(current);
  return VIEW_ORDER[(i + dir + VIEW_ORDER.length) % VIEW_ORDER.length]!;
}

export function CommandLine() {
  const { prompt, closePrompt } = useApp();
  const [value, setValue] = useState('');
  const history = useRef<string[]>([]);
  const pos = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prompt) {
      setValue('');
      pos.current = history.current.length;
      window.setTimeout(() => input.current?.focus(), 0);
    }
  }, [prompt]);

  if (!prompt) return null;
  const finish = (submit: boolean) => {
    const p = prompt;
    closePrompt();
    if (submit) {
      if (value.trim()) history.current.push(value);
      p.onSubmit(value);
    }
    p.onClose?.();
  };
  return (
    <div className="cmdline">
      <span className="cmd-prefix">{prompt.prefix}</span>
      <input
        ref={input}
        type="text"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === '[')) || (e.key === 'Backspace' && !value)) {
            e.preventDefault();
            finish(false);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const h = history.current;
            pos.current = Math.max(0, Math.min(h.length, pos.current + (e.key === 'ArrowUp' ? -1 : 1)));
            setValue(h[pos.current] ?? '');
          }
        }}
      />
    </div>
  );
}

const KEYS: [string, [string, string][]][] = [
  ['Suggestions', [
    ['Tab  Shift-Tab', 'jump to the next, previous suggestion and show it in the text'],
    ['K  or Enter on an underline', 'show the suggestion under the cursor'],
    ['while one is shown', 'Enter accept (teacher mode: revise its paragraph), 1-9 pick, x dismiss, r not for me, + add word, Tab next, Esc close'],
    ['teacher: revising a paragraph', 'Enter (normal mode) done, the changed passages go for feedback; SPC s x discard'],
    ['feedback card', 'Enter (normal mode, cursor not on a suggestion) closes the newest one; SPC s f too'],
    [']s [s z= zg', "vim's spell keys work too"],
    ['Ctrl-w l  Ctrl-w h', 'to the suggestion panel and back; there j k move, Enter accepts'],
  ]],
  ['Space menu', [
    ['Space', 'opens a menu of everything else: s suggestions, f file, m mode, p profiles, d document, g go to view; Backspace goes up'],
    ['Space h', 'toggle a small cheat sheet of the most-used keys'],
  ]],
  ['Modes', [
    ['i a I A o O', 'insert before, after, at line start, at line end, on a new line below, above'],
    ['v V  Esc', 'visual, visual line, back to normal'],
  ]],
  ['Moving', [
    ['h j k l', 'left, down, up, right (j and k follow wrapped lines)'],
    ['w b e  W B E', 'next word, previous word, end of word (W B E: ignore punctuation)'],
    ['0 ^ $', 'line start, first non-blank, line end'],
    ['gg G  { }', 'first line, last line (or line N with a count), previous and next paragraph'],
    ['f t F T  ; ,', 'to a character on the line, repeat, repeat backwards'],
    ['/ ? n N', 'search forward, backward, next, previous'],
    ['Ctrl-d Ctrl-u  zz', 'half a page down, up, center the cursor'],
  ]],
  ['Editing', [
    ['d c y  + motion', 'delete, change, yank (dd cc yy for lines, counts work: 3dw)'],
    ['iw aw is as ip ap', 'text objects: word, sentence, paragraph (e.g. ciw, dap)'],
    ['x X D C s S r J ~', 'the usual single-key edits'],
    ['p P u Ctrl-r', 'paste after, before, undo, redo'],
  ]],
  ['Everywhere', [
    ['gt gT', 'next, previous view'],
    ['j k gg G Enter', 'move between and activate controls outside the editor; i returns to the editor'],
    [':', 'command line: :w :saveas :e [file] :e! :recent :teacher :assistant :profile NAME :project NAME :set doctype=paper :set novim'],
    ['?', 'this list'],
  ]],
];

export function HelpOverlay() {
  const { helpOpen, setHelpOpen } = useApp();
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'q' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        setHelpOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [helpOpen, setHelpOpen]);
  if (!helpOpen) return null;
  return (
    <div className="overlay" onClick={() => setHelpOpen(false)}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">Vim keys</h2>
          <span className="small muted">Esc or q closes</span>
        </div>
        {KEYS.map(([group, rows]) => (
          <div key={group}>
            <h3>{group}</h3>
            <table>
              <tbody>
                {rows.map(([k, d]) => (
                  <tr key={k}>
                    <td className="kbd-cell">{k}</td>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [data-activate], a[href]';

function focusables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`main ${FOCUSABLE}`)].filter(
    (el) => el.offsetParent !== null && !el.closest('[data-vim-scope]') && !el.closest('.ProseMirror'),
  );
}

const isField = (el: Element | null) => !!el && (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable);

/** Keys outside the editor. The editor handles its own keys; text fields keep theirs (Esc leaves them). */
export function useGlobalVim() {
  const app = useApp();
  const live = useRef({ app, focusEditor: () => app.runCommand('__editor'), focusPanel: () => app.runCommand('__panel') });
  live.current = { app, focusEditor: () => app.runCommand('__editor'), focusPanel: () => app.runCommand('__panel') };
  const pending = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { app, focusEditor, focusPanel } = live.current;
      if (!app.settings.vim || app.prompt || app.helpOpen || app.leaderRef.current || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ProseMirror')) return;
      if (isField(target)) {
        if (e.key === 'Escape' || (e.ctrlKey && e.key === '[')) target!.blur();
        return;
      }
      if (e.metaKey || e.altKey) return;
      const key = e.ctrlKey ? `<C-${e.key.toLowerCase()}>` : e.key;
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      const inScope = !!target?.closest('[data-vim-scope]');

      const p = pending.current;
      pending.current = null;
      const handled = () => e.preventDefault();

      if (p === 'g') {
        if (key === 't') return handled(), app.go(cycleView(app.view, 1));
        if (key === 'T') return handled(), app.go(cycleView(app.view, -1));
        if (key === 'g' && !inScope) return handled(), focusables()[0]?.focus();
        return;
      }
      if (p === '<C-w>') {
        if (app.view !== 'write') return;
        if (key === 'h' || key === '<C-h>') return handled(), focusEditor();
        if (key === 'l' || key === '<C-l>') return handled(), focusPanel();
        return;
      }
      if (key === 'g' || key === '<C-w>') {
        pending.current = key;
        return handled();
      }
      if (key === ':') return handled(), app.openPrompt(':', (line) => app.runCommand(line));
      if (key === ' ') return handled(), app.setLeaderOpen(true);
      if (key === '?') return handled(), app.setHelpOpen(true);
      if (inScope) return;

      const list = focusables();
      const at = list.indexOf(document.activeElement as HTMLElement);
      switch (key) {
        case 'j':
          return handled(), list[Math.min(list.length - 1, at + 1)]?.focus();
        case 'k':
          return handled(), list[Math.max(0, at - 1)]?.focus();
        case 'G':
          return handled(), list[list.length - 1]?.focus();
        case 'Enter':
          if (target?.hasAttribute('data-activate')) return handled(), target.click();
          return;
        case 'i':
          if (app.view === 'write') return handled(), focusEditor();
          return;
        case 'Escape':
          return (document.activeElement as HTMLElement | null)?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Small, non-modal reference of the most-used keys; SPC h toggles it. */
export function CheatSheet() {
  const { cheatOpen, setCheatOpen, settings } = useApp();
  if (!cheatOpen || !settings.vim) return null;
  const esc = ['Esc', 'Ctrl-[', ...(settings.vimEscape.ctrlC ? ['Ctrl-c'] : []), ...(settings.vimEscape.sequence ? [settings.vimEscape.sequence] : [])].join(' ');
  const rows: [string, [string, string][]][] = [
    ['Suggestions', [
      ['Tab S-Tab', 'next, previous, shown in place'],
      ['K', 'show the one under the cursor'],
      ['Enter', 'accept (teacher: revise the paragraph)'],
      ['Enter', 'revising: done · feedback: close'],
      ['SPC s x', 'discard the revision'],
      ['1-9 x r +', 'pick, dismiss, not for me, add word'],
    ]],
    ['Modes', [
      ['i a A o', 'insert here, after, at end, new line'],
      [esc, 'back to normal'],
      ['v V', 'visual, visual line'],
    ]],
    ['Move', [
      ['w b e', 'word forward, back, end'],
      ['0 $  gg G', 'line start, end, top, bottom'],
      ['f t  /  { }', 'to char, search, paragraph'],
    ]],
    ['Edit', [
      ['dw ciw dd', 'delete word, change word, delete line'],
      ['yy p u Ctrl-r', 'yank line, paste, undo, redo'],
    ]],
    ['More', [
      ['Space', 'menu of everything else'],
      [':w  :e  :recent', 'save, open, open recent'],
      ['gt', 'next view'],
    ]],
  ];
  return (
    <div className="cheat" role="complementary" aria-label="Vim cheat sheet">
      <div className="row">
        <b className="grow">Vim keys</b>
        <span className="small muted">SPC h hides</span>
        <button className="btn ghost small" onClick={() => setCheatOpen(false)} aria-label="Close cheat sheet">×</button>
      </div>
      {rows.map(([group, items]) => (
        <div key={group} className="cheat-group">
          <div className="cheat-title">{group}</div>
          {items.map(([k, d]) => (
            <div className="cheat-row" key={k}>
              <span className="cheat-keys">{k}</span>
              <span>{d}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
