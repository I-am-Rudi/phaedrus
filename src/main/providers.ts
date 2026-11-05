// LLM backends. Two kinds:
//  - API keys: Anthropic, or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Ollama, ...)
//  - Subscriptions via the official CLIs running headless: `claude -p` and `codex exec`,
//    which use whatever login those tools already have.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLM, LLMRequest } from '@shared/coach';
import type { ProviderId, Settings } from '@shared/types';
import { run, runDetachedLogin } from './exec';

export function createLLM(settings: Settings, workDir: string): LLM {
  switch (settings.provider) {
    case 'anthropic':
      return anthropic(settings.anthropic);
    case 'openai':
      return openaiCompatible(settings.openai);
    case 'claude-cli':
      return claudeCli(settings.claudeCli, workDir);
    case 'codex-cli':
      return codexCli(settings.codexCli, workDir);
  }
}

/** Fold the system prompt into the user prompt for backends without a separate system field. */
const combined = (r: LLMRequest) => `${r.system}\n\n---\n\n${r.prompt}`;

function anthropic(cfg: Settings['anthropic']): LLM {
  return {
    async complete(r) {
      if (!cfg.apiKey) throw new Error('Add an Anthropic API key in Settings.');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: r.tier === 'strong' ? cfg.strongModel : cfg.fastModel,
          max_tokens: r.maxTokens ?? 2000,
          system: r.system,
          messages: [{ role: 'user', content: r.prompt }],
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? res.statusText}`);
      return (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    },
  };
}

function openaiCompatible(cfg: Settings['openai']): LLM {
  return {
    async complete(r) {
      const model = r.tier === 'strong' ? cfg.strongModel || cfg.fastModel : cfg.fastModel || cfg.strongModel;
      if (!model) throw new Error('Set a model for the OpenAI-compatible provider in Settings.');
      const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: r.system },
            { role: 'user', content: r.prompt },
          ],
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${url} → ${res.status}: ${body?.error?.message ?? res.statusText}`);
      return body.choices?.[0]?.message?.content ?? '';
    },
  };
}

/**
 * Flags that keep each `claude -p` call small and fast while still using the
 * subscription login (`--bare` would be faster but requires an API key):
 * our own system prompt instead of Claude Code's, no built-in tools, none of
 * the user's MCP servers, skills, hooks or plugins, and no saved session.
 */
export function leanClaudeArgs(system: string): string[] {
  return [
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--setting-sources', 'project',
    '--no-session-persistence',
  ];
}

/** Per binary: false once an older CLI rejected the lean flags. */
const leanSupported = new Map<string, boolean>();

function claudeCli(cfg: Settings['claudeCli'], workDir: string): LLM {
  return {
    async complete(r) {
      const model = r.tier === 'strong' ? cfg.strongModel : cfg.fastModel;
      const bin = cfg.binary || 'claude';
      const base = ['-p', '--output-format', 'json'];
      if (model) base.push('--model', model);
      // Run in an empty folder so no project CLAUDE.md or files leak into the prompt.
      const lean = leanSupported.get(bin) !== false;
      let res = await run(bin, lean ? [...base, ...leanClaudeArgs(r.system)] : base, {
        input: lean ? r.prompt : combined(r),
        cwd: workDir,
        timeoutMs: 240_000,
      });
      if (lean && res.code !== 0 && /unknown option|unrecognized|invalid option|error: option/i.test(res.stderr)) {
        leanSupported.set(bin, false);
        res = await run(bin, base, { input: combined(r), cwd: workDir, timeoutMs: 240_000 });
      } else if (lean && res.code === 0) {
        leanSupported.set(bin, true);
      }
      let parsed: any = null;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        /* not JSON */
      }
      if (parsed?.is_error || res.code !== 0) {
        const msg = String(parsed?.result ?? parsed?.error ?? res.stderr ?? res.stdout).trim();
        if (/auth|log ?in|credential/i.test(msg)) throw new Error('Claude Code is not signed in. Use "Sign in" in Settings.');
        throw new Error(`claude exited with ${res.code}: ${msg.slice(0, 400)}`);
      }
      return typeof parsed?.result === 'string' ? parsed.result : res.stdout;
    },
  };
}

function codexCli(cfg: Settings['codexCli'], workDir: string): LLM {
  return {
    async complete(r) {
      const dir = await mkdtemp(join(tmpdir(), 'phaedrus-codex-'));
      const outFile = join(dir, 'last-message.txt');
      try {
        const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', outFile];
        if (cfg.model) args.push('--model', cfg.model);
        args.push('-');
        const res = await run(cfg.binary || 'codex', args, { input: combined(r), cwd: workDir, timeoutMs: 300_000 });
        const out = await readFile(outFile, 'utf8').catch(() => '');
        if (!out.trim()) {
          const msg = (res.stderr || res.stdout).trim();
          if (/log ?in|auth/i.test(msg)) throw new Error('Codex is not signed in. Use "Sign in" in Settings.');
          throw new Error(`codex exited with ${res.code}: ${msg.slice(-400)}`);
        }
        return out;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface ProviderStatus {
  id: ProviderId;
  ok: boolean;
  detail: string;
}

export async function providerStatus(settings: Settings): Promise<ProviderStatus> {
  const id = settings.provider;
  try {
    if (id === 'anthropic') return { id, ok: !!settings.anthropic.apiKey, detail: settings.anthropic.apiKey ? 'API key set' : 'No API key' };
    if (id === 'openai') {
      const ok = !!(settings.openai.fastModel || settings.openai.strongModel);
      return { id, ok, detail: ok ? settings.openai.baseUrl : 'No model set' };
    }
    const bin = id === 'claude-cli' ? settings.claudeCli.binary || 'claude' : settings.codexCli.binary || 'codex';
    const res = await run(bin, ['--version'], { timeoutMs: 15_000 });
    return { id, ok: res.code === 0, detail: (res.stdout || res.stderr).trim().split('\n')[0] ?? '' };
  } catch (e) {
    return { id, ok: false, detail: (e as Error).message };
  }
}

/** Trigger the CLI's own browser sign-in. */
export async function providerLogin(settings: Settings): Promise<string> {
  if (settings.provider === 'claude-cli') {
    const r = await runDetachedLogin(settings.claudeCli.binary || 'claude', ['auth', 'login']);
    return (r.stdout || r.stderr).trim() || 'Done.';
  }
  if (settings.provider === 'codex-cli') {
    const r = await runDetachedLogin(settings.codexCli.binary || 'codex', ['login']);
    return (r.stdout || r.stderr).trim() || 'Done.';
  }
  return 'This provider uses an API key; no sign-in needed.';
}

const TRANSCRIBE = `Transcribe the running text of this document verbatim, in reading order.
Separate paragraphs with a blank line. Leave out page numbers, running headers and footers, and the contents of figures and tables.
Write mathematics as LaTeX between $...$ (inline) or $$...$$ (displayed). Output only the transcription.`;

const MAX_PDF_BYTES = 32 * 1024 * 1024;

/**
 * Let the model read a PDF that has no text layer (scanned pages). Supported for
 * the Claude CLI (it reads the file itself) and the Anthropic API (PDF input).
 */
export async function transcribePdf(settings: Settings, file: string, workDir: string): Promise<string> {
  const data = await readFile(file);
  if (data.length > MAX_PDF_BYTES) throw new Error('The PDF is larger than 32 MB; split it or export its text first.');
  if (settings.provider === 'anthropic') {
    const cfg = settings.anthropic;
    if (!cfg.apiKey) throw new Error('Add an Anthropic API key in Settings.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.strongModel,
        max_tokens: 16000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
              { type: 'text', text: TRANSCRIBE },
            ],
          },
        ],
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? res.statusText}`);
    return (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  }
  if (settings.provider === 'claude-cli') {
    const name = `source-${Date.now()}.pdf`;
    await writeFile(join(workDir, name), data);
    try {
      const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read'];
      if (settings.claudeCli.strongModel) args.push('--model', settings.claudeCli.strongModel);
      const res = await run(settings.claudeCli.binary || 'claude', args, {
        input: `Read the file ./${name}. ${TRANSCRIBE}`,
        cwd: workDir,
        timeoutMs: 600_000,
      });
      const parsed = JSON.parse(res.stdout || '{}');
      if (parsed.is_error || res.code !== 0) throw new Error(String(parsed.result ?? res.stderr).slice(0, 300));
      return String(parsed.result ?? '');
    } finally {
      await rm(join(workDir, name), { force: true });
    }
  }
  throw new Error('This PDF is scanned (no text layer). Reading it needs the Claude CLI or an Anthropic API key; otherwise export its text first.');
}
