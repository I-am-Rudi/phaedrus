// The app's own small dialog (save / don't save / cancel, recent files). It
// takes every key while open, so vim bindings and the editor never see them:
// the button's letter picks it, Enter the highlighted one, Escape or Ctrl-c
// cancels, Tab / arrows / j k move between buttons.

import { useEffect, useRef, useState } from 'react';
import { useApp } from './state';

export function AskDialog() {
  const { dialog } = useApp();
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!dialog) return;
    const before = document.activeElement as HTMLElement | null;
    const start = Math.max(0, dialog.buttons.findIndex((b) => b.primary));
    setFocus(start);
    let at = start;
    const move = (d: number) => {
      at = (at + d + dialog.buttons.length) % dialog.buttons.length;
      setFocus(at);
      refs.current[at]?.focus();
    };
    const claimed = new Set(dialog.buttons.map((b) => b.key?.toLowerCase()).filter(Boolean));
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const k = e.key.toLowerCase();
      if (e.key === 'Escape' || (e.ctrlKey && k === 'c') || (e.ctrlKey && k === '[')) return dialog.resolve(dialog.cancel);
      if (e.key === 'Enter' || e.key === ' ') return dialog.resolve(dialog.buttons[at]!.value);
      const vertical = dialog.layout === 'list';
      if (e.key === 'Tab') return move(e.shiftKey ? -1 : 1);
      if (e.key === (vertical ? 'ArrowDown' : 'ArrowRight') || (k === 'j' && !claimed.has('j')) || (k === 'l' && !vertical && !claimed.has('l'))) return move(1);
      if (e.key === (vertical ? 'ArrowUp' : 'ArrowLeft') || (k === 'k' && !claimed.has('k')) || (k === 'h' && !vertical && !claimed.has('h'))) return move(-1);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = dialog.buttons.find((b) => b.key && b.key.toLowerCase() === k);
      if (hit) dialog.resolve(hit.value);
    };
    window.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => refs.current[start]?.focus());
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // Back to where the user was (usually the editor).
      if (before && document.contains(before)) before.focus();
    };
  }, [dialog]);

  if (!dialog) return null;
  const list = dialog.layout === 'list';
  return (
    <div className="overlay ask-overlay" onMouseDown={() => dialog.resolve(dialog.cancel)}>
      <div className={`ask${list ? ' list' : ''}`} role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()}>
        <div className="ask-title">{dialog.title}</div>
        {dialog.message && <p className="ask-message">{dialog.message}</p>}
        <div className="ask-buttons">
          {dialog.buttons.map((b, i) => (
            <button
              key={b.value + i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className={list ? `ask-item${i === focus ? ' on' : ''}` : `btn${b.primary ? ' primary' : ''}${i === focus ? ' focus' : ''}`}
              onClick={() => dialog.resolve(b.value)}
              onMouseEnter={() => list && setFocus(i)}
            >
              {b.key && <span className="kbd">{b.key}</span>}
              <span className="ask-label">{b.label}</span>
              {b.detail && <span className="ask-detail">{b.detail}</span>}
            </button>
          ))}
        </div>
        <div className="ask-hint muted">
          {list ? 'Number or letter to open, j/k and Enter, Esc to close' : 'Letter or Enter to choose, Esc to cancel'}
        </div>
      </div>
    </div>
  );
}
