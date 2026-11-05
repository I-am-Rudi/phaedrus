import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Backend, ProfileSummary } from '@shared/api';
import { baseLanguage, languageMatches } from '@shared/language';
import type { Settings, TasteProfile } from '@shared/types';

export type ViewId = 'write' | 'profiles' | 'extract' | 'blend' | 'settings';

interface AppState {
  backend: Backend;
  mock: boolean;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  summaries: ProfileSummary[];
  general: TasteProfile | null;
  project: TasteProfile | null;
  /** Document language: the project's, or the default from Settings. */
  language: string;
  /** Id of the general profile chosen for the current language. */
  activeGeneralId: string | null;
  /** Choose the general profile for a language (defaults to the current one). */
  setActiveGeneral(id: string | null, language?: string): Promise<void>;
  /** A chosen general profile in another language than the document, if any. */
  generalMismatch: TasteProfile | null;
  refreshProfiles(): Promise<void>;
  /** Replace a loaded profile after it was saved elsewhere (accept/reject, editor). */
  profileChanged(p: TasteProfile): void;
  view: ViewId;
  go(view: ViewId, arg?: string): void;
  /** Vim command line: open it with a prefix (":" or "/"); onSubmit gets the typed text. */
  prompt: { prefix: string; onSubmit(v: string): void; onClose?(): void } | null;
  openPrompt(prefix: string, onSubmit: (v: string) => void, onClose?: () => void): void;
  closePrompt(): void;
  /** Commands views add for ":"; each gets the argument string. */
  registerCommands(cmds: Record<string, (arg: string) => void>): () => void;
  runCommand(line: string): void;
  helpOpen: boolean;
  setHelpOpen(open: boolean): void;
  leaderOpen: boolean;
  setLeaderOpen(open: boolean): void;
  cheatOpen: boolean;
  setCheatOpen(open: boolean): void;
  /** Updated synchronously, so keys typed right after Space reach the menu. */
  leaderRef: { current: boolean };
  viewArg: string | undefined;
  toast: string | null;
  notify(msg: string): void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ backend, mock, initial, children }: { backend: Backend; mock: boolean; initial: Settings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial);
  const [summaries, setSummaries] = useState<ProfileSummary[]>([]);
  const [general, setGeneral] = useState<TasteProfile | null>(null);
  const [project, setProject] = useState<TasteProfile | null>(null);
  const [view, setView] = useState<ViewId>('write');
  const [viewArg, setViewArg] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<AppState['prompt']>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [leaderOpen, setLeaderOpenState] = useState(false);
  const leaderRef = useRef(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const setLeaderOpen = useCallback((open: boolean) => {
    leaderRef.current = open;
    setLeaderOpenState(open);
  }, []);
  const commandsRef = useRef(new Map<string, (arg: string) => void>());

  const load = useCallback(
    async (id: string | null) => (id ? backend.profiles.get(id).catch(() => null) : null),
    [backend],
  );

  const [mismatch, setMismatch] = useState<TasteProfile | null>(null);
  const language = project?.language || settings.grammar.language;
  const base = baseLanguage(language);
  const activeGeneralId = (base && settings.generalByLanguage[base]) || settings.activeGeneralProfile;

  const refreshProfiles = useCallback(async () => {
    setSummaries(await backend.profiles.list());
    setProject(await load(settings.activeProjectProfile));
  }, [backend, load, settings.activeProjectProfile]);

  // The general profile depends on the document language, which comes from the project.
  useEffect(() => {
    let cancelled = false;
    void load(activeGeneralId).then((g) => {
      if (cancelled) return;
      const fits = !g || languageMatches(g.language, language);
      setGeneral(fits ? g : null);
      setMismatch(fits ? null : g);
    });
    return () => {
      cancelled = true;
    };
  }, [load, activeGeneralId, language, summaries]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => setSettings(await backend.settings.set(patch)),
    [backend],
  );

  const setActiveGeneral = useCallback(
    async (id: string | null, lang?: string) => {
      const b = baseLanguage(lang ?? language);
      if (!b) return updateSettings({ activeGeneralProfile: id });
      const map = { ...settings.generalByLanguage };
      if (id) map[b] = id;
      else delete map[b];
      return updateSettings({ generalByLanguage: map });
    },
    [language, settings.generalByLanguage, updateSettings],
  );

  const profileChanged = useCallback((p: TasteProfile) => {
    setGeneral((g) => (g?.id === p.id ? p : g));
    setProject((g) => (g?.id === p.id ? p : g));
    setSummaries((list) => list.map((s) => (s.id === p.id ? { ...s, name: p.name, moves: p.moves.length, updated: p.updated } : s)));
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const go = useCallback((v: ViewId, arg?: string) => {
    setView(v);
    setViewArg(arg);
  }, []);

  const registerCommands = useCallback((cmds: Record<string, (arg: string) => void>) => {
    for (const [k, f] of Object.entries(cmds)) commandsRef.current.set(k, f);
    return () => {
      for (const k of Object.keys(cmds)) commandsRef.current.delete(k);
    };
  }, []);

  const runCommand = useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const [name = '', ...rest] = trimmed.split(/\s+/);
      const arg = rest.join(' ');
      const views: Record<string, ViewId> = { write: 'write', profiles: 'profiles', extract: 'extract', blend: 'blend', settings: 'settings' };
      const own = commandsRef.current.get(name);
      if (own) return own(arg);
      if (views[name]) return go(views[name]!);
      if (name === 'h' || name === 'help') return setHelpOpen(true);
      if (name === 'teacher' || name === 'assistant') return void updateSettings({ mode: name });
      if (name === 'mode' && (arg === 'teacher' || arg === 'assistant')) return void updateSettings({ mode: arg });
      if (name === 'set') {
        const [k, v = ''] = arg.split('=');
        if (k === 'novim') return void updateSettings({ vim: false });
        if (k === 'mode' && (v === 'teacher' || v === 'assistant')) return void updateSettings({ mode: v });
        const own2 = commandsRef.current.get(k ?? '');
        if (own2) return own2(v);
      }
      if (name === 'profile' || name === 'project') {
        const q = arg.toLowerCase();
        const kind = name === 'project' ? 'project' : 'general';
        const hit = summaries.find((s) => s.kind === kind && (s.id === q || s.name.toLowerCase().startsWith(q)));
        if (!arg) return notify(`Usage: :${name} <name>`);
        if (!hit) return notify(`No ${kind} profile "${arg}"`);
        if (kind === 'project') return void updateSettings({ activeProjectProfile: hit.id });
        return void setActiveGeneral(hit.id, hit.language ?? 'auto');
      }
      notify(`Not a command: ${name}. :help lists the commands.`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [go, updateSettings, summaries, setActiveGeneral],
  );

  const value = useMemo<AppState>(
    () => ({
      backend, mock, settings, updateSettings, summaries, general, project, refreshProfiles, profileChanged,
      language, activeGeneralId, setActiveGeneral, generalMismatch: mismatch,
      view, viewArg, go, toast, notify,
      prompt, openPrompt: (prefix, onSubmit, onClose) => setPrompt({ prefix, onSubmit, onClose }), closePrompt: () => setPrompt(null),
      registerCommands, runCommand, helpOpen, setHelpOpen, leaderOpen, setLeaderOpen, leaderRef, cheatOpen, setCheatOpen,
    }),
    [backend, mock, settings, updateSettings, summaries, general, project, refreshProfiles, profileChanged, language, activeGeneralId, setActiveGeneral, mismatch, view, viewArg, go, toast, notify, prompt, registerCommands, runCommand, helpOpen, leaderOpen, cheatOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Electron wraps IPC errors: "Error invoking remote method 'x': Error: msg"
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
