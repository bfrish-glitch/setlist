import { useSyncExternalStore } from 'react';

/** Bumped whenever any source's connection status changes, so the UI re-renders. */
let version = 0;
const listeners = new Set<() => void>();

export function notifySourcesChanged() {
  version++;
  listeners.forEach((l) => l());
}

export function useSourcesVersion() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
}
