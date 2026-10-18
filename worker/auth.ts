import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from './index';
import { resolveSignIn, linkUserToMember } from './lib/onboarding';

export function createAuth(env: Env) {
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const check = await resolveSignIn(drizzle(env.DB), user.email, env.OWNER_EMAIL);
            if (!check.allowed) {
              throw new Error('This address is not permitted to sign in to Divvy');
            }
            return { data: user };
          },
          after: async (user) => {
            const check = await resolveSignIn(drizzle(env.DB), user.email, env.OWNER_EMAIL);
            if (check.memberId) {
              // linkUserToMember throws on a relink race (member already linked).
              // Better Auth runs `after` as a post-transaction-commit hook, so by
              // this point the user/account rows this signup created are already
              // committed — they are not rolled back on this throw. The throw does
              // propagate out of the OAuth signup call, though, and
              // better-auth/oauth2/link-account.mjs's handleOAuthUserInfo catches
              // it, returning an error instead of ever creating a session. Net
              // effect: sign-in visibly fails (no session row is created), but an
              // orphaned, unlinked user row is left behind. Both halves are
              // exercised through the real handleOAuthUserInfo call, not just
              // traced, in tests/worker/auth-hook.test.ts.
              await linkUserToMember(drizzle(env.DB), user.id, check.memberId);
            }
          },
        },
      },
    },
  });
}
