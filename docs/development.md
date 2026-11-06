# Developing Phaedrus

Building, releasing and finding your way around the code. The user guide is [README.md](README.md) in this folder.

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

## Releases

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
