import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkGrammar } from '../src/main/grammar';
import { createLLM } from '../src/main/providers';
import { defaultSettings, Store } from '../src/main/store';
import { newMove, newProfile } from '@shared/profile/model';

const plainSecrets = { available: () => true, encrypt: (s: string) => Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s, 'base64').toString() };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phaedrus-test-'));
});

describe('store', () => {
  it('persists settings with encrypted keys', async () => {
    const s = new Store(join(dir, 'a'), plainSecrets);
    await s.setSettings({ anthropic: { apiKey: 'sk-secret', fastModel: 'f', strongModel: 's' } });
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'a', 'settings.json'), 'utf8'));
    expect(raw).not.toContain('sk-secret');
    const fresh = new Store(join(dir, 'a'), plainSecrets);
    expect((await fresh.getSettings()).anthropic.apiKey).toBe('sk-secret');
    expect((await fresh.getSettings()).grammar.engine).toBe('languagetool');
  });

  it('saves profiles, snapshots each change and rolls back', async () => {
    const s = new Store(join(dir, 'b'), plainSecrets);
    const p = newProfile('Feynman');
    p.moves = [newMove({ title: 'Short openers' })];
    await s.saveProfile(p, 'create');
    await s.saveProfile({ ...p, moves: [] }, 'cleared moves');
    expect((await s.listProfiles()).map((x) => [x.id, x.moves])).toEqual([['feynman', 0]]);
    const hist = await s.history('feynman');
    expect(hist).toHaveLength(1);
    expect(hist[0]!.reason).toBe('cleared moves');
    const restored = await s.rollback('feynman', hist[0]!.id);
    expect(restored.moves).toHaveLength(1);
    expect(await s.history('feynman')).toHaveLength(2);
  });
});

describe('grammar engines', () => {
  it('harper finds spelling and grammar, maps offsets to UTF-16', async () => {
    const cfg = { ...defaultSettings(dir).grammar, engine: 'harper' as const };
    const text = '😀😀 Their going to the store with mispeled words.';
    const issues = await checkGrammar(text, cfg);
    const byCat = Object.fromEntries(issues.map((i) => [i.text, i.category]));
    expect(byCat).toMatchObject({ Their: 'grammar', mispeled: 'spelling' });
    for (const i of issues) expect(text.slice(i.from, i.to)).toBe(i.text);
  });

  it('languagetool adapter maps matches and skips style issues', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          matches: [
            { offset: 0, length: 4, message: 'Spelling', replacements: [{ value: 'Hello' }], rule: { id: 'MORFOLOGIK', issueType: 'misspelling' } },
            { offset: 5, length: 3, message: 'Agreement', replacements: [], rule: { id: 'AGR', issueType: 'grammar' } },
            { offset: 5, length: 3, message: 'Wordy', replacements: [], rule: { id: 'WORDY', issueType: 'style' } },
          ],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const cfg = { ...defaultSettings(dir).grammar, languageToolUrl: `http://127.0.0.1:${port}` };
    const issues = await checkGrammar('Helo are you', cfg);
    server.close();
    expect(issues.map((i) => [i.category, i.text, i.ruleId])).toEqual([
      ['spelling', 'Helo', 'MORFOLOGIK'],
      ['grammar', 'are', 'AGR'],
    ]);
  });

  it('explains when languagetool is down', async () => {
    const cfg = { ...defaultSettings(dir).grammar, languageToolUrl: 'http://127.0.0.1:1' };
    await expect(checkGrammar('text', cfg)).rejects.toThrow(/not reachable/);
  });
});

describe('CLI providers', () => {
  it('claude -p: sends system+prompt on stdin and reads the JSON result', async () => {
    const fake = join(dir, 'fake-claude');
    const seen = join(dir, 'claude-stdin.txt');
    await writeFile(
      fake,
      `#!/bin/sh
cat > "${seen}"
case "$*" in *"-p --output-format json --model haiku"*) ;; *) echo "wrong args: $*" >&2; exit 2;; esac
echo '{"type":"result","is_error":false,"result":"{\\"ok\\": true}"}'`,
    );
    await chmod(fake, 0o755);
    const settings = { ...defaultSettings(dir), provider: 'claude-cli' as const };
    settings.claudeCli = { ...settings.claudeCli, binary: fake };
    const out = await createLLM(settings, dir).complete({ system: 'SYSTEM', prompt: 'hello', tier: 'fast' });
    expect(out).toBe('{"ok": true}');
    const stdin = await import('node:fs/promises').then((fs) => fs.readFile(seen, 'utf8'));
    expect(stdin).toBe('SYSTEM\n\n---\n\nhello');
  });

  it('claude -p: turns auth failures into a sign-in hint', async () => {
    const fake = join(dir, 'fake-claude-noauth');
    await writeFile(fake, `#!/bin/sh\ncat >/dev/null\necho '{"type":"result","is_error":true,"result":"authentication_failed"}'\nexit 1\n`);
    await chmod(fake, 0o755);
    const settings = { ...defaultSettings(dir), provider: 'claude-cli' as const };
    settings.claudeCli = { ...settings.claudeCli, binary: fake };
    await expect(createLLM(settings, dir).complete({ system: 's', prompt: 'p', tier: 'fast' })).rejects.toThrow(/not signed in/);
  });

  it('codex exec: reads the last message file', async () => {
    const fake = join(dir, 'fake-codex');
    await writeFile(
      fake,
      `#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do if [ "$1" = "--output-last-message" ]; then out="$2"; fi; shift; done
echo '{"ok": true}' > "$out"`,
    );
    await chmod(fake, 0o755);
    const settings = { ...defaultSettings(dir), provider: 'codex-cli' as const };
    settings.codexCli = { binary: fake, model: '' };
    expect((await createLLM(settings, dir).complete({ system: 's', prompt: 'p', tier: 'strong' })).trim()).toBe('{"ok": true}');
  });
});
