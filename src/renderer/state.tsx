import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppEvents, Backend, ProfileSummary, RuleSetSummary } from '@shared/api';
import { baseLanguage, languageMatches } from '@shared/language';
import type { RuleSet } from '@shared/rules';
import type { Settings, TasteProfile } from '@shared/types';

export type ViewId = 'write' | 'profiles' | 'rules' | 'extract' | 'blend' | 'settings';

export interface AskButton {
  label: string;
  /** Returned by ask() when chosen. */
  value: string;
  /** Single key that picks this button while the dialog is open. */
  key?: string;
  /** Picked by Enter. */
  primary?: boolean;
  /** Second line, for list dialogs (e.g. the folder of a recent file). */
  detail?: string;
}

export interface AskOptions {
  title: string;
  message?: string;
  buttons: AskButton[];
  /** Returned for Escape, Ctrl-c or a click outside. */
  cancel: string;
  layout?: 'row' | 'list';
}

export type AskState = AskOptions & { resolve(value: string): void };

/** Something that may hold unsaved work: resolves true when it is fine to go on. */
type Guard = { check: () => Promise<boolean>; view?: ViewId };

interface AppState {
  backend: Backend;
  events: AppEvents;
  /** Show a small dialog; resolves with the chosen button's value. */
  ask(opts: AskOptions): Promise<string>;
  dialog: AskState | null;
  /**
   * Register a check for unsaved work. With a view, it runs when leaving that
   * view; every guard runs before the window closes.
   */
  registerGuard(id: string, check: () => Promise<boolean>, view?: ViewId): () => void;
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
  ruleSummaries: RuleSetSummary[];
  /** Rule sets checked now: the project's selection plus the always-on sets, in this language. */
  ruleSets: RuleSet[];
  /** Taste profiles switched to always on that apply to this language (besides general and project). */
  alwaysProfiles: TasteProfile[];
  /** Switch a rule set or a taste profile to always on (or back). */
  setAlwaysOn(kind: 'rules' | 'profiles', id: string, on: boolean): Promise<void>;
  isAlwaysOn(kind: 'rules' | 'profiles', id: string): boolean;
  activeRuleIds: string[];
  setActiveRules(ids: string[]): Promise<void>;
  refreshRules(): Promise<void>;
  ruleSetChanged(s: RuleSet): void;
  refreshProfiles(): Promise<void>;
  /** Replace a loaded profile after it was saved elsewhere (accept/reject, editor). */
  profileChanged(p: TasteProfile): void;
  view: ViewId;
  go(view: ViewId, arg?: string): void;
  /** Vim command line: open it with a prefix (":" or "/"); onSubmit gets the typed text. */
  prompt: { prefix: string; onSubmit(v: string): void; onClose?(): void } | null;
  openPrompt(prefix: string, onSubmit: (v: string) => void, onClose?: () => void): void;
  closePrompt(): void;
  /**
   * Commands views add for ":"; each gets the argument string. With a view,
   * the command applies while that view is shown and wins over the general one
   * (":w" saves settings in Settings and the document elsewhere).
   */
  registerCommands(cmds: Record<string, (arg: string) => void>, view?: ViewId): () => void;
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

export function AppProvider({ backend, events, mock, initial, children }: { backend: Backend; events: AppEvents; mock: boolean; initial: Settings; children: ReactNode }) {
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
  const commandsRef = useRef(new Map<string, { fn: (arg: string) => void; view?: ViewId }[]>());

  const [dialog, setDialog] = useState<AskState | null>(null);
  const dialogRef = useRef<AskState | null>(null);
  const ask = useCallback(
    (opts: AskOptions) =>
      new Promise<string>((resolve) => {
        const prev = dialogRef.current;
        const next: AskState = {
          ...opts,
          resolve: (v) => {
            if (dialogRef.current === next) {
              dialogRef.current = null;
              setDialog(null);
            }
            resolve(v);
          },
        };
        dialogRef.current = next;
        setDialog(next);
        prev?.resolve(prev.cancel);
      }),
    [],
  );

  const guardsRef = useRef(new Map<string, Guard>());
  const registerGuard = useCallback((id: string, check: () => Promise<boolean>, v?: ViewId) => {
    const g: Guard = { check, view: v };
    guardsRef.current.set(id, g);
    return () => {
      if (guardsRef.current.get(id) === g) guardsRef.current.delete(id);
    };
  }, []);
  const viewRef = useRef(view);
  viewRef.current = view;

  const load = useCallback(
    async (id: string | null) => (id ? backend.profiles.get(id).catch(() => null) : null),
    [backend],
  );

  const [mismatch, setMismatch] = useState<TasteProfile | null>(null);
  const [ruleSummaries, setRuleSummaries] = useState<RuleSetSummary[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
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

  const projectKey = settings.activeProjectProfile ?? '';
  const activeRuleIds = useMemo(() => settings.rulesByProject?.[projectKey] ?? [], [settings.rulesByProject, projectKey]);

  const refreshRules = useCallback(async () => {
    setRuleSummaries(await backend.rules.list());
  }, [backend]);
  useEffect(() => {
    void refreshRules();
  }, [refreshRules]);

  const alwaysRuleIds = settings.alwaysOnRules ?? [];
  const alwaysProfileIds = settings.alwaysOnProfiles ?? [];
  useEffect(() => {
    let cancelled = false;
    const ids = [...new Set([...activeRuleIds, ...alwaysRuleIds])].filter((id) => ruleSummaries.some((r) => r.id === id && languageMatches(r.language, language)));
    void Promise.all(ids.map((id) => backend.rules.get(id).catch(() => null))).then((sets) => {
      if (!cancelled) setRuleSets(sets.filter((s): s is RuleSet => !!s));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, activeRuleIds, alwaysRuleIds.join('|'), ruleSummaries, language]);

  const [alwaysProfiles, setAlwaysProfiles] = useState<TasteProfile[]>([]);
  useEffect(() => {
    let cancelled = false;
    const ids = alwaysProfileIds.filter(
      (id) => id !== activeGeneralId && id !== settings.activeProjectProfile && summaries.some((s) => s.id === id && languageMatches(s.language, language)),
    );
    void Promise.all(ids.map((id) => backend.profiles.get(id).catch(() => null))).then((ps) => {
      if (!cancelled) setAlwaysProfiles(ps.filter((p): p is TasteProfile => !!p));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, alwaysProfileIds.join('|'), activeGeneralId, settings.activeProjectProfile, summaries, language]);

  const setAlwaysOn = useCallback(
    async (kind: 'rules' | 'profiles', id: string, on: boolean) => {
      const key = kind === 'rules' ? 'alwaysOnRules' : 'alwaysOnProfiles';
      const cur = settings[key] ?? [];
      await updateSettings({ [key]: on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id) } as Partial<Settings>);
    },
    [settings, updateSettings],
  );
  const isAlwaysOn = useCallback(
    (kind: 'rules' | 'profiles', id: string) => (kind === 'rules' ? settings.alwaysOnRules : settings.alwaysOnProfiles)?.includes(id) ?? false,
    [settings.alwaysOnRules, settings.alwaysOnProfiles],
  );

  const setActiveRules = useCallback(
    (ids: string[]) => updateSettings({ rulesByProject: { ...settings.rulesByProject, [projectKey]: ids } }),
    [settings.rulesByProject, projectKey, updateSettings],
  );
  const ruleSetChanged = useCallback((s: RuleSet) => {
    setRuleSets((list) => list.map((x) => (x.id === s.id ? s : x)));
    setRuleSummaries((list) => list.map((x) => (x.id === s.id ? { ...x, name: s.name, language: s.language, rules: s.rules.length, updated: s.updated } : x)));
  }, []);

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
    setAlwaysProfiles((list) => list.map((x) => (x.id === p.id ? p : x)));
    setProject((g) => (g?.id === p.id ? p : g));
    setSummaries((list) => list.map((s) => (s.id === p.id ? { ...s, name: p.name, moves: p.moves.length, updated: p.updated } : s)));
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const go = useCallback((v: ViewId, arg?: string) => {
    const from = viewRef.current;
    void (async () => {
      if (v !== from) {
        for (const g of [...guardsRef.current.values()]) if (g.view === from && !(await g.check())) return;
      }
      setView(v);
      setViewArg(arg);
    })();
  }, []);

  // Closing the window: give every guard the chance to save or cancel.
  useEffect(
    () =>
      events.onCloseRequested(async () => {
        for (const g of [...guardsRef.current.values()]) {
          if (!(await g.check())) return events.answerClose(false);
        }
        events.answerClose(true);
      }),
    [events],
  );

  const registerCommands = useCallback((cmds: Record<string, (arg: string) => void>, v?: ViewId) => {
    const added: [string, { fn: (arg: string) => void; view?: ViewId }][] = [];
    for (const [k, fn] of Object.entries(cmds)) {
      const entry = { fn, view: v };
      commandsRef.current.set(k, [...(commandsRef.current.get(k) ?? []), entry]);
      added.push([k, entry]);
    }
    return () => {
      for (const [k, entry] of added) commandsRef.current.set(k, (commandsRef.current.get(k) ?? []).filter((e) => e !== entry));
    };
  }, []);
  const lookup = (name: string) => {
    const list = commandsRef.current.get(name) ?? [];
    return (list.findLast((e) => e.view === viewRef.current) ?? list.findLast((e) => !e.view))?.fn;
  };

  const runCommand = useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const [name = '', ...rest] = trimmed.split(/\s+/);
      const arg = rest.join(' ');
      const views: Record<string, ViewId> = { write: 'write', profiles: 'profiles', rules: 'rules', extract: 'extract', blend: 'blend', settings: 'settings' };
      const own = lookup(name);
      if (own) return own(arg);
      if (views[name]) return go(views[name]!);
      if (name === 'h' || name === 'help') return setHelpOpen(true);
      if (name === 'teacher' || name === 'assistant') return void updateSettings({ mode: name });
      if (name === 'mode' && (arg === 'teacher' || arg === 'assistant')) return void updateSettings({ mode: arg });
      if (name === 'set') {
        const [k, v = ''] = arg.split('=');
        if (k === 'novim') return void updateSettings({ vim: false });
        if (k === 'mode' && (v === 'teacher' || v === 'assistant')) return void updateSettings({ mode: v });
        const own2 = lookup(k ?? '');
        if (own2) return own2(v);
      }
      if (name === 'rule' || name === 'rules-toggle') {
        const q = arg.toLowerCase();
        const hit = ruleSummaries.find((r) => r.id === q || r.name.toLowerCase().startsWith(q));
        if (!hit) return notify(arg ? `No rule set "${arg}"` : 'Usage: :rule <name> (toggles it for this project)');
        const on = activeRuleIds.includes(hit.id);
        void setActiveRules(on ? activeRuleIds.filter((x) => x !== hit.id) : [...activeRuleIds, hit.id]);
        return notify(`${hit.name} ${on ? 'off' : 'on'} for this project`);
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
    [go, updateSettings, summaries, setActiveGeneral, ruleSummaries, activeRuleIds, setActiveRules],
  );

  const runRef = useRef(runCommand);
  runRef.current = runCommand;
  useEffect(() => events.onMenu((cmd) => runRef.current(cmd)), [events]);

  const value = useMemo<AppState>(
    () => ({
      backend, events, ask, dialog, registerGuard, mock, settings, updateSettings, summaries, general, project, refreshProfiles, profileChanged,
      language, activeGeneralId, setActiveGeneral, generalMismatch: mismatch,
      ruleSummaries, ruleSets, alwaysProfiles, setAlwaysOn, isAlwaysOn, activeRuleIds, setActiveRules, refreshRules, ruleSetChanged,
      view, viewArg, go, toast, notify,
      prompt, openPrompt: (prefix, onSubmit, onClose) => setPrompt({ prefix, onSubmit, onClose }), closePrompt: () => setPrompt(null),
      registerCommands, runCommand, helpOpen, setHelpOpen, leaderOpen, setLeaderOpen, leaderRef, cheatOpen, setCheatOpen,
    }),
    [backend, events, ask, dialog, registerGuard, mock, settings, updateSettings, summaries, general, project, refreshProfiles, profileChanged, language, activeGeneralId, setActiveGeneral, mismatch, ruleSummaries, ruleSets, alwaysProfiles, setAlwaysOn, isAlwaysOn, activeRuleIds, setActiveRules, refreshRules, ruleSetChanged, view, viewArg, go, toast, notify, prompt, registerCommands, runCommand, helpOpen, leaderOpen, cheatOpen],
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

/**
 * Unsaved work in a view: asks Save / Don't save / Cancel when leaving the view
 * or closing the window. Returns the same check for switching items inside the view.
 */
export function useUnsavedGuard(id: string, view: ViewId, dirty: boolean, title: string, save: () => Promise<boolean | void>) {
  const app = useApp();
  const live = useRef({ dirty, title, save });
  live.current = { dirty, title, save };
  const { ask, registerGuard } = app;
  const check = useCallback(async () => {
    if (!live.current.dirty) return true;
    const v = await ask({
      title: live.current.title,
      message: 'If you do not save, your changes are lost.',
      buttons: [
        { label: 'Save', value: 'save', key: 's', primary: true },
        { label: "Don't save", value: 'discard', key: 'd' },
        { label: 'Cancel', value: 'cancel', key: 'c' },
      ],
      cancel: 'cancel',
    });
    if (v === 'save') return (await live.current.save()) !== false;
    return v === 'discard';
  }, [ask]);
  useEffect(() => registerGuard(id, check, view), [registerGuard, check, id, view]);
  return check;
}
