import { useEffect, useState } from 'react';
import type { ProviderId, Settings } from '@shared/types';
import { errorText, useApp } from '../state';

const PROVIDERS: [ProviderId, string, string][] = [
  ['claude-cli', 'Claude subscription', 'Runs the Claude Code CLI (claude -p) in the background with its existing login.'],
  ['codex-cli', 'ChatGPT subscription', 'Runs the Codex CLI (codex exec) in the background with its existing login.'],
  ['anthropic', 'Anthropic API key', 'Pay per use through the Anthropic API.'],
  ['openai', 'OpenAI-compatible API', 'OpenAI, OpenRouter, Groq, Ollama or any endpoint with the same API.'],
];

export function SettingsView() {
  const app = useApp();
  const { backend, settings } = app;
  const [s, setS] = useState<Settings>(settings);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const patch = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) =>
    setS({ ...s, [k]: typeof v === 'object' && !Array.isArray(v) ? { ...(s[k] as object), ...v } : v });

  async function act(label: string, fn: () => Promise<string>) {
    setBusy(true);
    setStatus(`${label}…`);
    try {
      if (dirty) await app.updateSettings(s);
      setStatus(await fn());
    } catch (e) {
      setStatus(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pane">
      <div className="pane-inner">
        <div className="row">
          <h1 className="grow">Settings</h1>
          <button className="btn" disabled={!dirty} onClick={() => setS(settings)}>Revert</button>
          <button className="btn primary" disabled={!dirty} onClick={() => void app.updateSettings(s)}>Save</button>
        </div>

        <div className="section">
          <h2>Language model</h2>
          {PROVIDERS.map(([id, label, desc]) => (
            <label key={id} className="inline" style={{ alignItems: 'flex-start' }}>
              <input type="radio" name="provider" checked={s.provider === id} onChange={() => setS({ ...s, provider: id })} style={{ marginTop: 4 }} />
              <span><b>{label}</b><br /><span className="small muted">{desc}</span></span>
            </label>
          ))}

          {s.provider === 'claude-cli' && (
            <div className="grid3">
              <label className="field">Binary<input type="text" value={s.claudeCli.binary} onChange={(e) => patch('claudeCli', { binary: e.target.value })} /></label>
              <label className="field">Model for checks<input type="text" value={s.claudeCli.fastModel} onChange={(e) => patch('claudeCli', { fastModel: e.target.value })} /></label>
              <label className="field">Model for extraction<input type="text" value={s.claudeCli.strongModel} onChange={(e) => patch('claudeCli', { strongModel: e.target.value })} /></label>
            </div>
          )}
          {s.provider === 'codex-cli' && (
            <div className="grid2">
              <label className="field">Binary<input type="text" value={s.codexCli.binary} onChange={(e) => patch('codexCli', { binary: e.target.value })} /></label>
              <label className="field">Model (empty = Codex default)<input type="text" value={s.codexCli.model} onChange={(e) => patch('codexCli', { model: e.target.value })} /></label>
            </div>
          )}
          {s.provider === 'anthropic' && (
            <div className="grid3">
              <label className="field">API key<input type="password" value={s.anthropic.apiKey} onChange={(e) => patch('anthropic', { apiKey: e.target.value })} /></label>
              <label className="field">Model for checks<input type="text" value={s.anthropic.fastModel} onChange={(e) => patch('anthropic', { fastModel: e.target.value })} /></label>
              <label className="field">Model for extraction<input type="text" value={s.anthropic.strongModel} onChange={(e) => patch('anthropic', { strongModel: e.target.value })} /></label>
            </div>
          )}
          {s.provider === 'openai' && (
            <div className="grid2">
              <label className="field">Base URL<input type="text" value={s.openai.baseUrl} onChange={(e) => patch('openai', { baseUrl: e.target.value })} /></label>
              <label className="field">API key (empty for local servers)<input type="password" value={s.openai.apiKey} onChange={(e) => patch('openai', { apiKey: e.target.value })} /></label>
              <label className="field">Model for checks<input type="text" value={s.openai.fastModel} placeholder="required" onChange={(e) => patch('openai', { fastModel: e.target.value })} /></label>
              <label className="field">Model for extraction<input type="text" value={s.openai.strongModel} placeholder="defaults to the check model" onChange={(e) => patch('openai', { strongModel: e.target.value })} /></label>
            </div>
          )}
          <div className="row">
            <button className="btn small" disabled={busy} onClick={() => void act('Checking', async () => { const r = await backend.providers.status(); return `${r.ok ? 'Ready' : 'Not ready'}: ${r.detail}`; })}>Status</button>
            <button className="btn small" disabled={busy} onClick={() => void act('Testing', () => backend.providers.test().then((r) => `Model replied: ${r}`))}>Send a test prompt</button>
            {(s.provider === 'claude-cli' || s.provider === 'codex-cli') && (
              <button className="btn small" disabled={busy} onClick={() => void act('Opening browser sign-in', () => backend.providers.login())}>Sign in</button>
            )}
            <span className="small muted">{status}</span>
          </div>
          <div className="small muted">API keys are stored encrypted with your system keychain when it is available.</div>
        </div>

        <div className="section">
          <h2>Spelling and grammar</h2>
          <div className="grid3">
            <label className="field">
              Engine
              <select value={s.grammar.engine} onChange={(e) => patch('grammar', { engine: e.target.value as Settings['grammar']['engine'] })}>
                <option value="languagetool">LanguageTool (local server, many languages)</option>
                <option value="harper">Harper (built in, English only)</option>
                <option value="none">Off</option>
              </select>
            </label>
            {s.grammar.engine === 'languagetool' && (
              <>
                <label className="field">Server URL<input type="text" value={s.grammar.languageToolUrl} onChange={(e) => patch('grammar', { languageToolUrl: e.target.value })} /></label>
                <label className="field">Language<input type="text" value={s.grammar.language} placeholder="auto, en-GB, de-DE" onChange={(e) => patch('grammar', { language: e.target.value })} /></label>
              </>
            )}
            {s.grammar.engine === 'harper' && (
              <label className="field">
                Dialect
                <select value={s.grammar.harperDialect} onChange={(e) => patch('grammar', { harperDialect: e.target.value as Settings['grammar']['harperDialect'] })}>
                  {['british', 'american', 'canadian', 'australian'].map((d) => <option key={d}>{d}</option>)}
                </select>
              </label>
            )}
          </div>
          {s.grammar.engine === 'languagetool' && (
            <div className="small muted">Start a local server with <span className="kbd">docker run -d -p 8081:8010 erikvl87/languagetool</span>. Nothing leaves your machine.</div>
          )}
          <label className="field">
            Dictionary (words never flagged as misspelled, comma separated)
            <textarea rows={2} value={s.dictionary.join(', ')} onChange={(e) => setS({ ...s, dictionary: e.target.value.split(',').map((w) => w.trim()).filter(Boolean) })} />
          </label>
        </div>

        <div className="section">
          <h2>Checking</h2>
          <div className="grid3">
            <label className="field">Style check delay (ms)<input type="number" min={500} step={250} value={s.styleDebounceMs} onChange={(e) => setS({ ...s, styleDebounceMs: Number(e.target.value) })} /></label>
            <label className="field">Grammar check delay (ms)<input type="number" min={100} step={100} value={s.grammarDebounceMs} onChange={(e) => setS({ ...s, grammarDebounceMs: Number(e.target.value) })} /></label>
            <label className="field">Profiles folder<input type="text" value={s.profilesDir} onChange={(e) => setS({ ...s, profilesDir: e.target.value })} /></label>
          </div>
          <div className="small muted">Profiles are plain Markdown files. Point the folder at a git repository or a folder other tools read, such as your writing kit.</div>
        </div>
      </div>
    </div>
  );
}
