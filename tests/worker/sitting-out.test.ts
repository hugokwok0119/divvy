import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1', { memberId: 'm1', displayName: 'Sam' });
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/** Mirrors tests/worker/cycle-names.test.ts's signInAs. */
async function signInAs(userId: string, email: string): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    'insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)',
  ).bind(userId, email, email, now, now).run();
  const ctx = await createAuth(testEnv).$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signed = await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret);
  return signed.split(';')[0];
}

let cookie = '';
const send = (path: string, method: string, body?: unknown, as = cookie) => workerApp.request(`http://localhost/api${path}`, {
  method, headers: { 'content-type': 'application/json', Cookie: as }, body: body === undefined ? undefined : JSON.stringify(body),
}, testEnv);
const sitOut = (id: string, sittingOut = true, as = cookie) => send(`/members/${id}/sitting-out`, 'PUT', { sittingOut }, as);
const tx = (id: string, extra: Record<string, unknown> = {}) => ({
  id, date: '2026-10-01', store: 'Shop', amountCents: 900, category: 'Other', payerId: 'm1', cardId: null,
  splitType: 'equal', splitRule: null, ...extra,
});
const shares = async (id: string) => JSON.parse((await repo().activeTransactions()).find((t) => t.id === id)!.splitSharesJson);

beforeEach(async () => {
  for (const t of ['expense_history', 'transactions', 'queue_items', 'cycles', 'cards', 'member_accounts', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0,
    allowedEmailsJson: JSON.stringify([{ email: 'hugo@example.com', memberId: 'm2' }]) });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0, role: 'owner', userId: 'u1' },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1, userId: 'u2' },
    { id: 'm3', householdId: 'h1', displayName: 'Ana', createdAt: 0, sortOrder: 2 },
  ]);
  cookie = await signInAs('u1', 'owner@example.com');
});

describe('sitting out', () => {
  it('splits a new equal expense only across members who are in', async () => {
    expect((await sitOut('m3')).status).toBe(200);
    expect((await send('/transactions', 'POST', tx('t1'))).status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('still accepts a custom split that names a member who sits out', async () => {
    await sitOut('m3');
    const res = await send('/transactions', 'POST', tx('t1', { splitType: 'custom', splitRule: { percentages: { m1: 50, m3: 50 } } }));
    expect(res.status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m3: 450 });
  });

  it('approves a Pending row across members who are in at approval', async () => {
    await repo().insertQueueItem({ id: 'q1', date: '2026-10-01', store: 'Shop', amountCents: 900, category: 'Other',
      payerId: 'm1', cardId: null, splitType: 'equal', source: 'manual' });
    await sitOut('m3');
    const res = await send('/queue/q1/confirm', 'POST', { revision: 1, transactionId: 't1', transaction: tx('t1') });
    expect(res.status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('keeps an existing expense\'s shares when someone sits out', async () => {
    await repo().insertTransaction(tx('t1') as never);
    await sitOut('m3');
    expect(await shares('t1')).toEqual({ m1: 300, m2: 300, m3: 300 });
  });

  it('re-splits to equal without members who sit out', async () => {
    await repo().insertTransaction(tx('t1', { splitType: 'custom', splitRule: { percentages: { m1: 60, m2: 40 } } }) as never);
    await sitOut('m3');
    const res = await send('/transactions/t1', 'PATCH', { revision: 1, splitType: 'equal', splitRule: null });
    expect(res.status).toBe(200);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('refuses to sit out the last member who is in', async () => {
    await sitOut('m2');
    await sitOut('m3');
    const res = await sitOut('m1');
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/At least one member must stay in/);
    expect((await sitOut('m3', false)).status).toBe(200);
  });

  it('rejects a non-boolean and an unknown member', async () => {
    expect((await send('/members/m3/sitting-out', 'PUT', { sittingOut: 'yes' })).status).toBe(400);
    expect((await sitOut('nope')).status).toBe(404);
  });

  it('lets only the owner change sitting out', async () => {
    const member = await signInAs('u2', 'hugo@example.com');
    expect((await sitOut('m3', true, member)).status).toBe(403);
  });

  it('returns sittingOutAt in bootstrap members', async () => {
    const res = await sitOut('m3');
    expect(await res.json()).toMatchObject({ id: 'm3', sittingOutAt: expect.any(Number) });
    const boot = await (await send('/bootstrap', 'GET')).json() as { members: Array<{ id: string; sittingOutAt: number | null }> };
    expect(boot.members.map((m) => [m.id, m.sittingOutAt === null])).toEqual([['m1', true], ['m2', true], ['m3', false]]);
  });
});
