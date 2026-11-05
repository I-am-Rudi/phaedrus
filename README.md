# Gorgias

Named after Gorgias of Leontini (about 483 to 375 BC), the sophist who taught rhetoric in Athens.

A desktop writing assistant that checks spelling and grammar and coaches your style toward authors you choose. Style suggestions come from a **taste profile**: a Markdown file that lists concrete moves extracted from writing you admire, which you can edit, export, blend and keep under git.

Spelling and grammar come from an open-source engine (LanguageTool or Harper). Style comes from a language model, either through an API key or through the Claude Code / Codex CLI using the subscription you are already signed in with.

## Modes

Both modes underline issues in the text in three colours: red for spelling, blue for grammar, green for style. Spelling and grammar behave the same in both.

- **Assistant** shows each style suggestion in full: what drifts from the move, a rewrite of the quoted passage, and why. *Accept* applies the rewrite, *Dismiss* hides it, *Not for me* hides it and records your reason as a note on the move.
- **Teacher** shows only a hint (a question that points at the problem) with no rewrite. Revise the passage yourself. When you leave the paragraph, or press *Check my revision*, the model judges the edit as *landed*, *partly*, *overcorrected* or *missed* and says why.

## How the profile learns

Every profile update is saved, and the previous version goes to `.history/<profile>/` for rollback.

| Event | Effect on the move |
|---|---|
| Accept (assistant) | weight rises by 5 % of the remaining headroom |
| Not for me | weight drops by 10 %, your reason is added as a note the model sees in later checks |
| Revision landed (teacher) | after 3 in a row the hints get one level less explicit (specific question, general pointer, underline only, silent) |
| Revision missed or overcorrected | hints become more explicit again |
| Landed revision the model rates as exemplary | your sentence is kept as an example of the move (at most 5 of your own) |

Locked moves never change automatically. That covers re-extraction too.

## Taste profiles

A profile has a general or project kind. In the write view you pick one of each; a project move overrides a general move with the same id. Each move has:

- a title, a description of what the writer does, and why it works
- a weight from 0 to 1, an on/off switch, and a lock
- a scope: document types (paper, thesis, blog, email, notes) and section names (matched against Markdown headings and LaTeX `\section{}`); empty means everywhere
- a teacher-mode hint level, author excerpts, your own example sentences, and notes

The profile view also offers:

- **Extract**: paste text or add `.md`/`.txt`/`.tex` files, and the model proposes 6 to 14 moves. Measured features of the sources (sentence length and spread, hedges per 100 words, passive share, questions, first person) are stored with the profile. Style checks use them to point out measurable drift.
- **Re-extract** into an existing profile: a diff shows added, changed and missing moves with checkboxes. Merging keeps weights, scopes, locks, notes, hint levels and your own examples; only descriptions and author excerpts change.
- **Blend**: combine profiles with weights (say 70/30). Move weights are scaled by each profile's share. Moves with overlapping titles are listed for you to keep one, keep both or merge; a second pass asks the model for contradictions between differently named moves.
- **Export** as a single `.md` or a `.zip` bundle with a sources list. Choose to keep all author excerpts, only those of 25 words or fewer, or none. Your own example sentences are always included.

### Languages

Every profile has a language. A project profile's language is the document language; a general profile's language says which writing it applies to. Profiles are grouped by language, and matching uses the base language, so an `en-GB` profile applies to `en-US` text but never to German.

The document language comes from the active project profile, or from the default in Settings. Only general profiles in that language (or with no language) are offered, and the choice is remembered per language. Extraction asks for the language of the sources, and blending combines profiles of one language only.

Spelling and grammar follow the same language: LanguageTool checks it with its rules for that language (31 languages, with deep coverage for English, German, French, Spanish, Portuguese, Dutch, Catalan and Ukrainian), and Harper checks English only, picking British, American, Canadian or Australian spelling from the language code. Style rewrites stay in the paragraph's language. The measured hedge, passive and first-person rates use English word lists; sentence length works for any language.

### File format

Profiles are plain Markdown in the profiles folder (Settings). Hand-written files without settings blocks are read too; missing values get defaults.

````markdown
---
gorgias: 1
id: plain-physics
name: Plain physics
kind: general
description: Short declarative claims, a concrete case before the rule.
sources:
  - title: Lecture notes
    author: R. Feynman
metrics: { sentenceLengthMean: 9.8, sentenceLengthStd: 7.4, ... }
---

# Plain physics

## Short declarative openers

```yaml
id: short-declarative-openers
enabled: true
weight: 0.85
locked: false
hint_level: 3
origin: extracted
scope:
  doc_types: []
  sections: [introduction]
stats: { accepted: 4, rejected: 1, landed: 2, missed: 0, streak: 2 }
```

Open a paragraph with a short sentence that states the point, then unpack it.

### Why it works

The reader knows where the paragraph is going before the detail arrives.

### Examples

> Nature is simple.
>
> Source: Lecture notes

> The integral diverges.
>
> Source: me

### Notes

- too blunt for abstracts (in paper)
````

## Setup

Requires Node 20 or newer.

```bash
npm install
npm run dev        # desktop app with hot reload
npm run build      # production build into out/
npm run dist       # installers via electron-builder (AppImage/deb, dmg, nsis)
npm test           # unit and integration tests, no network or model needed
npm run web        # the UI in a browser with an in-memory mock backend
```

### Releases

`.github/workflows/release.yml` builds installers when a version tag is pushed and attaches them to a draft GitHub release:

| Platform | Runner | Output |
|---|---|---|
| macOS | `macos-latest` | `.dmg` and `.zip`, Apple Silicon and Intel |
| Windows | `windows-latest` | `.exe` installer (NSIS), x64 |
| Linux | `ubuntu-latest` | `.AppImage` and `.deb`, x64 |

```bash
npm version 0.2.0        # bumps package.json and tags v0.2.0
git push --follow-tags   # the workflow runs, then publish the draft release on GitHub
```

Tests and a typecheck run first, and the job fails if the tag does not match the `package.json` version. Without signing secrets the macOS and Windows builds are unsigned, so Gatekeeper and SmartScreen warn on first launch. The secrets for signing and notarization are listed at the top of the workflow. There is no auto-update yet.

### Language model

Pick one in Settings.

| Provider | What it runs | Setup |
|---|---|---|
| Claude subscription | `claude -p --output-format json --model <model>` | Install [Claude Code](https://docs.claude.com/en/docs/claude-code), then *Sign in* in Settings or run `claude auth login` |
| ChatGPT subscription | `codex exec --sandbox read-only --output-last-message <file> -` | Install the Codex CLI, then *Sign in* or run `codex login` |
| Anthropic API | Messages API | API key; models default to `claude-haiku-5-5` for checks and `claude-sonnet-5-5` for extraction |
| OpenAI-compatible | `/chat/completions` | Base URL, key and model names; works with OpenAI, OpenRouter, Groq and a local Ollama |

The CLI providers run in an empty folder (`<userData>/cli-sandbox`) so that no project `CLAUDE.md` or files end up in the prompt. They use your existing CLI login and never read its tokens. Check each provider's terms before relying on a subscription for this kind of use. API keys are encrypted with the OS keychain through Electron `safeStorage` when available.

Style checks use the fast model, one paragraph at a time, with the neighbouring paragraphs as context. Results are cached by paragraph text, document type, section and the profile's move descriptions, so accepting a suggestion (which changes weights only) does not recheck the document.

### Spelling and grammar

- **LanguageTool** (default; English, German and about 30 more languages). Run a local server:
  ```bash
  docker run -d -p 8081:8010 erikvl87/languagetool
  ```
  Nothing leaves your machine. Its style-category rules are skipped; the profile owns style.
- **Harper** runs inside the app (WebAssembly), English only, with British, American, Canadian or Australian spelling. No server needed.

Words in the Settings dictionary are never flagged as misspelled.

## LaTeX and Markdown math

All checks treat LaTeX as markup, not prose. Before spelling and grammar run, each paragraph is turned into plain prose with a map back to the original characters:

| In the text | Checked as |
|---|---|
| `$..$`, `\(..\)`, `$$..$$`, `\[..\]`, `equation`/`align`/`gather`/`multline` environments | the placeholder word `X` |
| `\emph{..}`, `\textbf{..}`, `\section{..}`, `\caption{..}` and similar | their argument |
| `\ref`, `\eqref`, `\cref` | `1` |
| `\citet`, `\textcite` | an author name |
| `\cite`, `\label`, `\footnote`, other commands, `%` comments, `verbatim`/`tikzpicture`/`tabular` environments | removed |
| `\%` `\$` `~` ` `` ` `''` | `%` `$` space `"` `"` |

Findings that touch a placeholder or markup are dropped; the rest are placed on the original text. A `$` only opens math under pandoc's rule (no space after the opening `$`, none before the closing one, no digit right after it), so "costs $5 and $10" stays prose. Eq, Fig, Sec, Ref and similar abbreviations are never flagged.

Style checks see the original paragraph and are told to leave math, commands and comments untouched. A suggestion whose rewrite does not keep every equation and reference of the quoted passage verbatim is discarded, and paragraphs that are mostly equations are skipped. Metrics are measured on the prose, and extraction sources keep inline math but show displayed equations as `[equation]`.

## Documents

The editor opens and saves `.md`, `.txt` and `.tex` as plain text: blocks separated by blank lines, `#` lines as headings, single line breaks kept. Formatting markup stays as literal text. `Ctrl/Cmd+O` opens, `Ctrl/Cmd+S` saves.

## Layout

```
src/shared/     pure TypeScript, unit-tested
  profile/      Markdown format, scope, feedback rules, blending, re-extraction diff, export/import
  coach.ts      prompts and parsing: extraction, style check, edit feedback, blend contradictions
  metrics.ts    sentence/hedge/passive measurements and drift
  spans.ts      locating quoted text after edits
  document.ts   plain-text document blocks and section detection
src/main/       Electron main process: providers, grammar engines, profile store with history, IPC
src/preload/    exposes the backend to the renderer
src/renderer/   React + TipTap UI; editor/checker.ts schedules checks and runs the teacher loop
tests/          vitest; the CLI providers are tested against stand-in binaries
```

Style suggestions point at text by quoting it, and the app finds the quote again in the paragraph, tolerating case, whitespace and typographic quotes. A suggestion whose quote is not found is dropped rather than placed at a guessed offset.

## Status

Tested here: the unit and integration tests (36), a production build, the browser preview, and the desktop app under a virtual display with a stand-in `claude` binary (inline checks, accept, profile written to disk with a history snapshot).

Not yet tested against the real services: prompt quality with real models, the `codex exec` flags against a current Codex release, and the LanguageTool adapter against a live server (it is tested against a recorded response shape).

## License

MIT
