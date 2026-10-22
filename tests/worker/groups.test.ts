import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, memberAccounts, queueItems } from '../../worker/db/schema';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/** Mirrors tests/worker/scope.test.ts's signInAs: a real session via Better Auth's own adapter. */
async function signInAs(userId: string, email: string, name = email): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    'insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)',
  ).bind(userId, name, email, now, now).run();

  const ctx = await createAuth(testEnv).$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signed = await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret);
  return signed.split(';')[0];
}

const call = (cookie: string | null, method = 'GET', body?: unknown) => workerApp.request('http://localhost/api/groups', {
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}, testEnv);

const queued = (id: string, householdId: string) => ({ id, householdId, expenseId: id, store: 'Uber', source: 'manual', createdAt: 0 });

beforeEach(async () => {
  for (const t of ['queue_items', 'member_accounts', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values([
    { id: 'h1', name: 'Ours', createdAt: 0 },
    { id: 'h2', name: 'Trip', createdAt: 0 },
  ]);
  // u1 owns h1 through user_id (mirrored by the trigger) and is a member of h2 through a direct link.
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', userId: 'u1', role: 'owner', displayName: 'Hugo', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 1 },
    { id: 'm3', householdId: 'h1', displayName: 'Gone', createdAt: 0, sortOrder: 2, archivedAt: 1 },
    { id: 'm9', householdId: 'h2', displayName: 'Hugo', createdAt: 0, sortOrder: 0 },
  ]);
  await db().insert(memberAccounts).values({ memberId: 'm9', householdId: 'h2', userId: 'u1', linkedAt: 2 });
  // Pin the trigger's link time so h1 sorts before h2, and both before a group created now.
  await db().update(memberAccounts).set({ linkedAt: 1 }).where(eq(memberAccounts.memberId, 'm1'));
  await db().insert(queueItems).values([queued('q1', 'h1'), queued('q2', 'h1'), queued('q3', 'h1')]);
});

describe('GET /api/groups', () => {
  it('lists the caller\'s groups with people and pending counts', async () => {
    const res = await call(await signInAs('u1', 'owner@example.com'));
    expect(res.status).toBe(200);
    expect((await res.json() as { groups: unknown }).groups).toEqual([
      { id: 'h1', name: 'Ours', role: 'owner', memberId: 'm1', peopleCount: 2, pendingCount: 3 },
      { id: 'h2', name: 'Trip', role: 'member', memberId: 'm9', peopleCount: 1, pendingCount: 0 },
    ]);
  });

  it('leaves out a group where the caller\'s member is archived', async () => {
    await db().update(householdMembers).set({ archivedAt: 1 }).where(eq(householdMembers.id, 'm9'));
    const res = await call(await signInAs('u1', 'owner@example.com'));
    expect((await res.json() as { groups: Array<{ id: string }> }).groups.map((g) => g.id)).toEqual(['h1']);
  });

  it('leaves out a group whose allowlist no longer has the caller\'s email', async () => {
    await db().update(households)
      .set({ allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm2' }]) })
      .where(eq(households.id, 'h1'));
    await db().update(householdMembers).set({ userId: 'u2' }).where(eq(householdMembers.id, 'm2'));
    await db().insert(householdMembers).values({ id: 'm8', householdId: 'h2', displayName: 'Sam', createdAt: 0, sortOrder: 1 });
    await db().insert(memberAccounts).values({ memberId: 'm8', householdId: 'h2', userId: 'u2', linkedAt: 3 });

    const res = await call(await signInAs('u2', 'Sam@Example.com'));
    expect((await res.json() as { groups: Array<{ id: string }> }).groups.map((g) => g.id)).toEqual(['h1']);
  });

  it('says only the owner email can create groups', async () => {
    const owner = await call(await signInAs('u1', ' Owner@Example.com '));
    expect(await owner.json()).toMatchObject({ canCreate: true });
    const other = await call(await signInAs('u2', 'sam@example.com'));
    expect(await other.json()).toEqual({ groups: [], canCreate: false });
  });
});

describe('POST /api/groups', () => {
  const input = { name: '  Ski trip ', currencyCode: 'USD', timezone: 'America/Denver' };

  it('creates a group with the caller as its linked owner', async () => {
    const cookie = await signInAs('u1', 'owner@example.com', 'Hugo Kwok');
    const res = await call(cookie, 'POST', input);
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; memberId: string };
    expect(created).toMatchObject({ name: 'Ski trip', role: 'owner', peopleCount: 1, pendingCount: 0 });

    const listed = await (await call(cookie)).json() as { groups: Array<{ id: string }> };
    expect(listed.groups.map((g) => g.id)).toEqual(['h1', 'h2', created.id]);

    const [household] = await db().select().from(households).where(eq(households.id, created.id));
    expect(household).toMatchObject({ currencyCode: 'USD', timezone: 'America/Denver', rentReminder: 0, allowedEmailsJson: '[]' });
    const [member] = await db().select().from(householdMembers).where(eq(householdMembers.id, created.memberId));
    expect(member).toMatchObject({ householdId: created.id, displayName: 'Hugo Kwok', role: 'owner', userId: null });
    const [link] = await db().select().from(memberAccounts).where(eq(memberAccounts.memberId, created.memberId));
    expect(link).toMatchObject({ householdId: created.id, userId: 'u1' });

    // The new group is usable through requireScope.
    const scoped = await workerApp.request('http://localhost/api/members', { headers: { Cookie: cookie, 'x-divvy-group': created.id } }, testEnv);
    expect(scoped.status).toBe(200);
  });

  it('names the owner member Owner when the account has no name', async () => {
    const res = await call(await signInAs('u1', 'owner@example.com', '   '), 'POST', input);
    expect(res.status).toBe(201);
    const { memberId } = await res.json() as { memberId: string };
    const [member] = await db().select().from(householdMembers).where(eq(householdMembers.id, memberId));
    expect(member.displayName).toBe('Owner');
  });

  it('refuses group creation from a non-owner account', async () => {
    const res = await call(await signInAs('u2', 'sam@example.com'), 'POST', input);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the owner can create groups' });
    expect(await db().select().from(households)).toHaveLength(2);
  });

  it('rejects a bad currency or timezone', async () => {
    const res = await call(await signInAs('u1', 'owner@example.com'), 'POST', { name: 'Trip', currencyCode: 'usd', timezone: 'Mars/Base' });
    expect(res.status).toBe(400);
    const body = await res.json() as { fields: Record<string, string> };
    expect(Object.keys(body.fields).sort()).toEqual(['currencyCode', 'timezone']);
  });
});

describe('/api/groups without a session', () => {
  it('needs a session', async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call(null, 'POST', { name: 'Trip', currencyCode: 'USD', timezone: 'UTC' })).status).toBe(401);
  });
});
