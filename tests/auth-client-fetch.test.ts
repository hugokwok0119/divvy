import { afterEach, expect, it, vi } from 'vitest';
import { authClient } from '../src/lib/auth-client';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Demo mode replaces globalThis.fetch after the auth client module has loaded.
it('sends Better Auth requests through the current globalThis.fetch', async () => {
  const spy = vi.fn<typeof fetch>(async () => Response.json(null));
  globalThis.fetch = spy;
  // A captured real fetch rejects the relative URL in node; the spy assertion is the check.
  await authClient.getSession().catch(() => undefined);
  expect(spy).toHaveBeenCalled();
  const input = spy.mock.calls[0][0];
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  expect(url).toMatch(/\/api\/auth\/get-session$/);
});
