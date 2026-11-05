// The contract between the renderer and the backend (Electron main process,
// or the in-memory mock used by `npm run web`).

import type { DiffEntry } from './profile/diff';
import type { ExcerptPolicy } from './profile/exchange';
import type { ProfileEvent } from './profile/feedback';
import type { RuleEvent, RuleSet, WritingRule } from './rules';
import type { EditFeedbackRequest, StyleBatchRequest, StyleCheckRequest } from './coach';
import type {
  BlendConflict,
  EditFeedback,
  GrammarIssue,
  ProviderId,
  Settings,
  SourceDoc,
  StyleSuggestion,
  TasteProfile,
} from './types';

export interface ProfileSummary {
  id: string;
  name: string;
  kind: TasteProfile['kind'];
  language?: string;
  moves: number;
  updated: string;
}

export interface RuleSetSummary {
  id: string;
  name: string;
  language?: string;
  rules: number;
  updated: string;
}

export interface Snapshot {
  id: string;
  at: string;
  reason: string;
}

export interface OpenedDocument {
  path: string;
  name: string;
  text: string;
}

export interface Backend {
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  profiles: {
    list(): Promise<ProfileSummary[]>;
    get(id: string): Promise<TasteProfile>;
    /** Saves and snapshots the previous version. `reason` labels the snapshot. */
    save(profile: TasteProfile, reason: string): Promise<TasteProfile>;
    remove(id: string): Promise<void>;
    applyEvent(profileId: string, event: ProfileEvent): Promise<TasteProfile>;
    history(id: string): Promise<Snapshot[]>;
    readSnapshot(id: string, snapshotId: string): Promise<TasteProfile>;
    rollback(id: string, snapshotId: string): Promise<TasteProfile>;
    /** Returns the saved path, or null if the user cancelled. */
    exportTo(id: string, format: 'md' | 'zip', policy: ExcerptPolicy): Promise<string | null>;
    /** Opens a file picker; returns the imported profile (saved), or null. */
    importFrom(): Promise<TasteProfile | null>;
    reveal(): Promise<void>;
  };
  rules: {
    list(): Promise<RuleSetSummary[]>;
    get(id: string): Promise<RuleSet>;
    save(set: RuleSet, reason: string): Promise<RuleSet>;
    remove(id: string): Promise<void>;
    applyEvent(setId: string, event: RuleEvent): Promise<RuleSet>;
    exportTo(id: string): Promise<string | null>;
    importFrom(): Promise<RuleSet | null>;
  };
  coach: {
    extractRules(docs: SourceDoc[], takenIds: string[]): Promise<WritingRule[]>;
    extract(sources: SourceDoc[], name: string, kind: TasteProfile['kind'], language?: string): Promise<TasteProfile>;
    diff(current: TasteProfile, incoming: TasteProfile): Promise<DiffEntry[]>;
    checkStyle(req: StyleCheckRequest): Promise<StyleSuggestion[]>;
    checkStyleBatch(req: StyleBatchRequest): Promise<Record<string, StyleSuggestion[]>>;
    editFeedback(req: EditFeedbackRequest): Promise<EditFeedback>;
    blendConflicts(profile: TasteProfile): Promise<BlendConflict[]>;
  };
  grammar: {
    /** `language` overrides the default from Settings (the project's language). */
    check(text: string, language?: string): Promise<GrammarIssue[]>;
  };
  providers: {
    status(): Promise<{ id: ProviderId; ok: boolean; detail: string }>;
    login(): Promise<string>;
    test(): Promise<string>;
  };
  files: {
    /** Pick source files (.md, .txt, .tex); returns their text. */
    pickSources(): Promise<SourceDoc[]>;
    openDocument(): Promise<OpenedDocument | null>;
    saveDocument(path: string | null, text: string): Promise<string | null>;
  };
}

/** Channel names: "<group>:<method>". */
export const channel = (group: string, method: string) => `${group}:${method}`;
