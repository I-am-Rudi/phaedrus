import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/main/store';

const plain = { available: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };

describe('recent files', () => {
  it('keeps the most recent first, without duplicates, and survives a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phaedrus-recent-'));
    const s = new Store(dir, plain);
    expect(await s.recentFiles()).toEqual([]);
    await s.addRecent('/a.tex');
    await s.addRecent('/b.md');
    await s.addRecent('/a.tex');
    expect(await s.recentFiles()).toEqual(['/a.tex', '/b.md']);
    expect(await new Store(dir, plain).recentFiles()).toEqual(['/a.tex', '/b.md']);
    await s.removeRecent('/a.tex');
    expect(await s.recentFiles()).toEqual(['/b.md']);
  });

  it('holds at most twelve', async () => {
    const s = new Store(await mkdtemp(join(tmpdir(), 'phaedrus-recent-')), plain);
    for (let i = 0; i < 15; i++) await s.addRecent(`/f${i}.tex`);
    const list = await s.recentFiles();
    expect(list).toHaveLength(12);
    expect(list[0]).toBe('/f14.tex');
  });
});
