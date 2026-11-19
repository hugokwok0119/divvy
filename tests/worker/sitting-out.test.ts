import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const setRoster = (ids: string[], as = cookie) => send('/members/roster', 'PUT', { in: ids }, as);
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

const queued = (id = 'q1') => repo().insertQueueItem({ id, date: '2026-10-01', store: 'Shop', amountCents: 900, category: 'Other',
  payerId: 'm1', cardId: null, splitType: 'equal', source: 'manual' });
const outAt = async () => Object.fromEntries((await repo().members()).map((m) => [m.id, m.sittingOutAt]));
const confirmedAt = async () => (await repo().household()).rosterConfirmedAt;

describe('sitting out', () => {
  it('splits a new equal expense only across members who are in', async () => {
    expect((await setRoster(['m1', 'm2'])).status).toBe(200);
    expect((await send('/transactions', 'POST', tx('t1'))).status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('still accepts a custom split that names a member who sits out', async () => {
    await setRoster(['m1', 'm2']);
    const res = await send('/transactions', 'POST', tx('t1', { splitType: 'custom', splitRule: { percentages: { m1: 50, m3: 50 } } }));
    expect(res.status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m3: 450 });
  });

  it('approves a Pending row across members who are in at approval', async () => {
    await setRoster(['m1', 'm2']);
    await queued();
    const res = await send('/queue/q1/confirm', 'POST', { revision: 1, transactionId: 't1', transaction: tx('t1') });
    expect(res.status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('splits a Pending row\'s split child across members who are in', async () => {
    await setRoster(['m1', 'm2']);
    await queued();
    expect((await send('/queue/q1/split', 'POST', { revision: 1, queueItemId: 'q2', amountCents: 300 })).status).toBe(200);
    const res = await send('/queue/q2/confirm', 'POST', { revision: 1, transactionId: 't2', transaction: tx('t2', { amountCents: 300 }) });
    expect(res.status).toBe(201);
    expect(await shares('t2')).toEqual({ m1: 150, m2: 150 });
  });

  it('re-splits to equal without members who sit out', async () => {
    await setRoster(['m1', 'm2']);
    await repo().insertTransaction(tx('t1', { splitType: 'custom', splitRule: { percentages: { m1: 60, m2: 40 } } }) as never);
    const res = await send('/transactions/t1', 'PATCH', { revision: 1, splitType: 'equal', splitRule: null });
    expect(res.status).toBe(200);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('splits a bulk-imported equal row only across members who are in', async () => {
    await setRoster(['m1', 'm2']);
    expect((await send('/transactions/bulk', 'POST', { transactions: [tx('t1')] })).status).toBe(201);
    expect(await shares('t1')).toEqual({ m1: 450, m2: 450 });
  });

  it('refuses to archive the last member who is in', async () => {
    await setRoster(['m2']);
    const res = await send('/members/m2', 'DELETE');
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/At least one member must stay in/);
    expect((await repo().members()).every((m) => m.archivedAt === null)).toBe(true);
  });

  it('returns sittingOutAt in bootstrap members', async () => {
    const res = await setRoster(['m1', 'm2']);
    expect(await res.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'm3', sittingOutAt: expect.any(Number) })]));
    const boot = await (await send('/bootstrap', 'GET')).json() as { members: Array<{ id: string; sittingOutAt: number | null }> };
    expect(boot.members.map((m) => [m.id, m.sittingOutAt === null])).toEqual([['m1', true], ['m2', true], ['m3', false]]);
  });
});

describe('who is in', () => {
  it('saves who is in and stamps rosterConfirmedAt', async () => {
    let boot = await (await send('/bootstrap', 'GET')).json() as { household: { rosterConfirmedAt: number | null } };
    expect(boot.household.rosterConfirmedAt).toBeNull();
    expect((await setRoster(['m1', 'm3'])).status).toBe(200);
    expect(await outAt()).toEqual({ m1: null, m2: expect.any(Number), m3: null });
    boot = await (await send('/bootstrap', 'GET')).json() as { household: { rosterConfirmedAt: number | null } };
    expect(boot.household.rosterConfirmedAt).toEqual(expect.any(Number));
  });

  it('keeps sittingOutAt for a member already out', async () => {
    await setRoster(['m1', 'm2']);
    const before = (await outAt()).m3;
    await new Promise((r) => setTimeout(r, 5));
    await setRoster(['m1']);
    const after = await outAt();
    expect(after.m3).toBe(before);
    expect(after.m2).toEqual(expect.any(Number));
    expect(after.m1).toBeNull();
  });

  it('refuses an empty list, duplicates, and an archived or unknown member', async () => {
    await repo().archiveMember('m3');
    for (const ids of [[], ['m1', 'm1'], ['m1', 'm3'], ['m1', 'nope']]) {
      expect((await setRoster(ids)).status).toBe(400);
    }
    expect(await confirmedAt()).toBeNull();
    expect(await outAt()).toEqual({ m1: null, m2: null, m3: null });
  });

  it('refuses changes while the cycle has a Pending row', async () => {
    await setRoster(['m1', 'm2']);
    const [members, stamp] = [await outAt(), await confirmedAt()];
    await queued();
    const res = await setRoster(['m1']);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Who is in is locked while this cycle has expenses/);
    expect(await outAt()).toEqual(members);
    expect(await confirmedAt()).toBe(stamp);
  });

  it('refuses changes when an expense lands between the check and the save', async () => {
    await queued();
    // The early check misses the row, as if it arrived just after; the guarded batch must still refuse.
    const check = vi.spyOn(ScopedRepository.prototype, 'cycleHasRows').mockResolvedValue(false);
    try {
      expect((await setRoster(['m1'])).status).toBe(409);
    } finally {
      check.mockRestore();
    }
    expect(await outAt()).toEqual({ m1: null, m2: null, m3: null });
    expect(await confirmedAt()).toBeNull();
  });

  it('refuses changes while the cycle has an Approved expense', async () => {
    await repo().insertTransaction(tx('t1') as never);
    const res = await setRoster(['m1']);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Who is in is locked while this cycle has expenses/);
    expect(await outAt()).toEqual({ m1: null, m2: null, m3: null });
  });

  it('allows changes again after the cycle closes', async () => {
    await repo().insertTransaction(tx('t1') as never);
    expect((await setRoster(['m1'])).status).toBe(409);
    await repo().closeCycle('c1', ['t1'], { t1: 1 });
    expect((await setRoster(['m1'])).status).toBe(200);
    expect(await outAt()).toEqual({ m1: null, m2: expect.any(Number), m3: expect.any(Number) });
  });

  it('lets only the owner change who is in', async () => {
    const member = await signInAs('u2', 'hugo@example.com');
    expect((await setRoster(['m1'], member)).status).toBe(403);
    expect(await confirmedAt()).toBeNull();
  });

  it('a member added while the cycle has rows starts sitting out', async () => {
    await queued();
    const res = await send('/members', 'POST', { id: 'm4', displayName: 'Lee' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'm4', sittingOutAt: expect.any(Number) });
  });

  it('a member added to an empty cycle is in', async () => {
    const res = await send('/members', 'POST', { id: 'm4', displayName: 'Lee' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'm4', sittingOutAt: null });
  });

  it('refuses to remove a member while the cycle has rows', async () => {
    await queued();
    const res = await send('/members/m3', 'DELETE');
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Close the cycle before removing a member/);
    expect((await repo().members()).every((m) => m.archivedAt === null)).toBe(true);
  });
});
