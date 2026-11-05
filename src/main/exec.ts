import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const resolved = new Map<string, string>();

/**
 * GUI apps on macOS (and some Linux launchers) don't inherit the login shell's
 * PATH, so `claude` or `codex` installed via npm/brew isn't found. Ask the
 * user's login shell once and cache the answer.
 */
export async function resolveBinary(name: string): Promise<string> {
  if (name.includes('/')) return name;
  const cached = resolved.get(name);
  if (cached) return cached;
  let found = name;
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/sh';
      const { stdout } = await execFileP(shell, ['-lc', `command -v ${name}`], { timeout: 5000 });
      const p = stdout.trim().split('\n').pop();
      if (p) found = p;
    } catch {
      /* keep bare name */
    }
  }
  resolved.set(name, found);
  return found;
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
      reject(err.code === 'ENOENT' ? new Error(`Could not find "${binary}". Is it installed and on your PATH?`) : err);
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
