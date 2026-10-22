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

/** Mirrors tests/worker/cycle-list.test.ts's signInAs. */
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
const rename = (id: string, body: unknown) => workerApp.request(`http://localhost/api/cycles/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
}, testEnv);
const bootstrap = async () => (await (await workerApp.request('http://localhost/api/bootstrap', { headers: { Cookie: cookie } }, testEnv))
  .json()) as { household: { currentCycleName: string | null }; cycles: Array<{ id: string; name: string | null }> };
const tx = (id: string) => ({
  id, date: '2026-10-01', store: 'Shop', amountCents: 1000, category: 'Other', payerId: 'm1', cardId: null, splitType: 'equal' as const, splitRule: null,
});

beforeEach(async () => {
  for (const t of ['expense_history', 'transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values([{ id: 'h1', name: 'Ours', createdAt: 0 }, { id: 'h2', name: 'Theirs', createdAt: 0 }]);
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0, role: 'owner', userId: 'u1' },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
    { id: 'm9', householdId: 'h2', displayName: 'Other', createdAt: 0, sortOrder: 0 },
  ]);
  cookie = await signInAs('u1', 'owner@example.com');
  for (const id of ['t1', 't2']) await repo().insertTransaction(tx(id));
});

describe('cycle names', () => {
  it('stores no name until the user edits one', async () => {
    expect((await bootstrap()).household.currentCycleName).toBeNull();
    await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    expect((await bootstrap()).cycles[0].name).toBeNull();
  });

  it('renames the current cycle, and the name moves to the cycle when it closes', async () => {
    const res = await rename('current', { name: '  October  ' });
    expect(res.status).toBe(200);
    expect((await bootstrap()).household.currentCycleName).toBe('October');

    await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    const after = await bootstrap();
    expect(after.cycles.find((c) => c.id === 'cy1')?.name).toBe('October');
    expect(after.household.currentCycleName).toBeNull();
  });

  it('keeps the current name when a close fails', async () => {
    await rename('current', { name: 'October' });
    await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    await rename('current', { name: 'November' });
    await expect(repo().closeCycle('cy2', ['t1', 't2'], { t1: 2, t2: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await bootstrap()).household.currentCycleName).toBe('November');
  });

  it('renames a closed cycle and resets it to the default with null', async () => {
    await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    expect((await rename('cy1', { name: 'Japan trip' })).status).toBe(200);
    expect((await bootstrap()).cycles[0].name).toBe('Japan trip');
    expect((await rename('cy1', { name: null })).status).toBe(200);
    expect((await bootstrap()).cycles[0].name).toBeNull();
  });

  it.each([[{ name: '' }], [{ name: '   ' }], [{ name: 5 }], [{ name: 'x'.repeat(81) }], [{}], [null]])('rejects %j', async (body) => {
    await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    const res = await rename('cy1', body);
    expect(res.status).toBe(400);
    expect((await bootstrap()).cycles[0].name).toBeNull();
  });

  it("returns 404 for another household's cycle", async () => {
    await new ScopedRepository(db(), 'h2', { memberId: 'm9', displayName: 'Other' }).insertTransaction({ ...tx('x1'), payerId: 'm9' });
    await new ScopedRepository(db(), 'h2').closeCycle('cyx', ['x1'], { x1: 1 });
    expect((await rename('cyx', { name: 'Mine now' })).status).toBe(404);
    expect((await new ScopedRepository(db(), 'h2').requireCycle('cyx')).name).toBeNull();
  });
});
