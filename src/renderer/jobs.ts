// Long model runs (profile and rule extraction) that outlive the view that
// started them. A job and its result stay here until the result is applied or
// discarded, so you can leave the pane, keep writing and come back to review.
// The sources you added for a profile or rule set are kept here too.

import { useSyncExternalStore } from 'react';
import type { SourceDoc } from '@shared/types';

export type JobView = 'profiles' | 'rules';

export interface Job<R = unknown> {
  /** One job per target: `profiles:<id>` or `rules:<id>`. */
  key: string;
  view: JobView;
  targetId: string;
  /** Shown in the top bar and the panel, e.g. "Moves for Feynman". */
  label: string;
  mode: 'add' | 'compare';
  status: 'running' | 'done' | 'error';
  stage: string;
  startedAt: number;
  finishedAt?: number;
  /** Typical duration of this kind of run on this machine, from earlier runs. */
  expectedMs?: number;
  result?: R;
  error?: string;
}

type Listener = () => void;

const HISTORY_KEY = 'phaedrus.jobDurations';
const HISTORY_LEN = 5;

function readHistory(): Record<string, number[]> {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function remember(kind: string, ms: number) {
  try {
    const h = readHistory();
    h[kind] = [...(h[kind] ?? []), Math.round(ms)].slice(-HISTORY_LEN);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    /* storage unavailable: estimates start from scratch next time */
  }
}
function expected(kind: string): number | undefined {
  const runs = [...(readHistory()[kind] ?? [])].sort((a, b) => a - b);
  return runs.length ? runs[Math.floor(runs.length / 2)] : undefined;
}

class JobStore {
  private jobs = new Map<string, Job>();
  private drafts = new Map<string, SourceDoc[]>();
  private listeners = new Set<Listener>();
  private version = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  get<R>(key: string): Job<R> | undefined {
    return this.jobs.get(key) as Job<R> | undefined;
  }
  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  sources(key: string): SourceDoc[] {
    return this.drafts.get(key) ?? [];
  }
  setSources(key: string, docs: SourceDoc[]) {
    this.drafts.set(key, docs);
    this.emit();
  }

  /**
   * Start a run. `kind` groups runs for the duration estimate (profile and
   * rule extraction take different times). The run reports stages through
   * `stage`; its result stays on the job until cleared.
   */
  start<R>(
    meta: Pick<Job, 'key' | 'view' | 'targetId' | 'label' | 'mode'>,
    kind: string,
    run: (stage: (s: string) => void) => Promise<R>,
  ): void {
    if (this.jobs.get(meta.key)?.status === 'running') return;
    const job: Job<R> = { ...meta, status: 'running', stage: 'Starting', startedAt: Date.now(), expectedMs: expected(kind) };
    this.jobs.set(meta.key, job as Job);
    this.emit();
    const stage = (s: string) => {
      if (this.jobs.get(meta.key) !== job) return;
      job.stage = s;
      this.emit();
    };
    run(stage).then(
      (result) => {
        if (this.jobs.get(meta.key) !== job) return; // dismissed meanwhile
        job.status = 'done';
        job.finishedAt = Date.now();
        job.result = result;
        remember(kind, job.finishedAt - job.startedAt);
        this.emit();
      },
      (e: unknown) => {
        if (this.jobs.get(meta.key) !== job) return;
        job.status = 'error';
        job.finishedAt = Date.now();
        job.error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
        this.emit();
      },
    );
  }

  /** Change the result while it is reviewed (ticked entries). */
  updateResult<R>(key: string, result: R) {
    const j = this.jobs.get(key);
    if (!j) return;
    j.result = result;
    this.emit();
  }

  /** Asked to show a job's target (from the top bar): views watch `focusRequest`. */
  focusRequest: { key: string; n: number } | null = null;
  focus(key: string) {
    this.focusRequest = { key, n: (this.focusRequest?.n ?? 0) + 1 };
    this.emit();
  }

  /** Forget a job: its result was applied or discarded (a running one finishes unseen). */
  clear(key: string) {
    if (this.jobs.delete(key)) this.emit();
  }
}

export const jobs = new JobStore();

/** Re-render when any job or source list changes. */
export function useJobs(): JobStore {
  useSyncExternalStore(jobs.subscribe, jobs.getVersion);
  return jobs;
}
