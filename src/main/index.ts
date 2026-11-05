import { cpSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import { channel, type Backend } from '@shared/api';
import { checkStyle, checkStyleBatch, editFeedback, extractProfile, extractRules, findBlendConflicts } from '@shared/coach';
import { applyRuleEvent, parseRuleSet, serializeRuleSet } from '@shared/rules';
import { diffProfiles } from '@shared/profile/diff';
import { exportBundle, exportMarkdown, importProfile } from '@shared/profile/exchange';
import { applyEvent } from '@shared/profile/feedback';
import type { SourceDoc } from '@shared/types';
import { checkGrammar } from './grammar';
import { readSource, SOURCE_EXTENSIONS } from './documents';
import { createLLM, providerLogin, providerStatus, transcribePdf } from './providers';
import { Store } from './store';

migrateFromGorgias();

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

/** The app was called Gorgias before; carry its settings and profiles over once. */
function migrateFromGorgias() {
  const target = app.getPath('userData');
  if (existsSync(join(target, 'settings.json'))) return;
  for (const name of ['Gorgias', 'gorgias']) {
    const old = join(app.getPath('appData'), name);
    if (!existsSync(join(old, 'settings.json'))) continue;
    mkdirSync(target, { recursive: true });
    cpSync(join(old, 'settings.json'), join(target, 'settings.json'));
    // Profiles kept in the default folder move along; a custom profiles folder stays where it is.
    if (existsSync(join(old, 'profiles'))) cpSync(join(old, 'profiles'), join(target, 'profiles'), { recursive: true });
    try {
      const settingsFile = join(target, 'settings.json');
      const raw = readFileSync(settingsFile, 'utf8');
      writeFileSync(settingsFile, raw.split(join(old, 'profiles')).join(join(target, 'profiles')));
    } catch {
      /* keep the copy as is */
    }
    return;
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

// ------------------------------------------------- watching the open file
// Polling by path (fs.watchFile) also sees editors that save by writing a new
// file and renaming it over the old one, which vim and most IDEs do.

let watched: string | null = null;
const onWatched = (curr: Stats, prev: Stats) => {
  if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
  const path = watched;
  if (!path) return;
  void readFile(path, 'utf8')
    .catch(() => null)
    .then((text) => {
      if (watched !== path) return;
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('files:changed', { path, text });
    });
};
function watchDocument(path: string | null) {
  if (watched) unwatchFile(watched, onWatched);
  watched = path;
  if (path) watchFile(path, { interval: 800 }, onWatched);
}

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
  rules: {
    list: () => store.listRuleSets(),
    get: (id) => store.getRuleSet(id),
    save: (s, reason) => store.saveRuleSet(s, reason),
    remove: (id) => store.removeRuleSet(id),
    async applyEvent(setId, ev) {
      const cur = await store.getRuleSet(setId);
      const next = applyRuleEvent(cur, ev);
      return next === cur ? cur : store.saveRuleSet(next, `auto ${ev.type}`);
    },
    async exportTo(id) {
      const s = await store.getRuleSet(id);
      const { canceled, filePath } = await dialog.showSaveDialog(win(), { defaultPath: `${s.id}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (canceled || !filePath) return null;
      await writeFile(filePath, serializeRuleSet(s));
      return filePath;
    },
    async importFrom() {
      const { canceled, filePaths } = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters: [{ name: 'Rules', extensions: ['md'] }] });
      const f = filePaths[0];
      if (canceled || !f) return null;
      const s = parseRuleSet(await readFile(f, 'utf8'), basename(f).replace(/\.md$/, ''));
      const taken = new Set((await store.listRuleSets()).map((x) => x.id));
      let id = s.id;
      for (let i = 2; taken.has(id); i++) id = `${s.id}-${i}`;
      return store.saveRuleSet({ ...s, id }, 'import');
    },
  },
  coach: {
    extractRules: async (docs, takenIds) => extractRules(await llm(), docs, { takenIds }),
    async extract(sources, name, kind, language) {
      const takenIds = (await store.listProfiles()).map((p) => p.id);
      return extractProfile(await llm(), sources, { name, kind, language, takenIds });
    },
    diff: async (current, incoming) => diffProfiles(current, incoming),
    checkStyle: async (req) => checkStyle(await llm(), req),
    checkStyleBatch: async (req) => checkStyleBatch(await llm(), req),
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
      const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documents', extensions: SOURCE_EXTENSIONS }],
      });
      if (canceled) return [];
      const docs: SourceDoc[] = [];
      for (const f of filePaths) {
        try {
          const r = await readSource(f);
          if (!r.needsOcr) {
            docs.push(r.doc);
            continue;
          }
          // Scanned PDF: let the model read it.
          try {
            const text = await transcribePdf(await store.getSettings(), f, cliWorkDir);
            docs.push({ ...r.doc, text, warning: 'Scanned PDF, text read by the model. Check it before extracting.' });
          } catch (e) {
            docs.push({ ...r.doc, text: '', warning: (e as Error).message });
          }
        } catch (e) {
          docs.push({ name: basename(f), text: '', warning: `Could not read this file: ${(e as Error).message}` });
        }
      }
      return docs;
    },
    async openDocument(path) {
      let f = path ? expandHome(path) : undefined;
      if (!f) {
        const { canceled, filePaths } = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters: TEXT_FILTERS });
        if (canceled || !filePaths[0]) return null;
        f = filePaths[0];
      }
      const text = await readFile(f, 'utf8');
      await store.addRecent(f);
      return { path: f, name: basename(f), text };
    },
    async saveDocument(path, text, opts = {}) {
      let target = path ? expandHome(path) : null;
      if (!target || opts.saveAs) {
        const r = await dialog.showSaveDialog(win(), { defaultPath: target ?? 'untitled.md', filters: TEXT_FILTERS });
        if (r.canceled || !r.filePath) return null;
        target = r.filePath;
      } else if (opts.base !== undefined) {
        // Changed by another program since we read it? Then do not overwrite silently.
        let current: string | null = null;
        try {
          current = await readFile(target, 'utf8');
        } catch {
          current = null;
        }
        if (current !== null && current !== opts.base) return { conflict: current };
      }
      await writeFile(target, text);
      await store.addRecent(target);
      return { path: target };
    },
    recent: () => store.recentFiles(),
    forgetRecent: (path) => store.removeRecent(path),
    async watch(path) {
      watchDocument(path ? expandHome(path) : null);
    },
  },
};

// Expose every backend method over IPC as "<group>:<method>".
for (const [group, methods] of Object.entries(backend)) {
  for (const [name, fn] of Object.entries(methods as Record<string, (...a: unknown[]) => Promise<unknown>>)) {
    ipcMain.handle(channel(group, name), async (_e, ...args) => fn(...args));
  }
}

/**
 * The default Electron menu binds Ctrl+W (close window) and Ctrl+R (reload) on
 * Linux and Windows, which would swallow vim's Ctrl-w and Ctrl-r. This menu keeps
 * the usual entries but puts reload on F5 and leaves Ctrl+W and Ctrl+R to the page.
 */
function menuCommand(command: string) {
  win()?.webContents.send('menu:command', command);
}

function setMenu() {
  const mac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        // The page handles these keys itself (they also work in the browser preview);
        // the menu only shows them.
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => menuCommand('e') },
        { label: 'Open Recent…', click: () => menuCommand('recent') },
        { label: 'Reload from Disk', click: () => menuCommand('e!') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => menuCommand('w') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', registerAccelerator: false, click: () => menuCommand('saveas') },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit', accelerator: 'Ctrl+Q' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'F5' },
        { role: 'toggleDevTools', accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, ...(mac ? [{ role: 'zoom' as const }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Phaedrus',
    backgroundColor: '#fafafa',
    // macOS: no title bar; the window buttons sit in the top of the side rail
    // and the app's own top bar is the drag area.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 15 } } : {}),
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true },
  });
  // Ask the page before closing, so unsaved work can be saved. If the page does
  // not answer (it failed to load or crashed), close anyway after a moment.
  let closeOk = false;
  w.on('close', (e) => {
    if (closeOk || w.webContents.isCrashed()) return;
    e.preventDefault();
    let acked = false;
    const onAck = (ev: Electron.IpcMainEvent) => ev.sender === w.webContents && (acked = true);
    ipcMain.on('app:close-ack', onAck);
    w.webContents.send('app:close-requested');
    setTimeout(() => {
      ipcMain.removeListener('app:close-ack', onAck);
      if (!acked) {
        closeOk = true;
        if (quitting) app.quit();
        else w.close();
      }
    }, 1500);
  });
  const onAnswer = (ok: boolean) => (ev: Electron.IpcMainEvent) => {
    if (ev.sender !== w.webContents) return;
    if (!ok) {
      quitting = false;
      return;
    }
    closeOk = true;
    if (quitting) app.quit();
    else w.close();
  };
  const okHandler = onAnswer(true);
  const cancelHandler = onAnswer(false);
  ipcMain.on('app:close-ok', okHandler);
  ipcMain.on('app:close-cancel', cancelHandler);
  w.on('closed', () => {
    ipcMain.removeListener('app:close-ok', okHandler);
    ipcMain.removeListener('app:close-cancel', cancelHandler);
  });
  // In full screen macOS hides the window buttons; the layout drops their space.
  w.on('enter-full-screen', () => w.webContents.send('window:fullscreen', true));
  w.on('leave-full-screen', () => w.webContents.send('window:fullscreen', false));
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  await store.seedDefaults().catch((e) => console.error('Could not add the built-in rule sets:', e));
  setMenu();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});
