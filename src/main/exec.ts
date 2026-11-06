import { spawn, execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const MARK = '__PHAEDRUS_PATH__';

/** Where the usual installers put claude, codex and node, in case the shell does not say. */
function fallbackDirs(): string[] {
  const home = homedir();
  const user = process.env.USER ?? '';
  return [
    join(home, '.local/bin'), // Claude Code's native installer
    join(home, '.claude/local'),
    join(home, '.npm-global/bin'),
    join(home, '.volta/bin'),
    join(home, '.bun/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.nix-profile/bin'),
    `/etc/profiles/per-user/${user}/bin`, // nix-darwin and NixOS with home-manager
    '/run/current-system/sw/bin',
  ];
}

/** PATH as the user's interactive login shell sets it, or null if the shell does not answer. */
async function shellPath(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/sh';
  // fish keeps PATH as a list; every other common shell has it colon-separated.
  const print = basename(shell) === 'fish' ? `printf '${MARK}%s${MARK}' (string join : $PATH)` : `printf '${MARK}%s${MARK}' "$PATH"`;
  try {
    // -i as well as -l: zsh reads ~/.zshrc only for interactive shells, and that
    // is where most installers (Claude Code's among them) add to PATH. The markers
    // cut the value out of whatever the rc files print themselves.
    const { stdout } = await execFileP(shell, ['-ilc', print], {
      timeout: 5000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' }, // keep oh-my-zsh from updating here
    });
    const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

let pathReady: Promise<void> | null = null;

/**
 * GUI apps on macOS (and some Linux launchers) start with a minimal PATH, so
 * claude, codex, and the node an npm-installed CLI runs on are not found. Merge
 * the login shell's PATH and the usual install folders into process.env.PATH
 * once, so the CLIs and everything they start see what a terminal would.
 */
export function ensureUserPath(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  pathReady ??= (async () => {
    const parts = [...((await shellPath()) ?? '').split(delimiter), ...(process.env.PATH ?? '').split(delimiter), ...fallbackDirs()];
    process.env.PATH = [...new Set(parts.filter(Boolean))].join(delimiter);
  })();
  return pathReady;
}

/** Absolute path of an executable on PATH, or the name unchanged if none is found. */
export async function resolveBinary(name: string): Promise<string> {
  if (name.includes('/') || name.includes('\\')) return name;
  await ensureUserPath();
  if (process.platform === 'win32') return name;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return name; // not cached: a CLI installed while the app runs is found on the next call
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function run(
  binary: string,
  args: string[],
  opts: { input?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const bin = await resolveBinary(binary);
  await ensureUserPath(); // also for an absolute binary: npm CLIs need node on PATH
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${binary} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s`));
    }, opts.timeoutMs ?? 180_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`Could not find "${binary}". Is it installed? If it is, set its full path in Settings (run "command -v ${binary}" in a terminal to see it).`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** Start an interactive login (opens a browser) and return its output when it exits. */
export async function runDetachedLogin(binary: string, args: string[]): Promise<RunResult> {
  return run(binary, args, { timeoutMs: 10 * 60_000 });
}
