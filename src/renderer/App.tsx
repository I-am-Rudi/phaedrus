import { useEffect, type ReactNode } from 'react';
import { applyTheme } from './themes';
import { useApp, type ViewId } from './state';
import { CommandLine, HelpOverlay, useGlobalVim } from './vim/app';
import { LeaderMenu } from './vim/leader';
import { BlendView } from './views/BlendView';
import { ExtractView } from './views/ExtractView';
import { ProfilesView } from './views/ProfilesView';
import { SettingsView } from './views/SettingsView';
import { WriteView } from './views/WriteView';

const ICONS: Record<ViewId, ReactNode> = {
  write: <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />,
  profiles: <path d="M5 4h11l3 3v13H5zM9 10h7M9 14h7M9 18h4" />,
  extract: <path d="M12 4v10m-4-4l4 4 4-4M5 18h14" />,
  blend: <path d="M9 12a5 5 0 1 0 0 .01M15 12a5 5 0 1 0 0 .01" />,
  settings: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />,
};
const LABELS: Record<ViewId, string> = { write: 'Write', profiles: 'Profiles', extract: 'Extract', blend: 'Blend', settings: 'Settings' };

export function App() {
  const { view, go, mock, toast, settings } = useApp();
  useGlobalVim();
  useEffect(() => applyTheme(settings.theme ?? 'system'), [settings.theme]);
  const button = (id: ViewId) => (
    <button key={id} className={view === id ? 'active' : ''} onClick={() => go(id)} title={LABELS[id]}>
      <svg viewBox="0 0 24 24" aria-hidden>{ICONS[id]}</svg>
      {LABELS[id]}
    </button>
  );
  return (
    <div className="app">
      <nav className="rail">
        <div className="mark">G</div>
        {(['write', 'profiles', 'extract', 'blend'] as ViewId[]).map(button)}
        <div className="spacer" />
        {button('settings')}
      </nav>
      <main className="view">
        {mock && <div className="mock-banner">Browser preview: profiles live in memory and a rule-based stand-in replaces the language model.</div>}
        {/* The write view stays mounted so the document and its checks survive navigation. */}
        <div className="view" style={{ display: view === 'write' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <WriteView />
        </div>
        {view === 'profiles' && <ProfilesView />}
        {view === 'extract' && <ExtractView />}
        {view === 'blend' && <BlendView />}
        {view === 'settings' && <SettingsView />}
        <CommandLine />
        <HelpOverlay />
        <LeaderMenu />
        {toast && <div className="notice" style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 10 }}>{toast}</div>}
      </main>
    </div>
  );
}
