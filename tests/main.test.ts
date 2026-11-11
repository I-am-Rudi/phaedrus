import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkGrammar } from '../src/main/grammar';
import { createLLM, errorReason, RETRY_DELAYS_MS } from '../src/main/providers';
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
    const argsSeen = join(dir, 'claude-args.txt');
    await writeFile(
      fake,
      `#!/bin/sh
cat > "${seen}"
printf '%s\\n' "$@" > "${argsSeen}"
case "$*" in *"-p --output-format json --model haiku"*) ;; *) echo "wrong args: $*" >&2; exit 2;; esac
echo '{"type":"result","is_error":false,"result":"{\\"ok\\": true}"}'`,
    );
    await chmod(fake, 0o755);
    const settings = { ...defaultSettings(dir), provider: 'claude-cli' as const };
    settings.claudeCli = { ...settings.claudeCli, binary: fake };
    const out = await createLLM(settings, dir).complete({ system: 'SYSTEM', prompt: 'hello', tier: 'fast' });
    expect(out).toBe('{"ok": true}');
    const stdin = await import('node:fs/promises').then((fs) => fs.readFile(seen, 'utf8'));
    // Lean call: our system prompt as a flag, the prompt alone on stdin, no tools, MCP, skills or user settings.
    expect(stdin).toBe('hello');
    const args = await import('node:fs/promises').then((fs) => fs.readFile(argsSeen, 'utf8'));
    expect(args.split('\n')).toEqual(expect.arrayContaining(['--system-prompt', 'SYSTEM', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project', '--no-session-persistence']));
  });

  it('claude -p: falls back to a plain call when the CLI rejects the lean flags', async () => {
    const fake = join(dir, 'fake-claude-old');
    const seen = join(dir, 'claude-old-stdin.txt');
    await writeFile(
      fake,
      `#!/bin/sh
case "$*" in *--system-prompt*) cat >/dev/null; echo "error: unknown option '--system-prompt'" >&2; exit 1;; esac
cat > "${seen}"
echo '{"type":"result","is_error":false,"result":"plain"}'`,
    );
    await chmod(fake, 0o755);
    const settings = { ...defaultSettings(dir), provider: 'claude-cli' as const };
    settings.claudeCli = { ...settings.claudeCli, binary: fake };
    const llm = createLLM(settings, dir);
    expect(await llm.complete({ system: 'S', prompt: 'p', tier: 'fast' })).toBe('plain');
    const stdin = await import('node:fs/promises').then((fs) => fs.readFile(seen, 'utf8'));
    expect(stdin).toBe('S\n\n---\n\np');
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

describe('OpenAI-compatible endpoints', () => {
  /** A stand-in server: each request gets the next canned reply; the last one repeats. */
  async function serve(replies: { status: number; body: string; type?: string; headers?: Record<string, string> }[]) {
    let n = 0;
    const server = createServer((_req, res) => {
      const r = replies[Math.min(n++, replies.length - 1)]!;
      res.writeHead(r.status, { 'content-type': r.type ?? 'application/json', ...r.headers });
      res.end(r.body);
    });
    await new Promise<void>((ok) => server.listen(0, ok));
    const settings = defaultSettings(dir);
    settings.provider = 'openai';
    settings.openai = { ...settings.openai, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/`, fastModel: 'qwen' };
    return { llm: createLLM(settings, dir), requests: () => n, close: () => server.close() };
  }
  const ask = (llm: ReturnType<typeof createLLM>) => llm.complete({ system: 's', prompt: 'p', tier: 'fast' });
  const ok = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'fine' } }] }) };
  const nginx503 = { status: 503, type: 'text/html', body: '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>' };
  const saved = [...RETRY_DELAYS_MS];
  beforeAll(() => RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 5, 10));
  afterAll(() => RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, ...saved));

  it('retries a brief 503 and succeeds', async () => {
    const s = await serve([nginx503, { ...nginx503, headers: { 'retry-after': '0' } }, ok]);
    expect(await ask(s.llm)).toBe('fine');
    expect(s.requests()).toBe(3);
    s.close();
  });

  it("shows a gateway's HTML reason after three tries, with a hint", async () => {
    const s = await serve([nginx503]);
    const err = await ask(s.llm).catch((e: Error) => e.message);
    s.close();
    expect(err).toMatch(/\/v1\/chat\/completions → 503: 503 Service Temporarily Unavailable/);
    expect(err).toContain('nginx');
    expect(err).toContain('tried 3 times');
    expect(err).toContain('GPUStack');
    expect(s.requests()).toBe(3);
  });

  it("shows GPUStack's reasons in both of its formats", async () => {
    let s = await serve([{ status: 503, body: JSON.stringify({ error: { message: 'No running instances available', code: 503, type: 'ServiceUnavailable' } }) }]);
    expect(await ask(s.llm).catch((e: Error) => e.message)).toContain('No running instances available');
    s.close();
    s = await serve([{ status: 503, body: JSON.stringify({ code: 503, reason: 'Service Unavailable', message: 'Worker 3 is not ready' }) }]);
    expect(await ask(s.llm).catch((e: Error) => e.message)).toContain('Worker 3 is not ready');
    s.close();
  });

  it('does not retry other errors, and hints at the likely fix', async () => {
    const s = await serve([{ status: 404, body: '{"detail":"Not Found"}' }]);
    const err = await ask(s.llm).catch((e: Error) => e.message);
    expect(s.requests()).toBe(1);
    s.close();
    expect(err).toContain('404: Not Found. Check the base URL');
  });

  it('reads the reason from any common error format', () => {
    expect(errorReason('{"error":{"message":"bad key"}}')).toBe('bad key');
    expect(errorReason('{"error":"bad key"}')).toBe('bad key');
    expect(errorReason('{"message":"Worker not ready"}')).toBe('Worker not ready');
    expect(errorReason('{"detail":[{"loc":["body","model"],"msg":"field required"}]}')).toContain('field required');
    expect(errorReason('<html><style>p{}</style><p>Down&nbsp;for maintenance</p></html>')).toBe('Down for maintenance');
    expect(errorReason('{}')).toBe('');
    expect(errorReason('')).toBe('');
  });
});
