// Hash routes: "#/dashboard", "#/console", ... Unknown hashes show the dashboard.
import { useEffect, useState } from '../vendor/htm-preact.js';

export const ROUTES = ['dashboard', 'console', 'players', 'moderation', 'world', 'tasks', 'servers', 'settings'];
export const DEFAULT_ROUTE = 'dashboard';

export function parseHash(hash) {
  const name = String(hash ?? '').replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}

export const href = (route) => `#/${route}`;

export function navigate(route) {
  location.hash = href(route);
}

// The current route; re-renders the caller when the hash changes.
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
