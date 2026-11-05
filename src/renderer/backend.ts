import type { AppEvents, Backend } from '@shared/api';

declare global {
  interface Window {
    phaedrus?: Backend;
    phaedrusEvents?: AppEvents;
  }
}

/**
 * The Electron preload exposes the real backend. The browser preview
 * (`npm run web`) builds with VITE_MOCK_BACKEND and uses the in-memory mock;
 * in the Electron build that branch is removed entirely.
 */
export async function loadBackend(): Promise<{ backend: Backend; events: AppEvents; mock: boolean }> {
  if (window.phaedrus && window.phaedrusEvents) return { backend: window.phaedrus, events: window.phaedrusEvents, mock: false };
  if (import.meta.env.VITE_MOCK_BACKEND) {
    const { createMockBackend, createMockEvents } = await import('./mock');
    return { backend: createMockBackend(), events: createMockEvents(), mock: true };
  }
  throw new Error('phaedrus backend not available: run the desktop app (npm run dev) or the browser preview (npm run web).');
}
