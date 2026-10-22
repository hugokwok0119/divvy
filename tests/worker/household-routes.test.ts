import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, cycles, transactions, expenseHistory } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { closedCycleCard } from '../../src/lib/money';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

/** Mirrors tests/worker/scope.test.ts's signInAs: a real session via Better Auth's own adapter. */
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

beforeEach(async () => {
  for (const t of ['expense_history', 'transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
});

describe('archiveMember', () => {
  it('archives rather than deletes', async () => {
    await repo().archiveMember('m1');
    expect((await repo().members()).map((m) => m.id)).toContain('m1');
    expect(await repo().roster()).toEqual(['m2']);
  });

  it('refuses while the member has unresolved queue items', async () => {
    await repo().insertQueueItem({
      id: 'q1', date: null, store: 'Uber', amountCents: null, category: null,
      payerId: 'm1', cardId: null, splitType: null, source: 'manual',
    });
    await expect(repo().archiveMember('m1')).rejects.toThrow(/queued/i);
  });
});

describe('DELETE /api/members/:id', () => {
  it('archives a member added from Settings who never signed in, with their cards, keeping history', async () => {
    await db().update(householdMembers).set({ role: 'owner', userId: 'u1' }).where(eq(householdMembers.id, 'm1'));
    const cookie = await signInAs('u1', 'owner@example.com');
    const owner = new ScopedRepository(db(), 'h1', { memberId: 'm1', displayName: 'Sam' });
    await owner.upsertMember({ id: 'm3', displayName: 'New Member', sortOrder: 2 });
    await owner.upsertCard({ id: 'c3', memberId: 'm3', name: 'Visa' });
    await owner.insertTransaction({
      id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 300, category: 'Transport',
      payerId: 'm3', cardId: 'c3', splitType: 'equal', splitRule: null,
    });

    const res = await workerApp.request('http://localhost/api/members/m3', { method: 'DELETE', headers: { Cookie: cookie } }, testEnv);

    expect(res.status).toBe(204);
    expect((await repo().members()).find((m) => m.id === 'm3')?.archivedAt).toBeTypeOf('number');
    expect((await repo().cards()).find((c) => c.id === 'c3')?.archived).toBe(1);
    expect((await repo().activeTransactions()).map((t) => [t.payerId, t.cardNameSnapshot])).toEqual([['m3', 'Visa']]);
  });

  it('refuses to archive the owner', async () => {
    await db().update(householdMembers).set({ role: 'owner' }).where(eq(householdMembers.id, 'm1'));
    await expect(repo().archiveMember('m1')).rejects.toMatchObject({ status: 409 });
    expect((await repo().roster())).toEqual(['m1', 'm2']);
  });
});

describe('archiveCard', () => {
  it('keeps the card row so history stays readable', async () => {
    await repo().upsertCard({ id: 'c1', memberId: 'm1', name: 'Amex' });
    await repo().insertTransaction({
      id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 100, category: 'Transport',
      payerId: 'm1', cardId: 'c1', splitType: 'equal', splitRule: null,
    });
    await repo().upsertCard({ id: 'c1', memberId: 'm1', name: 'Renamed' });
    await repo().archiveCard('c1');
    const tx = (await repo().activeTransactions())[0];
    expect(tx.cardNameSnapshot).toBe('Amex');
  });
});

describe('exportAll', () => {
  it('excludes the allowlist and user ids', async () => {
    const dump = await repo().exportAll();
    expect(dump.household.allowedEmailsJson).toBeUndefined();
    expect(dump.members.every((m) => !Object.prototype.hasOwnProperty.call(m, 'userId'))).toBe(true);
  });
});

describe('cross-household upsert', () => {
  it('refuses to upsertMember an id owned by another household', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values(
      { id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0 },
    );
    await expect(
      repo().upsertMember({ id: 'x1', displayName: 'Hijacked' }),
    ).rejects.toThrow(/another household/i);
    const stillTheirs = await new ScopedRepository(db(), 'h2').members();
    expect(stillTheirs[0].displayName).toBe('Stranger');
  });

  it('refuses to upsertCard an id owned by another household', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values(
      { id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0 },
    );
    await new ScopedRepository(db(), 'h2').upsertCard({ id: 'xc1', memberId: 'x1', name: 'Visa' });
    await expect(
      repo().upsertCard({ id: 'xc1', memberId: 'm1', name: 'Hijacked' }),
    ).rejects.toThrow(/another household/i);
    const stillTheirs = await new ScopedRepository(db(), 'h2').cards();
    expect(stillTheirs[0].name).toBe('Visa');
  });
});

describe('GET /api/members', () => {
  it('never exposes userId, even for a member linked to an account', async () => {
    await db().update(householdMembers).set({ userId: 'u1' }).where(eq(householdMembers.id, 'm1'));
    const cookie = await signInAs('u1', 'owner@example.com');

    const res = await workerApp.request(
      'http://localhost/api/members', { headers: { Cookie: cookie } }, testEnv,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThan(0);
    for (const m of body) {
      expect(Object.prototype.hasOwnProperty.call(m, 'userId')).toBe(false);
    }
  });
});

describe('card statement days and retrospective labels', () => {
  const owner = () => new ScopedRepository(db(), 'h1', { memberId: 'm1', displayName: 'Sam' });
  const send = (path: string, cookie: string, body: unknown) => workerApp.request(`http://localhost/api/cards${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  }, testEnv);
  const card = async () => (await repo().cards()).find((c) => c.id === 'c1')!;
  const financial = async () => ({
    transactions: await db().select().from(transactions),
    cycles: await db().select().from(cycles),
    history: await db().select().from(expenseHistory),
  });
  let cookie = '';

  beforeEach(async () => {
    await db().update(householdMembers).set({ role: 'owner', userId: 'u1' }).where(eq(householdMembers.id, 'm1'));
    cookie = await signInAs('u1', 'owner@example.com');
    await owner().upsertCard({ id: 'c1', memberId: 'm1', name: 'Amex' });
    for (const id of ['t1', 't2']) {
      await owner().insertTransaction({
        id, date: '2024-06-09', store: 'Uber', amountCents: 100, category: 'Transport',
        payerId: 'm1', cardId: 'c1', splitType: 'equal', splitRule: null,
      });
    }
    await owner().closeCycle('cy1', ['t1', 't2'], { t1: 1, t2: 1 });
    await owner().insertTransaction({
      id: 't3', date: '2024-07-09', store: 'Uber', amountCents: 100, category: 'Transport',
      payerId: 'm1', cardId: 'c1', splitType: 'equal', splitRule: null,
    });
  });

  it('saves an optional statement day and leaves it unset by default', async () => {
    expect((await card()).statementDay).toBeNull();
    expect((await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Amex', statementDay: 31 })).status).toBe(201);
    expect((await card()).statementDay).toBe(31);
    expect((await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Amex', statementDay: null })).status).toBe(201);
    expect((await card()).statementDay).toBeNull();
  });

  it.each([0, 32, 1.5, '15', true])('rejects statement day %s and writes nothing', async (statementDay) => {
    const res = await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Renamed', statementDay });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields.statementDay).toBeTruthy();
    expect((await card()).name).toBe('Amex');
  });

  it('rejects a non-boolean history choice', async () => {
    expect((await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Renamed', applyToHistory: 'yes' })).status).toBe(400);
    expect((await card()).name).toBe('Amex');
  });

  it('previews the closed-cycle scope without writing', async () => {
    const before = await financial();
    const res = await send('?preview=1', cookie, { id: 'c1', memberId: 'm1', name: 'Visa', statementDay: 15 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cycles: 1, expenses: 2 });
    expect(await card()).toMatchObject({ name: 'Amex', statementDay: null, historyName: null });
    expect(await financial()).toEqual(before);
    const unchanged = await send('?preview=1', cookie, { id: 'c1', memberId: 'm1', name: 'Amex', statementDay: null });
    expect(await unchanged.json()).toEqual({ cycles: 0, expenses: 0 });
  });

  it('future-only save keeps historical labels and metadata', async () => {
    const before = await financial();
    expect((await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Visa', statementDay: 15, applyToHistory: false })).status).toBe(201);
    expect(await card()).toMatchObject({ name: 'Visa', statementDay: 15, historyName: null, historyStatementDay: null });
    expect(await financial()).toEqual(before);
  });

  it('retrospective save changes only history label and metadata, never financial data or snapshots', async () => {
    const before = await financial();
    expect((await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Visa', statementDay: 15, applyToHistory: true })).status).toBe(201);
    expect(await card()).toMatchObject({ name: 'Visa', statementDay: 15, historyName: 'Visa', historyStatementDay: 15 });
    expect(await financial()).toEqual(before);
    expect(before.transactions.every((tx) => tx.cardNameSnapshot === 'Amex')).toBe(true);
    // A later future-only rename leaves the chosen history label in place.
    await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Gold', statementDay: 15, applyToHistory: false });
    expect(await card()).toMatchObject({ name: 'Gold', historyName: 'Visa', historyStatementDay: 15 });
  });

  it('retrospective rename without a day keeps the stored day as history metadata', async () => {
    await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Amex', statementDay: 10 });
    expect((await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Visa', applyToHistory: true })).status).toBe(201);
    expect(await card()).toMatchObject({ name: 'Visa', statementDay: 10, historyName: 'Visa', historyStatementDay: 10 });
  });

  it('preview treats an omitted day as the stored day', async () => {
    await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Amex', statementDay: 10, applyToHistory: false });
    expect(await (await send('?preview=1', cookie, { id: 'c1', memberId: 'm1', name: 'Amex' })).json()).toEqual({ cycles: 1, expenses: 2 });
  });

  it('retrospective labels apply only to cycles closed by the time they were saved', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Visa', statementDay: 15, applyToHistory: true });
    const applied = await card();
    expect(applied.historyAppliedAt).toBeGreaterThanOrEqual((await owner().cycles())[0].closedAt);
    expect(await (await send('?preview=1', cookie, { id: 'c1', memberId: 'm1', name: 'Visa', statementDay: 15 })).json()).toEqual({ cycles: 0, expenses: 0 });
    await tick();
    await send('', cookie, { id: 'c1', memberId: 'm1', name: 'Gold', statementDay: 15, applyToHistory: false });
    expect(await card()).toMatchObject({ historyName: 'Visa', historyAppliedAt: applied.historyAppliedAt });
    await tick();
    await owner().closeCycle('cy2', ['t3'], { t3: 1 });
    const closed = Object.fromEntries((await owner().cycles()).map((cy) => [cy.id, cy.closedAt]));
    const current = await card();
    expect(closedCycleCard(current, closed.cy1, 'Amex')).toEqual({ name: 'Visa', statementDay: 15 });
    expect(closedCycleCard(current, closed.cy2, 'Amex')).toEqual({ name: 'Amex', statementDay: null });
    expect(await (await send('?preview=1', cookie, { id: 'c1', memberId: 'm1', name: 'Gold', statementDay: 15 })).json()).toEqual({ cycles: 2, expenses: 3 });
  });

  it('denies another household\'s card, including its preview', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values({ id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0 });
    await new ScopedRepository(db(), 'h2').upsertCard({ id: 'xc1', memberId: 'x1', name: 'Theirs' });
    expect((await send('', cookie, { id: 'xc1', memberId: 'm1', name: 'Hijack', applyToHistory: true })).status).toBe(403);
    expect((await send('?preview=1', cookie, { id: 'xc1', memberId: 'm1', name: 'Hijack' })).status).toBe(404);
    expect((await new ScopedRepository(db(), 'h2').cards())[0]).toMatchObject({ name: 'Theirs', historyName: null });
  });

  it('denies a member without card permission', async () => {
    await db().update(households).set({ allowedEmailsJson: JSON.stringify([{ email: 'hugo@example.com', memberId: 'm2' }]) });
    await db().update(householdMembers).set({ userId: 'u2' }).where(eq(householdMembers.id, 'm2'));
    const memberCookie = await signInAs('u2', 'hugo@example.com');
    expect((await send('', memberCookie, { id: 'c1', memberId: 'm1', name: 'Visa', statementDay: 15, applyToHistory: true })).status).toBe(403);
    expect((await send('?preview=1', memberCookie, { id: 'c1', memberId: 'm1', name: 'Visa' })).status).toBe(403);
    expect(await card()).toMatchObject({ name: 'Amex', statementDay: null, historyName: null });
  });
});

describe('PATCH /api/household custom categories', () => {
  it('adds a new custom category that bootstrap returns', async () => {
    await db().update(householdMembers).set({ role: 'owner', userId: 'u1' }).where(eq(householdMembers.id, 'm1'));
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await workerApp.request('http://localhost/api/household', {
      method: 'PATCH', headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ customCategories: ['Pets'] }),
    }, testEnv);
    expect(res.status).toBe(200);
    const boot = await workerApp.request('http://localhost/api/bootstrap', { headers: { Cookie: cookie } }, testEnv);
    expect(((await boot.json()) as { household: { customCategories: string[] } }).household.customCategories).toContain('Pets');
  });
});

describe('PATCH /api/household rent reminder', () => {
  const patch = async (body: unknown) => {
    await db().update(householdMembers).set({ role: 'owner', userId: 'u1' }).where(eq(householdMembers.id, 'm1'));
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await workerApp.request('http://localhost/api/household', {
      method: 'PATCH', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    }, testEnv);
    return { res, cookie };
  };

  it('saves the rent reminder setting', async () => {
    const { res, cookie } = await patch({ rentReminder: false });
    expect(res.status).toBe(200);
    const boot = await workerApp.request('http://localhost/api/bootstrap', { headers: { Cookie: cookie } }, testEnv);
    expect(((await boot.json()) as { household: { rentReminder: boolean } }).household.rentReminder).toBe(false);
  });

  it('rejects a non-boolean rent reminder', async () => {
    const { res } = await patch({ rentReminder: 0 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields.rentReminder).toBeTruthy();
  });
});

describe('settings order and card delete', () => {
  const call = (path: string, cookie: string, method: string, body?: unknown) => workerApp.request(`http://localhost/api${path}`, {
    method, headers: { 'content-type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
  let cookie = '';

  beforeEach(async () => {
    await db().update(householdMembers).set({ role: 'owner', userId: 'u1' }).where(eq(householdMembers.id, 'm1'));
    cookie = await signInAs('u1', 'owner@example.com');
    await repo().upsertCard({ id: 'c1', memberId: 'm1', name: 'Amex', sortOrder: 0 });
    await repo().upsertCard({ id: 'c2', memberId: 'm1', name: 'Visa', sortOrder: 1 });
    await repo().upsertCard({ id: 'c3', memberId: 'm1', name: 'Debit', sortOrder: 2 });
  });

  it('reorders cards in the given order', async () => {
    expect((await call('/cards/order', cookie, 'PUT', { ids: ['c3', 'c1', 'c2'] })).status).toBe(200);
    expect((await repo().cards()).map((c) => c.id)).toEqual(['c3', 'c1', 'c2']);
  });

  it('reorders members in the given order', async () => {
    expect((await call('/members/order', cookie, 'PUT', { ids: ['m2', 'm1'] })).status).toBe(200);
    expect((await repo().members()).map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it.each([{}, { ids: [] }, { ids: ['c1', 'c1'] }, { ids: [1] }, { ids: 'c1' }])('rejects order body %j and writes nothing', async (body) => {
    expect((await call('/cards/order', cookie, 'PUT', body)).status).toBe(400);
    expect((await repo().cards()).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('refuses to reorder another household\'s card and writes nothing', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values({ id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0 });
    await new ScopedRepository(db(), 'h2').upsertCard({ id: 'xc1', memberId: 'x1', name: 'Theirs', sortOrder: 5 });
    expect((await call('/cards/order', cookie, 'PUT', { ids: ['c3', 'xc1'] })).status).toBe(403);
    expect((await repo().cards()).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect((await new ScopedRepository(db(), 'h2').cards())[0].sortOrder).toBe(5);
  });

  it('denies reorder and delete to a member without card permission', async () => {
    await db().update(households).set({ allowedEmailsJson: JSON.stringify([{ email: 'hugo@example.com', memberId: 'm2' }]) });
    await db().update(householdMembers).set({ userId: 'u2' }).where(eq(householdMembers.id, 'm2'));
    const memberCookie = await signInAs('u2', 'hugo@example.com');
    expect((await call('/cards/order', memberCookie, 'PUT', { ids: ['c3', 'c1', 'c2'] })).status).toBe(403);
    expect((await call('/members/order', memberCookie, 'PUT', { ids: ['m2', 'm1'] })).status).toBe(403);
    expect((await call('/cards/c1', memberCookie, 'DELETE')).status).toBe(403);
    expect((await repo().cards()).map((c) => [c.id, c.archived])).toEqual([['c1', 0], ['c2', 0], ['c3', 0]]);
  });

  it('keeps a card\'s order when it is saved without one', async () => {
    await repo().upsertCard({ id: 'c3', memberId: 'm1', name: 'Debit renamed' });
    expect((await repo().cards()).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps a member\'s order when it is renamed without one', async () => {
    await db().update(householdMembers).set({ sortOrder: 2 }).where(eq(householdMembers.id, 'm1'));
    await repo().upsertMember({ id: 'm1', displayName: 'Sam renamed' });
    expect((await repo().members()).map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('deleting a card archives it and leaves ledger rows untouched', async () => {
    await repo().insertTransaction({
      id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 100, category: 'Transport',
      payerId: 'm1', cardId: 'c1', splitType: 'equal', splitRule: null,
    });
    const before = await db().select().from(transactions);
    expect((await call('/cards/c1', cookie, 'DELETE')).status).toBe(204);
    expect((await repo().cards()).find((c) => c.id === 'c1')?.archived).toBe(1);
    expect(await db().select().from(transactions)).toEqual(before);
  });
});
