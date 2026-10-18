import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, cards, cycles } from '../../worker/db/schema';
import { ScopedRepository, requireScope, requireOwner, type Scope } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/**
 * Creates a real `user` row and a real, signed session cookie for it via
 * Better Auth's own internal adapter and cookie-signing code (not a mock),
 * so `requireScope`'s call to `createAuth(env).api.getSession()` resolves
 * exactly as it would for a real request.
 */
async function signInAs(userId: string, email: string): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    'insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)',
  ).bind(userId, email, email, now, now).run();

  const ctx = await createAuth(testEnv).$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signed = await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret);
  return signed.split(';')[0]; // "name=value", stripping Set-Cookie attributes
}

/** A tiny probe app exercising requireScope exactly as a real route would. */
function probeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/probe', async (c) => {
    const scope = await requireScope(c);
    return c.json({ householdId: scope.householdId, memberId: scope.memberId, role: scope.role });
  });
  return app;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM cycles');
  await env.DB.exec('DELETE FROM cards');
  await env.DB.exec('DELETE FROM household_members');
  await env.DB.exec('DELETE FROM households');
  await env.DB.exec('DELETE FROM session');
  await env.DB.exec('DELETE FROM user');

  await db().insert(households).values([
    { id: 'h1', name: 'Ours', createdAt: 0, allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm1' }]) },
    { id: 'h2', name: 'Theirs', createdAt: 0 },
  ]);
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1, role: 'owner' },
    { id: 'm3', householdId: 'h1', displayName: 'Gone', createdAt: 0, sortOrder: 2, archivedAt: 5 },
    { id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0 },
  ]);
  await db().insert(cards).values([
    { id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Amex' },
    { id: 'xc1', householdId: 'h2', memberId: 'x1', name: 'Visa' },
  ]);
  await db().insert(cycles).values([
    { id: 'cy1', householdId: 'h1', closedAt: 0 },
    { id: 'xcy1', householdId: 'h2', closedAt: 0 },
  ]);
});

describe('ScopedRepository', () => {
  const repo = () => new ScopedRepository(db(), 'h1');

  it('returns only its own household members', async () => {
    const ids = (await repo().members()).map((m) => m.id);
    expect(ids.sort()).toEqual(['m1', 'm2', 'm3']);
    expect(ids).not.toContain('x1');
  });

  it('excludes archived members from the roster', async () => {
    expect(await repo().roster()).toEqual(['m1', 'm2']);
  });

  it('returns only its own cards', async () => {
    const ids = (await repo().cards()).map((c) => c.id);
    expect(ids).toEqual(['c1']);
  });

  it('accepts references it owns', async () => {
    await expect(repo().assertOwns({ payerId: 'm1', cardId: 'c1' })).resolves.toBeUndefined();
  });

  it('rejects a payer from another household', async () => {
    await expect(repo().assertOwns({ payerId: 'x1' })).rejects.toThrow(/payer/i);
  });

  it('rejects a card from another household', async () => {
    await expect(repo().assertOwns({ cardId: 'xc1' })).rejects.toThrow(/card/i);
  });

  it('rejects a card that belongs to a different payer', async () => {
    await expect(repo().assertOwns({ payerId: 'm2', cardId: 'c1' })).rejects.toThrow(/payer/i);
  });

  it('rejects an id that does not exist at all', async () => {
    await expect(repo().assertOwns({ payerId: 'nope' })).rejects.toThrow();
  });

  it('accepts a null card', async () => {
    await expect(repo().assertOwns({ payerId: 'm1', cardId: null })).resolves.toBeUndefined();
  });

  it('accepts a cycle it owns', async () => {
    await expect(repo().assertOwns({ cycleId: 'cy1' })).resolves.toBeUndefined();
  });

  it('rejects a cycle from another household', async () => {
    await expect(repo().assertOwns({ cycleId: 'xcy1' })).rejects.toThrow(/cycle/i);
  });
});

describe('requireOwner', () => {
  const ownerScope: Scope = { householdId: 'h1', memberId: 'm2', role: 'owner', repo: new ScopedRepository(db(), 'h1') };
  const memberScope: Scope = { householdId: 'h1', memberId: 'm1', role: 'member', repo: new ScopedRepository(db(), 'h1') };

  it('passes for an owner scope', () => {
    expect(() => requireOwner(ownerScope)).not.toThrow();
  });

  it('rejects a non-owner scope', () => {
    expect(() => requireOwner(memberScope)).toThrow();
  });
});

describe('requireScope', () => {
  it('throws 401 when there is no session', async () => {
    const res = await probeApp().request('http://localhost/probe', {}, testEnv);
    expect(res.status).toBe(401);
  });

  it('throws 403 when the signed-in user has no household membership', async () => {
    const cookie = await signInAs('u-orphan', 'orphan@example.com');
    const res = await probeApp().request('http://localhost/probe', { headers: { Cookie: cookie } }, testEnv);
    expect(res.status).toBe(403);
  });

  it('resolves a scope for an allowlisted member', async () => {
    await db().update(householdMembers).set({ userId: 'u-sam' }).where(eq(householdMembers.id, 'm1'));
    const cookie = await signInAs('u-sam', 'sam@example.com');
    const res = await probeApp().request('http://localhost/probe', { headers: { Cookie: cookie } }, testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ householdId: 'h1', memberId: 'm1', role: 'member' });
  });

  it('throws 403 once the caller has been removed from the allowlist', async () => {
    await db().update(householdMembers).set({ userId: 'u-sam' }).where(eq(householdMembers.id, 'm1'));
    const cookie = await signInAs('u-sam', 'sam@example.com');

    // Simulate revocation: the household's allowlist no longer names this address.
    await db().update(households).set({ allowedEmailsJson: '[]' }).where(eq(households.id, 'h1'));

    const res = await probeApp().request('http://localhost/probe', { headers: { Cookie: cookie } }, testEnv);
    expect(res.status).toBe(403);
  });

  it('allows the owner even when absent from the allowlist', async () => {
    await db().update(householdMembers).set({ userId: 'u-hugo' }).where(eq(householdMembers.id, 'm2'));
    const cookie = await signInAs('u-hugo', 'owner@example.com');
    // owner@example.com is intentionally not in h1's allowedEmailsJson (only sam@example.com is).
    const res = await probeApp().request('http://localhost/probe', { headers: { Cookie: cookie } }, testEnv);
    expect(res.status).toBe(200);
  });
});

// Regression: the guard in worker/index.ts must not bypass requireScope for a
// path that merely *starts with* '/api/auth' without the trailing slash — a
// future route like /api/authz would otherwise skip auth entirely. Registered
// directly on the real exported app (not a reimplementation of the guard),
// after import, the same way a later task's route file would register it.
describe('the /api/auth prefix guard on the real app', () => {
  workerApp.get('/api/authz', (c) => c.json({ reached: true }));

  it('still requires a session for a route that only starts with /api/auth', async () => {
    const res = await workerApp.request('http://localhost/api/authz', {}, testEnv);
    expect(res.status).toBe(401);
  });
});
