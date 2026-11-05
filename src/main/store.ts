// Settings and profiles on disk. Profiles are plain .md files in a folder you
// can point anywhere (e.g. shared with other tools or under git). Every save
// snapshots the previous version into .history/<id>/ for rollback.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProfile, serializeProfile } from '@shared/profile/markdown';
import { touch } from '@shared/profile/model';
import type { ProfileSummary, Snapshot } from '@shared/api';
import type { Settings, TasteProfile } from '@shared/types';

const MAX_SNAPSHOTS = 50;

export function defaultSettings(userData: string): Settings {
  return {
    provider: 'claude-cli',
    anthropic: { apiKey: '', fastModel: 'claude-haiku-5-5', strongModel: 'claude-sonnet-5-5' },
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', fastModel: '', strongModel: '' },
    claudeCli: { binary: 'claude', fastModel: 'haiku', strongModel: 'sonnet' },
    codexCli: { binary: 'codex', model: '' },
    grammar: { engine: 'languagetool', languageToolUrl: 'http://localhost:8081', language: 'auto', harperDialect: 'british' },
    profilesDir: join(userData, 'profiles'),
    activeGeneralProfile: null,
    activeProjectProfile: null,
    mode: 'assistant',
    dictionary: [],
    styleDebounceMs: 2500,
    grammarDebounceMs: 700,
  };
}

/** Secrets are encrypted with the OS keychain when available. */
export interface SecretBox {
  available(): boolean;
  encrypt(s: string): string;
  decrypt(s: string): string;
}

const SECRET_PATHS: [keyof Settings, string][] = [
  ['anthropic', 'apiKey'],
  ['openai', 'apiKey'],
];

export class Store {
  private settingsCache: Settings | null = null;

  constructor(
    private userData: string,
    private secrets: SecretBox,
  ) {}

  private get settingsFile() {
    return join(this.userData, 'settings.json');
  }

  async getSettings(): Promise<Settings> {
    if (this.settingsCache) return this.settingsCache;
    const defaults = defaultSettings(this.userData);
    let stored: any = {};
    try {
      stored = JSON.parse(await readFile(this.settingsFile, 'utf8'));
    } catch {
      /* first run */
    }
    const merged: any = { ...defaults, ...stored };
    for (const key of Object.keys(defaults) as (keyof Settings)[]) {
      const d = defaults[key];
      if (d && typeof d === 'object' && !Array.isArray(d)) merged[key] = { ...d, ...(stored[key] ?? {}) };
    }
    for (const [group, field] of SECRET_PATHS) {
      const v = merged[group][field];
      if (typeof v === 'string' && v.startsWith('enc:')) {
        try {
          merged[group][field] = this.secrets.decrypt(v.slice(4));
        } catch {
          merged[group][field] = '';
        }
      }
    }
    this.settingsCache = merged as Settings;
    return this.settingsCache;
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings();
    const next: any = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      const cur = (current as any)[k];
      next[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? { ...cur, ...v } : v;
    }
    this.settingsCache = next;
    const onDisk = structuredClone(next);
    if (this.secrets.available()) {
      for (const [group, field] of SECRET_PATHS) {
        const v = onDisk[group][field];
        if (v) onDisk[group][field] = 'enc:' + this.secrets.encrypt(v);
      }
    }
    await mkdir(this.userData, { recursive: true });
    await atomicWrite(this.settingsFile, JSON.stringify(onDisk, null, 2));
    return next;
  }

  private async dir(): Promise<string> {
    const d = (await this.getSettings()).profilesDir;
    await mkdir(d, { recursive: true });
    return d;
  }

  private async historyDir(id: string): Promise<string> {
    const d = join(await this.dir(), '.history', id);
    await mkdir(d, { recursive: true });
    return d;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const dir = await this.dir();
    const out: ProfileSummary[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const p = parseProfile(await readFile(join(dir, f), 'utf8'), f.slice(0, -3));
        out.push({ id: f.slice(0, -3), name: p.name, kind: p.kind, moves: p.moves.length, updated: p.updated });
      } catch {
        /* skip unreadable files */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Profile ids are file stems; the id inside the file is kept in sync on save. */
  async getProfile(id: string): Promise<TasteProfile> {
    const file = join(await this.dir(), `${safeId(id)}.md`);
    const p = parseProfile(await readFile(file, 'utf8'), id);
    return { ...p, id };
  }

  async saveProfile(profile: TasteProfile, reason: string): Promise<TasteProfile> {
    const dir = await this.dir();
    const id = safeId(profile.id);
    const file = join(dir, `${id}.md`);
    if (existsSync(file)) await this.snapshot(id, await readFile(file, 'utf8'), reason);
    const saved = touch({ ...profile, id });
    await atomicWrite(file, serializeProfile(saved));
    return saved;
  }

  async removeProfile(id: string): Promise<void> {
    const dir = await this.dir();
    const file = join(dir, `${safeId(id)}.md`);
    if (existsSync(file)) {
      await this.snapshot(safeId(id), await readFile(file, 'utf8'), 'before delete');
      await rm(file);
    }
  }

  private async snapshot(id: string, content: string, reason: string) {
    const hd = await this.historyDir(id);
    const at = new Date().toISOString();
    const snapId = at.replace(/[:.]/g, '-');
    await writeFile(join(hd, `${snapId}.md`), content);
    const log = await this.readLog(id);
    log.push({ id: snapId, at, reason });
    while (log.length > MAX_SNAPSHOTS) {
      const old = log.shift()!;
      await rm(join(hd, `${old.id}.md`), { force: true });
    }
    await atomicWrite(join(hd, 'log.json'), JSON.stringify(log, null, 2));
  }

  private async readLog(id: string): Promise<Snapshot[]> {
    try {
      return JSON.parse(await readFile(join(await this.historyDir(id), 'log.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  async history(id: string): Promise<Snapshot[]> {
    return (await this.readLog(safeId(id))).slice().reverse();
  }

  async readSnapshot(id: string, snapId: string): Promise<TasteProfile> {
    const text = await readFile(join(await this.historyDir(safeId(id)), `${safeId(snapId)}.md`), 'utf8');
    return { ...parseProfile(text, id), id };
  }

  async rollback(id: string, snapId: string): Promise<TasteProfile> {
    const p = await this.readSnapshot(id, snapId);
    return this.saveProfile(p, `before rollback to ${snapId}`);
  }

  async profilesDir(): Promise<string> {
    return this.dir();
  }
}

function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!s) throw new Error('Invalid id');
  return s;
}

async function atomicWrite(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}
