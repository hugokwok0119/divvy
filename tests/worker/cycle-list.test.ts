import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';
import type { CycleGroup } from '../../src/types';

const db = () => drizzle(env.DB);
const actor = { memberId: 'm1', displayName: 'Sam' };
const repo = () => new ScopedRepository(db(), 'h1', actor);
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/** Mirrors tests/worker/reminder-routes.test.ts's signInAs. */
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

const tx = (id: string, date: string, payerId: string, cardId: string | null) => ({
  id, date, store: 'Shop', amountCents: 1000, category: 'Other', payerId, cardId, splitType: 'equal' as const, splitRule: null,
});

let owner = '';

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
  await repo().upsertCard({ id: 'c1', memberId: 'm1', name: 'Amex' });
  await repo().upsertCard({ id: 'c2', memberId: 'm2', name: 'Visa' });
  for (const t of [
    tx('t1', '2025-12-20', 'm2', 'c2'), tx('t2', '2026-01-15', 'm2', 'c2'), tx('t3', '2025-12-16', 'm2', 'c2'),
    tx('t4', '2026-01-02', 'm1', 'c1'), tx('t5', '2026-01-05', 'm1', null), tx('t6', '2026-01-30', 'm1', 'c1'),
    tx('t7', '2026-02-01', 'm2', 'c2'),
  ]) await repo().insertTransaction(t);
  await repo().softDeleteTransaction('t6');
  await repo().closeCycle('cy1', ['t1', 't2', 't3', 't4', 't5'], { t1: 1, t2: 1, t3: 1, t4: 1, t5: 1 });
  await repo().closeCycle('cy2', ['t7'], { t7: 1 });
  const other = new ScopedRepository(db(), 'h2', { memberId: 'm9', displayName: 'Other' });
  await other.insertTransaction(tx('t9', '2026-01-01', 'm9', null));
  await other.closeCycle('cy9', ['t9'], { t9: 1 });
  owner = await signInAs('u1', 'owner@example.com');
});

describe('GET /api/cycles', () => {
  it('summarizes each cycle by payer and card group without loading cycle detail', async () => {
    const res = await workerApp.request('http://localhost/api/cycles', { headers: { Cookie: owner } }, testEnv);
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ id: string; settlement: unknown; groups: CycleGroup[] }>;
    expect(list.map((cy) => cy.id).sort()).toEqual(['cy1', 'cy2']);
    const cy1 = list.find((cy) => cy.id === 'cy1')!;
    expect(cy1.settlement).toBeDefined();
    expect(cy1.groups).toEqual([
      { payerId: 'm2', cardId: 'c2', cardNameSnapshot: 'Visa', dateStart: '2025-12-16', dateEnd: '2026-01-15', count: 3 },
      { payerId: 'm1', cardId: 'c1', cardNameSnapshot: 'Amex', dateStart: '2026-01-02', dateEnd: '2026-01-02', count: 1 },
      { payerId: 'm1', cardId: null, cardNameSnapshot: null, dateStart: '2026-01-05', dateEnd: '2026-01-05', count: 1 },
    ]);
    expect(list.find((cy) => cy.id === 'cy2')!.groups).toEqual([
      { payerId: 'm2', cardId: 'c2', cardNameSnapshot: 'Visa', dateStart: '2026-02-01', dateEnd: '2026-02-01', count: 1 },
    ]);
  });
});
