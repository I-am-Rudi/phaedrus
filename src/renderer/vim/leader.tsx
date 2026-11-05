// Space leader menu (which-key style): Space opens a panel listing the next
// keys, so the bindings can be explored instead of memorised.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state';

export interface LeaderNode {
  key: string;
  label: string;
  run?: () => void;
  children?: LeaderNode[];
}

/** The menu tree. Leaves run app commands; views register what they handle. */
export function useLeaderTree(): LeaderNode[] {
  const app = useApp();
  return useMemo(() => {
    const cmd = (line: string) => () => app.runCommand(line);
    const ask = (prefix: string, command: string) => () => app.openPrompt(prefix, (v) => v.trim() && app.runCommand(`${command} ${v.trim()}`));
    return [
      {
        key: 's', label: 'suggestions', children: [
          { key: 'n', label: 'next', run: cmd('issue next') },
          { key: 'p', label: 'previous', run: cmd('issue prev') },
          { key: 'o', label: 'open at cursor', run: cmd('issue open') },
          { key: 'a', label: 'accept', run: cmd('issue accept') },
          { key: 'd', label: 'dismiss', run: cmd('issue dismiss') },
          { key: 'r', label: 'not for me', run: cmd('issue reject') },
          { key: 'c', label: 'check my revision', run: cmd('issue check') },
          { key: 'w', label: 'add word to dictionary', run: cmd('issue addword') },
          { key: 'l', label: 'focus suggestion panel', run: cmd('__panel') },
          { key: 'R', label: 'recheck document', run: cmd('check') },
        ],
      },
      {
        key: 'f', label: 'file', children: [
          { key: 's', label: 'save', run: cmd('w') },
          { key: 'o', label: 'open', run: cmd('e') },
        ],
      },
      {
        key: 'm', label: 'mode', children: [
          { key: 'm', label: 'toggle assistant / teacher', run: cmd(app.settings.mode === 'teacher' ? 'assistant' : 'teacher') },
          { key: 'a', label: 'assistant', run: cmd('assistant') },
          { key: 't', label: 'teacher', run: cmd('teacher') },
        ],
      },
      {
        key: 'p', label: 'profiles', children: [
          { key: 'g', label: 'choose general profile', run: ask(':profile ', 'profile') },
          { key: 'p', label: 'choose project profile', run: ask(':project ', 'project') },
          { key: 'e', label: 'edit profiles', run: cmd('profiles') },
          { key: 'x', label: 'extract a profile', run: cmd('extract') },
          { key: 'b', label: 'blend profiles', run: cmd('blend') },
        ],
      },
      {
        key: 'd', label: 'document', children: [
          { key: 't', label: 'document type', run: ask(':set doctype=', 'doctype') },
          { key: 'r', label: 'recheck', run: cmd('check') },
        ],
      },
      {
        key: 'g', label: 'go to view', children: [
          { key: 'w', label: 'write', run: cmd('write') },
          { key: 'p', label: 'profiles', run: cmd('profiles') },
          { key: 'e', label: 'extract', run: cmd('extract') },
          { key: 'b', label: 'blend', run: cmd('blend') },
          { key: 's', label: 'settings', run: cmd('settings') },
        ],
      },
      { key: 'h', label: 'cheat sheet (toggle)', run: () => app.setCheatOpen(!app.cheatOpen) },
      { key: ':', label: 'command line', run: () => app.openPrompt(':', (l) => app.runCommand(l)) },
      { key: '?', label: 'all keys', run: () => app.setHelpOpen(true) },
    ];
  }, [app]);
}

export function LeaderMenu() {
  const app = useApp();
  const tree = useLeaderTree();
  const [path, setPathState] = useState<string[]>([]);
  const pathRef = useRef<string[]>([]);
  const live = useRef({ app, tree });
  live.current = { app, tree };
  const setPath = (p: string[]) => {
    pathRef.current = p;
    setPathState(p);
  };

  // Always listening (capture phase) so no key typed right after Space is lost.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { app, tree } = live.current;
      if (!app.leaderRef.current) {
        if (pathRef.current.length) setPath([]);
        return;
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const close = () => {
        setPath([]);
        app.setLeaderOpen(false);
      };
      if (e.key === 'Escape') return close();
      if (e.key === 'Backspace') return pathRef.current.length ? setPath(pathRef.current.slice(0, -1)) : close();
      const hit = nodesAt(tree, pathRef.current).find((n) => n.key === e.key);
      if (!hit) return;
      if (hit.children) return setPath([...pathRef.current, hit.key]);
      close();
      hit.run?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!app.leaderOpen) return null;
  const nodes = nodesAt(tree, path);
  const crumbs = path.map((_, i) => nodesAt(tree, path.slice(0, i)).find((n) => n.key === path[i])?.label ?? '');
  return (
    <div className="leader" role="menu" aria-label="Leader menu">
      <div className="leader-crumbs">
        <span className="kbd">SPC</span>
        {path.map((k, i) => (
          <span key={i}>
            <span className="kbd">{k}</span> <span className="muted">{crumbs[i]}</span>
          </span>
        ))}
        <span className="grow" />
        <span className="small muted">Esc closes, Backspace goes up</span>
      </div>
      <div className="leader-grid">
        {nodes.map((n) => (
          <div key={n.key} className="leader-item">
            <span className="kbd">{n.key}</span>
            <span className={n.children ? 'leader-group' : ''}>{n.children ? `+${n.label}` : n.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function nodesAt(tree: LeaderNode[], path: string[]): LeaderNode[] {
  let nodes = tree;
  for (const k of path) {
    const n = nodes.find((x) => x.key === k);
    if (!n?.children) break;
    nodes = n.children;
  }
  return nodes;
}
