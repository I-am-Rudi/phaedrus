// Core data model shared by the main process, the renderer and the tests.

import type { KeyboardLayout } from './spelling/keyboard';

export type Category = 'spelling' | 'grammar' | 'style' | 'rules';
export type Mode = 'assistant' | 'teacher';

/** How explicit teacher-mode hints are for a move. 3 = most explicit, 0 = silent. */
export type HintLevel = 0 | 1 | 2 | 3;

export interface Example {
  text: string;
  /** Author/work for excerpts; omitted for the user's own sentences. */
  source?: string;
  kind: 'author' | 'user';
}

export interface MoveScope {
  /** Document types this move applies to (e.g. "paper", "blog"). Empty = all. */
  docTypes: string[];
  /** Section names this move applies to (e.g. "introduction"). Empty = all. */
  sections: string[];
}

export interface MoveStats {
  accepted: number;
  rejected: number;
  landed: number;
  missed: number;
  /** Consecutive teacher-mode edits that landed; drives hint fading. */
  streak: number;
}

export type MoveOrigin = 'extracted' | 'manual' | 'blended';

/** One stylistic move: something an author does that the checker can look for. */
export interface StyleMove {
  id: string;
  title: string;
  description: string;
  rationale: string;
  enabled: boolean;
  /** 0..1, how hard the checker pushes this move. */
  weight: number;
  scope: MoveScope;
  /** Locked moves are never changed by automatic updates. */
  locked: boolean;
  hintLevel: HintLevel;
  origin: MoveOrigin;
  examples: Example[];
  /** Free-form notes, e.g. "not for me in emails" collected from rejections. */
  notes: string[];
  stats: MoveStats;
}

export interface SourceRef {
  title: string;
  author?: string;
}

/** Measurable features of a body of prose, used for extraction and quick local checks. */
export interface StyleMetrics {
  sentenceLengthMean: number;
  sentenceLengthStd: number;
  paragraphLengthMean: number;
  wordLengthMean: number;
  typeTokenRatio: number;
  /** Per 100 words. */
  hedgeRate: number;
  /** Fraction of sentences that look passive. */
  passiveRate: number;
  /** Fraction of sentences that are questions. */
  questionRate: number;
  /** Per 100 words. */
  firstPersonRate: number;
  words: number;
}

export interface TasteProfile {
  id: string;
  name: string;
  kind: 'general' | 'project';
  /**
   * Language code. For a project profile: the document language (unset = the
   * default in Settings). For a general profile: the language it applies to
   * (unset = any language).
   */
  language?: string;
  description: string;
  sources: SourceRef[];
  metrics?: StyleMetrics;
  moves: StyleMove[];
  created: string;
  updated: string;
}

/** Spelling or grammar issue from a deterministic engine. Offsets are UTF-16 indices into the checked text. */
export interface GrammarIssue {
  category: 'spelling' | 'grammar';
  from: number;
  to: number;
  text: string;
  message: string;
  replacements: string[];
  ruleId: string;
  engine: 'languagetool' | 'harper';
  /** Spelling: how many of `replacements` came from the engine; the rest were added from the word list. */
  engineCount?: number;
  /** Spelling: Zipf frequency of each replacement, null if it is not in the word list. */
  zipf?: (number | null)[];
}

/** A style suggestion from the LLM, anchored by quoted text rather than offsets. */
export interface StyleSuggestion {
  /** The style move this is about ("" for a rule violation). */
  moveId: string;
  /** "<rule set id>/<rule id>" for a rule violation. */
  ruleKey?: string;
  quote: string;
  issue: string;
  rewrite: string;
  explanation: string;
  /** Teacher-mode hints, from most to least explicit. */
  hints: { specific: string; general: string };
}

export interface EditFeedback {
  verdict: 'landed' | 'partly' | 'overcorrected' | 'missed';
  feedback: string;
  /** True if the revised sentence is a good example of the move worth keeping. */
  exemplary: boolean;
}

export interface SourceDoc {
  name: string;
  author?: string;
  text: string;
  /** Shown next to the source, e.g. when a scanned PDF could not be read. */
  warning?: string;
}

export interface BlendInput {
  profile: TasteProfile;
  weight: number;
}

export interface BlendConflict {
  a: { profileId: string; moveId: string; title: string };
  b: { profileId: string; moveId: string; title: string };
  reason: string;
}

export type ProviderId = 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli';
export type GrammarEngineId = 'languagetool' | 'harper' | 'none';

export interface Settings {
  provider: ProviderId;
  anthropic: { apiKey: string; fastModel: string; strongModel: string };
  /** Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Ollama, ... */
  openai: { apiKey: string; baseUrl: string; fastModel: string; strongModel: string };
  claudeCli: { binary: string; fastModel: string; strongModel: string };
  codexCli: { binary: string; model: string };
  grammar: {
    engine: GrammarEngineId;
    languageToolUrl: string;
    /** Default language; a project profile's language overrides it. */
    language: string;
    harperDialect: 'american' | 'british' | 'australian' | 'canadian';
    /** Keyboard used for typing; "auto" asks the system. Ranks corrections for slips like y/z. */
    keyboard: 'auto' | KeyboardLayout;
  };
  /** Folder holding profile .md files; can be shared with other tools. */
  profilesDir: string;
  /** General profile used when the document language has no specific choice. */
  activeGeneralProfile: string | null;
  /** Chosen general profile per base language ("en", "de", ...). */
  generalByLanguage: Record<string, string>;
  activeProjectProfile: string | null;
  /** Active rule sets per project profile id ("" when no project is active). */
  rulesByProject: Record<string, string[]>;
  mode: Mode;
  dictionary: string[];
  /** Spelling corrections chosen before: typo -> word -> times (lower case). */
  spellingMemory: Record<string, Record<string, number>>;
  /** Colour theme id (see themes.ts) or "system". */
  theme: string;
  /** Vim keybindings in the editor and across the app. */
  vim: boolean;
  /** Extra ways to leave insert mode, like `inoremap jk <Esc>` in a vimrc. */
  vimEscape: {
    /** Key sequence typed in insert mode, e.g. "jk" or "jj"; empty = off. */
    sequence: string;
    /** Max time between the keys of the sequence (vim's timeoutlen). */
    timeoutMs: number;
    /** Ctrl-c acts as Escape. */
    ctrlC: boolean;
  };
  styleDebounceMs: number;
  grammarDebounceMs: number;
  /** Open the last document again when the app starts. */
  reopenLastFile: boolean;
  /** Rule sets checked in every document of their language, whatever the project selects. */
  alwaysOnRules: string[];
  /** Taste profiles checked in every document of their language, besides the chosen ones. */
  alwaysOnProfiles: string[];
  /** Built-in sets already put into the folders once (so deleting one is respected). */
  seededDefaults: string[];
}
