// Pure module: no React, no DOM API, no `?url` assets. The Workers-runtime parity test loads it.
// Security boundary of demo mode: no same-origin `/api` request may ever reach `original`.
import { json } from './http';

/** True when `url` is same-origin and its normalized, percent-decoded path is `/api` or under `/api/`, ignoring case. */
const isLocalApi = (url: URL, origin: string) => {
  // The worker router decodes escapes (`/%61pi` routes as `/api`), so decode too; this form cannot throw.
  const path = url.pathname.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).toLowerCase();
  return url.origin === new URL(origin).origin && (path === '/api' || path.startsWith('/api/'));
};

export function demoFetch(
  original: typeof fetch,
  origin: string,
  handle: (request: Request) => Promise<Response>,
): typeof fetch {
  return async (input, init) => {
    // `new URL` resolves `..` and `%2e%2e` segments; isLocalApi then compares the origin and the decoded, lowercased path.
    const url = input instanceof Request ? new URL(input.url) : new URL(input, origin);
    if (!isLocalApi(url, origin)) return original(input, init);
    // Built like fetch builds it: a Request input merges `init` overrides; method, headers, body and signal carry over.
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    try {
      return await handle(request);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return json({ error: 'Demo error. Nothing was saved.' }, 500);
    }
  };
}
