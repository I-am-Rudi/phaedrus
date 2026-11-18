// Progress of background extractions: in the panel that started them, and as
// chips in the title bar, so a run is visible (and its result reachable) from
// every view.

import { useEffect, useState } from 'react';
import { jobs, useJobs, type Job } from './jobs';
import { useApp } from './state';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Share of the run that is probably done, from earlier runs; null when there is nothing to go by. */
function fraction(job: Job, now: number): number | null {
  if (job.status !== 'running') return 1;
  if (!job.expectedMs) return null;
  return Math.min(0.95, (now - job.startedAt) / job.expectedMs);
}

export function JobProgress({ job }: { job: Job }) {
  const now = useNow(job.status === 'running');
  const elapsed = (job.finishedAt ?? now) - job.startedAt;
  const f = fraction(job, now);
  let eta = '';
  if (job.status === 'running' && job.expectedMs) {
    eta = elapsed < job.expectedMs ? `about ${clock(job.expectedMs - elapsed)} left` : 'taking longer than usual';
  }
  return (
    <div className="job-progress" role="status">
      <div className={`progress${f === null ? ' indeterminate' : ''}`}>
        <i style={f === null ? undefined : { width: `${f * 100}%` }} />
      </div>
      <div className="small muted">
        {job.stage} · {clock(elapsed)}
        {eta && ` · ${eta}`}
      </div>
      <div className="small muted">You can leave this page and keep working. The run continues, and the top bar shows when the result is ready.</div>
    </div>
  );
}

/** Chips in the title bar for runs in progress and results waiting for review. */
export function JobsIndicator() {
  const store = useJobs();
  const app = useApp();
  const list = store.list();
  const running = list.some((j) => j.status === 'running');
  const now = useNow(running);
  if (!list.length) return null;
  return (
    <div className="jobs">
      {list.map((j) => {
        const f = fraction(j, now);
        const text = j.status === 'running' ? `${j.label} · ${clock(now - j.startedAt)}` : j.status === 'done' ? `${j.label} ready` : `${j.label} failed`;
        return (
          <button
            key={j.key}
            className={`job-chip ${j.status}`}
            title={j.status === 'running' ? `${j.stage}. Click to open.` : j.status === 'done' ? 'Click to review the result.' : j.error}
            onClick={() => {
              jobs.focus(j.key);
              app.go(j.view, j.targetId);
            }}
          >
            {j.status === 'running' ? (
              <span className={`chip-bar${f === null ? ' indeterminate' : ''}`}>
                <i style={f === null ? undefined : { width: `${f * 100}%` }} />
              </span>
            ) : (
              <span className="chip-dot" />
            )}
            <span className="chip-text">{text}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Whether a view has a run going or a result waiting (for the side rail). */
export function useViewHasJobs(view: Job['view']): boolean {
  return useJobs()
    .list()
    .some((j) => j.view === view);
}

/** Before the window closes: running extractions and unreviewed results would be lost. */
export function useJobsCloseGuard() {
  const { registerGuard, ask } = useApp();
  useEffect(
    () =>
      registerGuard('jobs', async () => {
        const list = jobs.list().filter((j) => j.status !== 'error');
        if (!list.length) return true;
        const running = list.filter((j) => j.status === 'running').length;
        const v = await ask({
          title: running ? 'An extraction is still running' : 'Extraction results are waiting',
          message: `${list.map((j) => j.label).join(', ')}. Closing now loses ${running ? 'the run' : 'the results you have not reviewed'}.`,
          buttons: [
            { label: 'Close anyway', value: 'close', key: 'c' },
            { label: 'Keep open', value: 'stay', key: 'k', primary: true },
          ],
          cancel: 'stay',
        });
        return v === 'close';
      }),
    [registerGuard, ask],
  );
}
