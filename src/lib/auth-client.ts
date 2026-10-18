import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  // Look up fetch per call: the demo replaces globalThis.fetch after this module loads.
  fetchOptions: { customFetchImpl: (input, init) => globalThis.fetch(input, init) },
});
export const { signIn, signOut, useSession } = authClient;
