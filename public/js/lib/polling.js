// Polling for pages: a hook, kept apart from the pure logic in this folder.
import { useEffect, useRef } from '../../vendor/htm-preact.js';

// Runs `fn(isCurrent)` now and every `ms` while the tab is visible, restarting
// whenever `deps` change. `isCurrent()` turns false once that run's effect is
// gone, so a slow answer can tell it is stale.
export function usePolling(fn, ms, deps) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    let current = true;
    let timer = null;
    const isCurrent = () => current;
    const tick = () => latest.current(isCurrent);
    const start = () => {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, ms);
    };
    const stop = () => {
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();
    return () => {
      current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, deps);
}
