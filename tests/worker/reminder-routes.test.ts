import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, reminderCompletions, transactions, cycles, queueItems } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/** Mirrors tests/worker/household-routes.test.ts's signInAs. */
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

const get = (cookie: string, month: string) =>
  workerApp.request(`http://localhost/api/reminders?month=${month}`, { headers: { Cookie: cookie } }, testEnv);
const put = (cookie: string, body: unknown) => workerApp.request('http://localhost/api/reminders', {
  method: 'PUT', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
}, testEnv);
const done = async (res: Response) => ((await res.json()) as Array<{ reminderId: string }>).map((r) => r.reminderId).sort();

let owner = '';
let member = '';

beforeEach(async () => {
  for (const t of ['reminder_completions', 'expense_history', 'transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({
    id: 'h1', name: 'Ours', createdAt: 0,
    allowedEmailsJson: JSON.stringify([{ email: 'hugo@example.com', memberId: 'm2' }]),
  });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0, role: 'owner', userId: 'u1' },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1, userId: 'u2' },
  ]);
  await repo().upsertCard({ id: 'c1', memberId: 'm1', name: 'Amex', statementDay: 15 });
  await repo().upsertCard({ id: 'c2', memberId: 'm2', name: 'Visa', statementDay: 15 });
  owner = await signInAs('u1', 'owner@example.com');
  member = await signInAs('u2', 'hugo@example.com');
});

describe('reminder completion', () => {
  it('lets any member tick a reminder that every member then sees, and untick it', async () => {
    const res = await put(member, { month: '2026-10', reminderId: 'card:c1', done: true });
    expect(res.status).toBe(200);
    const seen = await get(owner, '2026-10');
    expect(seen.status).toBe(200);
    expect(await seen.json()).toEqual([
      expect.objectContaining({ month: '2026-10', reminderId: 'card:c1', completedByMemberId: 'm2' }),
    ]);
    expect(await done(await put(owner, { month: '2026-10', reminderId: 'card:c1', done: false }))).toEqual([]);
    expect(await done(await get(member, '2026-10'))).toEqual([]);
  });

  it('keeps cards on the same day, rent and months independent; repeat ticks do not duplicate', async () => {
    await put(member, { month: '2026-10', reminderId: 'card:c1', done: true });
    await put(member, { month: '2026-10', reminderId: 'card:c1', done: true });
    await put(member, { month: '2026-10', reminderId: 'rent', done: true });
    await put(member, { month: '2026-11', reminderId: 'card:c2', done: true });
    expect(await done(await get(owner, '2026-10'))).toEqual(['card:c1', 'rent']);
    expect(await done(await get(owner, '2026-11'))).toEqual(['card:c2']);
  });

  it('returns and exports only the typed completion fields', async () => {
    const rows = await (await put(member, { month: '2026-10', reminderId: 'rent', done: true })).json() as Array<Record<string, unknown>>;
    expect(Object.keys(rows[0]).sort()).toEqual(['completedAt', 'completedByMemberId', 'month', 'reminderId']);
    expect((await repo().exportAll()).reminderCompletions).toEqual(rows);
  });

  it('survives a card rename and statement-day change without duplicating', async () => {
    await put(owner, { month: '2026-10', reminderId: 'card:c1', done: true });
    await repo().upsertCard({ id: 'c1', memberId: 'm1', name: 'Gold', statementDay: 3 });
    expect(await done(await get(owner, '2026-10'))).toEqual(['card:c1']);
  });

  it('never touches ledger, approval or payment data', async () => {
    const before = [await db().select().from(transactions), await db().select().from(queueItems), await db().select().from(cycles)];
    await put(owner, { month: '2026-10', reminderId: 'rent', done: true });
    expect([await db().select().from(transactions), await db().select().from(queueItems), await db().select().from(cycles)]).toEqual(before);
  });

  it.each([
    { month: '2026-13', reminderId: 'rent', done: true },
    { month: '2026-1', reminderId: 'rent', done: true },
    { month: '2026-10', reminderId: 'water', done: true },
    { month: '2026-10', reminderId: 'card:', done: true },
    { month: '2026-10', reminderId: 'rent', done: 'yes' },
  ])('rejects %o and writes nothing', async (body) => {
    expect((await put(owner, body)).status).toBe(400);
    expect(await db().select().from(reminderCompletions)).toEqual([]);
  });

  it('rejects a malformed month on read', async () => {
    expect((await get(owner, 'october')).status).toBe(400);
  });

  it('denies another household\'s card and hides its completions', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values({ id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0 });
    const theirs = new ScopedRepository(db(), 'h2', { memberId: 'x1', displayName: 'Stranger' });
    await theirs.upsertCard({ id: 'xc1', memberId: 'x1', name: 'Theirs' });
    await theirs.setReminderCompletion('2026-10', 'rent', true);

    expect((await put(member, { month: '2026-10', reminderId: 'card:xc1', done: true })).status).toBe(403);
    expect((await put(member, { month: '2026-10', reminderId: 'card:missing', done: true })).status).toBe(403);
    expect(await done(await get(owner, '2026-10'))).toEqual([]);
    expect(await db().select().from(reminderCompletions).where(eq(reminderCompletions.householdId, 'h1'))).toEqual([]);
    expect(await theirs.reminderCompletions('2026-10')).toHaveLength(1);
  });
});
