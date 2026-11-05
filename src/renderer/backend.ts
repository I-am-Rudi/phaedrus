import type { Backend } from '@shared/api';

declare global {
  interface Window {
    stylecoach?: Backend;
  }
}

/**
 * The Electron preload exposes the real backend. The browser preview
 * (`npm run web`) builds with VITE_MOCK_BACKEND and uses the in-memory mock;
 * in the Electron build that branch is removed entirely.
 */
export async function loadBackend(): Promise<{ backend: Backend; mock: boolean }> {
  if (window.stylecoach) return { backend: window.stylecoach, mock: false };
  if (import.meta.env.VITE_MOCK_BACKEND) {
    const { createMockBackend } = await import('./mock');
    return { backend: createMockBackend(), mock: true };
  }
  throw new Error('stylecoach backend not available: run the desktop app (npm run dev) or the browser preview (npm run web).');
}
