import { contextBridge, ipcRenderer } from 'electron';
import { channel, type Backend } from '@shared/api';

// Mirror of the Backend shape; each method becomes an IPC invoke.
const groups: { [K in keyof Backend]: (keyof Backend[K] & string)[] } = {
  settings: ['get', 'set'],
  profiles: ['list', 'get', 'save', 'remove', 'applyEvent', 'history', 'readSnapshot', 'rollback', 'exportTo', 'importFrom', 'reveal'],
  rules: ['list', 'get', 'save', 'remove', 'applyEvent', 'exportTo', 'importFrom'],
  coach: ['extract', 'extractRules', 'diff', 'checkStyle', 'editFeedback', 'blendConflicts'],
  grammar: ['check'],
  providers: ['status', 'login', 'test'],
  files: ['pickSources', 'openDocument', 'saveDocument'],
};

const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
for (const [group, methods] of Object.entries(groups)) {
  api[group] = {};
  for (const m of methods) api[group]![m] = (...args) => ipcRenderer.invoke(channel(group, m), ...args);
}

contextBridge.exposeInMainWorld('phaedrus', api);
