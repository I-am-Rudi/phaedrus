import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { channel, type Backend } from '@shared/api';
import { checkStyle, editFeedback, extractProfile, findBlendConflicts } from '@shared/coach';
import { diffProfiles } from '@shared/profile/diff';
import { exportBundle, exportMarkdown, importProfile } from '@shared/profile/exchange';
import { applyEvent } from '@shared/profile/feedback';
import type { SourceDoc } from '@shared/types';
import { checkGrammar } from './grammar';
import { createLLM, providerLogin, providerStatus } from './providers';
import { Store } from './store';

const store = new Store(app.getPath('userData'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
});

/** Empty folder the CLI providers run in, so no project context leaks into prompts. */
const cliWorkDir = join(app.getPath('userData'), 'cli-sandbox');
mkdirSync(cliWorkDir, { recursive: true });

const llm = async () => createLLM(await store.getSettings(), cliWorkDir);
const win = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;

const TEXT_FILTERS = [{ name: 'Text', extensions: ['md', 'markdown', 'txt', 'tex'] }];

const backend: Backend = {
  settings: {
    get: () => store.getSettings(),
    set: (patch) => store.setSettings(patch),
  },
  profiles: {
    list: () => store.listProfiles(),
    get: (id) => store.getProfile(id),
    save: (p, reason) => store.saveProfile(p, reason),
    remove: (id) => store.removeProfile(id),
    async applyEvent(profileId, event) {
      const current = await store.getProfile(profileId);
      const next = applyEvent(current, event);
      return next === current ? current : store.saveProfile(next, `auto: ${event.type} ${event.moveId}`);
    },
    history: (id) => store.history(id),
    readSnapshot: (id, snap) => store.readSnapshot(id, snap),
    rollback: (id, snap) => store.rollback(id, snap),
    async exportTo(id, format, policy) {
      const p = await store.getProfile(id);
      const { canceled, filePath } = await dialog.showSaveDialog(win(), {
        defaultPath: `${p.id}.${format}`,
        filters: [format === 'zip' ? { name: 'Profile bundle', extensions: ['zip'] } : { name: 'Markdown', extensions: ['md'] }],
      });
      if (canceled || !filePath) return null;
      await writeFile(filePath, format === 'zip' ? exportBundle(p, policy) : exportMarkdown(p, policy));
      return filePath;
    },
    async importFrom() {
      const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
        properties: ['openFile'],
        filters: [{ name: 'Profile', extensions: ['md', 'zip'] }],
      });
      const file = filePaths[0];
      if (canceled || !file) return null;
      const data = file.endsWith('.zip') ? new Uint8Array(await readFile(file)) : await readFile(file, 'utf8');
      const p = importProfile(data, basename(file));
      const taken = new Set((await store.listProfiles()).map((x) => x.id));
      let id = p.id;
      for (let i = 2; taken.has(id); i++) id = `${p.id}-${i}`;
      return store.saveProfile({ ...p, id }, 'import');
    },
    async reveal() {
      await shell.openPath(await store.profilesDir());
    },
  },
  coach: {
    async extract(sources, name, kind, language) {
      const takenIds = (await store.listProfiles()).map((p) => p.id);
      return extractProfile(await llm(), sources, { name, kind, language, takenIds });
    },
    diff: async (current, incoming) => diffProfiles(current, incoming),
    checkStyle: async (req) => checkStyle(await llm(), req),
    editFeedback: async (req) => editFeedback(await llm(), req),
    blendConflicts: async (p) => findBlendConflicts(await llm(), p),
  },
  grammar: {
    check: async (text, language) => checkGrammar(text, (await store.getSettings()).grammar, language),
  },
  providers: {
    status: async () => providerStatus(await store.getSettings()),
    login: async () => providerLogin(await store.getSettings()),
    async test() {
      const reply = await (await llm()).complete({ system: 'Reply with JSON only.', prompt: 'Return {"ok": true}.', tier: 'fast', maxTokens: 50 });
      return reply.trim().slice(0, 200);
    },
  },
  files: {
    async pickSources() {
      const { canceled, filePaths } = await dialog.showOpenDialog(win(), { properties: ['openFile', 'multiSelections'], filters: TEXT_FILTERS });
      if (canceled) return [];
      const docs: SourceDoc[] = [];
      for (const f of filePaths) docs.push({ name: basename(f).replace(/\.[^.]+$/, ''), text: await readFile(f, 'utf8') });
      return docs;
    },
    async openDocument() {
      const { canceled, filePaths } = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters: TEXT_FILTERS });
      const f = filePaths[0];
      if (canceled || !f) return null;
      return { path: f, name: basename(f), text: await readFile(f, 'utf8') };
    },
    async saveDocument(path, text) {
      let target = path;
      if (!target) {
        const r = await dialog.showSaveDialog(win(), { defaultPath: 'untitled.md', filters: TEXT_FILTERS });
        if (r.canceled || !r.filePath) return null;
        target = r.filePath;
      }
      await writeFile(target, text);
      return target;
    },
  },
};

// Expose every backend method over IPC as "<group>:<method>".
for (const [group, methods] of Object.entries(backend)) {
  for (const [name, fn] of Object.entries(methods as Record<string, (...a: unknown[]) => Promise<unknown>>)) {
    ipcMain.handle(channel(group, name), async (_e, ...args) => fn(...args));
  }
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Gorgias',
    backgroundColor: '#14161a',
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
