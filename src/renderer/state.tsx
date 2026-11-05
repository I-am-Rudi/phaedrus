import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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

  const value = useMemo<AppState>(
    () => ({
      backend, mock, settings, updateSettings, summaries, general, project, refreshProfiles, profileChanged,
      language, activeGeneralId, setActiveGeneral, generalMismatch: mismatch,
      view, viewArg, go: (v, arg) => { setView(v); setViewArg(arg); }, toast, notify,
    }),
    [backend, mock, settings, updateSettings, summaries, general, project, refreshProfiles, profileChanged, language, activeGeneralId, setActiveGeneral, mismatch, view, viewArg, toast, notify],
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
