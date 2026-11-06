import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.SHELL = saved.SHELL;
  vi.resetModules();
});

describe.skipIf(process.platform === 'win32')('finding the CLIs from a GUI launch', () => {
  it('takes PATH from the login shell, skipping what its rc files print, and finds the binary there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phaedrus-path-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'fakecli'), '#!/bin/sh\necho ok\n');
    chmodSync(join(bin, 'fakecli'), 0o755);
    // A stand-in login shell: rc noise first, then PATH between the markers.
    const shell = join(dir, 'fake-shell');
    writeFileSync(shell, `#!/bin/sh\necho "Welcome back"\nprintf '__PHAEDRUS_PATH__%s__PHAEDRUS_PATH__' "${bin}:/usr/bin"\n`);
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    process.env.PATH = '/usr/bin:/bin'; // what Finder hands an app

    const { resolveBinary, run } = await import('../src/main/exec');
    expect(await resolveBinary('fakecli')).toBe(join(bin, 'fakecli'));
    expect(process.env.PATH!.split(':')).toContain(bin);
    expect(process.env.PATH!.split(':')).toContain('/bin'); // the original entries stay
    expect((await run('fakecli', [])).stdout.trim()).toBe('ok');
  });

  it('keeps the bare name when nothing is found, and leaves explicit paths alone', async () => {
    process.env.SHELL = '/nonexistent/shell';
    const { resolveBinary } = await import('../src/main/exec');
    expect(await resolveBinary('surely-not-installed-xyz')).toBe('surely-not-installed-xyz');
    expect(await resolveBinary('/opt/tools/claude')).toBe('/opt/tools/claude');
  });
});
