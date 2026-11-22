import { useEffect, useState } from 'react';

/**
 * GitHub Pages lets browsers cache the page for ~10 minutes, and home-screen
 * apps can hold on to an old version even longer. Check for a newer build
 * and offer a reload.
 */

const currentScript = () =>
  [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map((s) => new URL(s.src).pathname)
    .find((p) => /\/assets\/index-[\w-]+\.js$/.test(p)) ?? null;

export const BUILD = (currentScript()?.match(/index-([\w-]+)\.js$/)?.[1] ?? 'dev').slice(0, 8);

async function latestScript(): Promise<string | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}index.html?v=${Date.now()}`, { cache: 'no-store' });
    const html = await r.text();
    const m = /src="([^"]*\/assets\/index-[\w-]+\.js)"/.exec(html);
    return m ? new URL(m[1], window.location.href).pathname : null;
  } catch {
    return null;
  }
}

export function useUpdateAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const mine = currentScript();
    if (!mine) return; // dev server
    const check = async () => {
      const latest = await latestScript();
      if (latest && latest !== mine) setAvailable(true);
    };
    void check();
    const onVis = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(check, 5 * 60000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, []);
  return available;
}

/** Reload, bypassing the cached page, and keep any #join / #device code in the URL. */
export function reloadToLatest() {
  const u = new URL(window.location.href);
  u.searchParams.set('v', String(Date.now()));
  window.location.replace(u.toString());
}
