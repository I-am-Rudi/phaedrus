import { contextBridge, ipcRenderer } from 'electron';
import { channel, type AppEvents, type Backend } from '@shared/api';

// Mirror of the Backend shape; each method becomes an IPC invoke.
const groups: { [K in keyof Backend]: (keyof Backend[K] & string)[] } = {
  settings: ['get', 'set'],
  profiles: ['list', 'get', 'save', 'remove', 'applyEvent', 'history', 'readSnapshot', 'rollback', 'exportTo', 'importFrom', 'reveal'],
  rules: ['list', 'get', 'save', 'remove', 'applyEvent', 'exportTo', 'importFrom'],
  coach: ['extract', 'extractRules', 'diff', 'checkStyle', 'checkStyleBatch', 'editFeedback', 'blendConflicts'],
  grammar: ['check'],
  providers: ['status', 'login', 'test'],
  files: ['pickSources', 'openDocument', 'saveDocument', 'recent', 'forgetRecent', 'watch'],
};

const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
for (const [group, methods] of Object.entries(groups)) {
  api[group] = {};
  for (const m of methods) api[group]![m] = (...args) => ipcRenderer.invoke(channel(group, m), ...args);
}

contextBridge.exposeInMainWorld('phaedrus', api);

const listen = (name: string, cb: (...args: any[]) => void) => {
  const h = (_e: unknown, ...args: any[]) => cb(...args);
  ipcRenderer.on(name, h);
  return () => void ipcRenderer.removeListener(name, h);
};

const events: AppEvents = {
  onFileChanged: (cb) => listen('files:changed', cb),
  onCloseRequested: (cb) =>
    listen('app:close-requested', () => {
      // Tell the main process someone is handling it, so it does not force the close.
      ipcRenderer.send('app:close-ack');
      cb();
    }),
  onMenu: (cb) => listen('menu:command', cb),
  answerClose: (ok) => ipcRenderer.send(ok ? 'app:close-ok' : 'app:close-cancel'),
};
contextBridge.exposeInMainWorld('phaedrusEvents', events);

// Window chrome: on macOS the page draws its own title bar area (see styles.css).
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('titlebar-inset'));
  ipcRenderer.on('window:fullscreen', (_e, on: boolean) => document.documentElement.classList.toggle('is-fullscreen', on));
}
