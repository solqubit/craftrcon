// Countdown for rate-limited forms (a hook, kept apart from the pure logic in
// this folder). Seconds left until `until` (ms timestamp, 0 for none),
// re-rendering every 250 ms while above zero.
import { useEffect, useState } from '../../vendor/htm-preact.js';

export function useCountdown(until) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}
