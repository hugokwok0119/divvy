import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import { createAuth } from '../../worker/auth';
import type { Env } from '../../worker/index';
import { households, householdMembers } from '../../worker/db/schema';

// Exercises the real Better Auth OAuth-signup path (internalAdapter.createOAuthUser,
// the same call Google callback handling makes) to prove the `databaseHooks.user.create.before`
// gate in worker/auth.ts actually stops the user row from being written, not just that
// resolveSignIn() returns the right boolean in isolation.
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

const userCount = async () => {
  const row = await env.DB.prepare('SELECT COUNT(*) as c FROM user').first<{ c: number }>();
  return row?.c ?? 0;
};

const sessionCount = async () => {
  const row = await env.DB.prepare('SELECT COUNT(*) as c FROM session').first<{ c: number }>();
  return row?.c ?? 0;
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM session');
  await env.DB.exec('DELETE FROM account');
  await env.DB.exec('DELETE FROM user');
  await env.DB.exec('DELETE FROM household_members');
  await env.DB.exec('DELETE FROM households');
});

describe('databaseHooks gate on real Better Auth signup', () => {
  it('refuses a non-owner address before any household exists, and creates no user row', async () => {
    const ctx = await createAuth(testEnv).$context;

    await expect(
      ctx.internalAdapter.createOAuthUser(
        { name: 'Stranger', email: 'stranger@example.com', emailVerified: true },
        { providerId: 'google', accountId: 'g-stranger' },
      ),
    ).rejects.toThrow();

    expect(await userCount()).toBe(0);
  });

  it('allows the owner address to bootstrap and creates the user row', async () => {
    const ctx = await createAuth(testEnv).$context;

    await ctx.internalAdapter.createOAuthUser(
      { name: 'Owner', email: 'owner@example.com', emailVerified: true },
      { providerId: 'google', accountId: 'g-owner' },
    );

    expect(await userCount()).toBe(1);
  });

  it('links the owner address to the pre-seeded owner member', async () => {
    const db = drizzle(env.DB);
    await db.insert(households).values({
      id: 'h1',
      name: 'Divvy',
      createdAt: 0,
      allowedEmailsJson: '[]',
    });
    await db.insert(householdMembers).values({
      id: 'owner-member',
      householdId: 'h1',
      displayName: 'Owner',
      role: 'owner',
      createdAt: 0,
      userId: null,
    });

    const ctx = await createAuth(testEnv).$context;
    const { user } = await ctx.internalAdapter.createOAuthUser(
      { name: 'Owner', email: 'owner@example.com', emailVerified: true },
      { providerId: 'google', accountId: 'g-owner' },
    );

    const row = await env.DB.prepare('SELECT user_id FROM household_members WHERE id = ?')
      .bind('owner-member')
      .first<{ user_id: string | null }>();
    expect(row?.user_id).toBe(user.id);
  });

  it('links a fresh signup to its pre-seeded member slot through the real after hook', async () => {
    const db = drizzle(env.DB);
    await db.insert(households).values({
      id: 'h1',
      name: 'Divvy',
      createdAt: 0,
      allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm1' }]),
    });
    await db.insert(householdMembers).values({
      id: 'm1',
      householdId: 'h1',
      displayName: 'Sam',
      createdAt: 0,
      userId: null,
    });

    const ctx = await createAuth(testEnv).$context;
    const { user } = await ctx.internalAdapter.createOAuthUser(
      { name: 'Sam', email: 'sam@example.com', emailVerified: true },
      { providerId: 'google', accountId: 'g-sam' },
    );

    const row = await env.DB.prepare('SELECT user_id FROM household_members WHERE id = ?')
      .bind('m1')
      .first<{ user_id: string | null }>();
    expect(row?.user_id).toBe(user.id);
  });

  // Traces the state left behind when the `after` hook's linkUserToMember throws
  // (member already linked — e.g. a relink race). See the comment on the `after`
  // hook in worker/auth.ts for what this means for the caller.
  //
  // Drives `handleOAuthUserInfo`, the real layer above `internalAdapter.createOAuthUser`
  // where Better Auth's Google-callback route creates the session — not
  // `createOAuthUser` directly. That matters here: asserting "no session" against
  // a call that sits *below* session creation would pass trivially regardless of
  // whether the failure path actually stops a session from being issued.
  // `handleOAuthUserInfo` only needs already-resolved `userInfo`/`account`
  // objects (the shape a provider's token exchange would hand it), so no OAuth
  // provider or token exchange needs to be mocked to exercise it for real.
  it('a relink attempt in the after hook fails sign-in but leaves the user row committed', async () => {
    const db = drizzle(env.DB);
    await db.insert(households).values({
      id: 'h1',
      name: 'Divvy',
      createdAt: 0,
      allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm1' }]),
    });
    await db.insert(householdMembers).values({
      id: 'm1',
      householdId: 'h1',
      displayName: 'Sam',
      createdAt: 0,
      userId: 'already-linked-user',
    });

    const ctx = await createAuth(testEnv).$context;
    const c = {
      context: ctx,
      request: new Request('http://localhost/api/auth/callback/google'),
    } as unknown as Parameters<typeof handleOAuthUserInfo>[0];

    // The before hook allows this: sam@example.com is on the allowlist. The
    // after hook's linkUserToMember is what fails, because m1 is already linked.
    const result = await handleOAuthUserInfo(c, {
      userInfo: { id: 'g-sam-2', name: 'Sam', email: 'sam@example.com', emailVerified: true },
      account: { providerId: 'google', accountId: 'g-sam-2' },
    });

    // Sign-in visibly failed: handleOAuthUserInfo returns an error, not a
    // session, and no row lands in `session`.
    expect(result.data).toBeNull();
    expect(result.error).toBeTruthy();
    expect(await sessionCount()).toBe(0);

    // But the user/account rows were already committed by the time the after
    // hook ran (it's a post-transaction-commit hook — see worker/auth.ts), so
    // they are not rolled back: one orphaned, unlinked user row is left behind.
    expect(await userCount()).toBe(1);
  });
});
