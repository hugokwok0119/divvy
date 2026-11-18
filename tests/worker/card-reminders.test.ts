import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, cards } from '../../worker/db/schema';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/** Mirrors tests/worker/sitting-out.test.ts's signInAs. */
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
const setReminder = (id: string, reminder: unknown, as = cookie) => send(`/cards/${id}/reminder`, 'PUT', { reminder }, as);
const bootReminders = async () => {
  const boot = await (await send('/bootstrap', 'GET')).json() as { cards: Array<{ id: string; reminder: number }> };
  return boot.cards.map((c) => [c.id, c.reminder]);
};

beforeEach(async () => {
  for (const t of ['expense_history', 'transactions', 'queue_items', 'cycles', 'cards', 'member_accounts', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values([
    { id: 'h1', name: 'Ours', createdAt: 0, allowedEmailsJson: JSON.stringify([{ email: 'hugo@example.com', memberId: 'm2' }]) },
    { id: 'h2', name: 'Theirs', createdAt: 0 },
  ]);
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0, role: 'owner', userId: 'u1' },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1, userId: 'u2' },
    { id: 'x1', householdId: 'h2', displayName: 'Other', createdAt: 0, sortOrder: 0 },
  ]);
  await db().insert(cards).values([
    { id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Amex', sortOrder: 0, statementDay: 15 },
    { id: 'c2', householdId: 'h1', memberId: 'm2', name: 'Visa', sortOrder: 1, statementDay: 3 },
    { id: 'c9', householdId: 'h2', memberId: 'x1', name: 'Theirs', sortOrder: 0, statementDay: 5 },
  ]);
  cookie = await signInAs('u1', 'owner@example.com');
});

describe('card reminders', () => {
  it('turns one card\'s reminder off and on', async () => {
    const off = await setReminder('c1', false);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ id: 'c1', reminder: 0 });
    expect(await bootReminders()).toEqual([['c1', 0], ['c2', 1]]);
    expect(await (await setReminder('c1', true)).json()).toMatchObject({ id: 'c1', reminder: 1 });
    expect(await bootReminders()).toEqual([['c1', 1], ['c2', 1]]);
  });

  it('rejects a non-boolean reminder', async () => {
    for (const reminder of ['yes', 0, null]) {
      const res = await setReminder('c1', reminder);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid reminder', fields: { reminder: 'Expected true or false' } });
    }
    expect(await bootReminders()).toEqual([['c1', 1], ['c2', 1]]);
  });

  it('lets only the owner change a reminder', async () => {
    const member = await signInAs('u2', 'hugo@example.com');
    expect((await setReminder('c2', false, member)).status).toBe(403);
    expect(await bootReminders()).toEqual([['c1', 1], ['c2', 1]]);
  });

  it('returns 404 for another group\'s card', async () => {
    const res = await setReminder('c9', false);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/Card not found/);
    expect((await setReminder('nope', false)).status).toBe(404);
    const [row] = await env.DB.prepare('select reminder from cards where id = ?').bind('c9').all<{ reminder: number }>().then((r) => r.results);
    expect(row.reminder).toBe(1);
  });

  it('defaults a new card\'s reminder to on', async () => {
    const res = await send('/cards', 'POST', { id: 'c3', memberId: 'm1', name: 'Chase', statementDay: 20 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'c3', reminder: 1 });
  });
});
