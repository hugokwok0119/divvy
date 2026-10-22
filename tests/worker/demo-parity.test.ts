// Drift guard for the demo's hand-mirrored queue rules (spec 7.4): one request script runs against the
// real routes on local miniflare D1 and against the in-memory demo server, and the responses must match.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, cards, transactions } from '../../worker/db/schema';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';
import { createDemoServer } from '../../src/demo/server';
import { computeShares } from '../../src/lib/settlement';
import type { Bootstrap, Card, Member, Transaction } from '../../src/types';

const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;
const db = () => drizzle(env.DB);

// One fixture literal feeds both D1 and the demo store; rows carry every column the server's select() returns.
const fixture = {
  household: { id: 'h1', name: 'Ours', currencyCode: 'CAD', timezone: 'America/Vancouver',
    customCategoriesJson: '[]', allowedEmailsJson: '[]', createdAt: 0 },
  members: [
    { id: 'm1', householdId: 'h1', userId: 'u1', displayName: 'Hugo', role: 'owner', sortOrder: 0, archivedAt: null, createdAt: 0 },
    { id: 'm2', householdId: 'h1', userId: null, displayName: 'Sam', role: 'member', sortOrder: 1, archivedAt: null, createdAt: 0 },
  ],
  cards: [
    { id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Card One', archived: 0, sortOrder: 0, statementDay: null,
      historyName: null, historyStatementDay: null, historyAppliedAt: null },
    { id: 'c2', householdId: 'h1', memberId: 'm2', name: 'Card Two', archived: 0, sortOrder: 1, statementDay: null,
      historyName: null, historyStatementDay: null, historyAppliedAt: null },
  ],
  transactions: [
    { id: 't1', expenseId: 'e-t1', date: '2026-10-01', store: 'Quillfern Market', amountCents: 2565, category: 'Groceries',
      payerId: 'm1', cardId: 'c1', cardNameSnapshot: 'Card One', splitType: 'equal' as const, splitRuleJson: null,
      splitSharesJson: JSON.stringify(computeShares(2565, 'equal', null, ['m1', 'm2'])) },
    { id: 't2', expenseId: 'e-t2', date: '2026-10-03', store: 'Uber', amountCents: 1200, category: 'Transport',
      payerId: 'm2', cardId: 'c2', cardNameSnapshot: 'Card Two', splitType: 'single' as const, splitRuleJson: '{"memberId":"m2"}',
      splitSharesJson: JSON.stringify(computeShares(1200, 'single', { memberId: 'm2' }, ['m1', 'm2'])) },
  ].map((tx) => ({ ...tx, householdId: 'h1', cycleId: null, hasBeenApproved: true, lastEditedAt: null, parentExpenseId: null,
    revision: 1, editedByMemberId: 'm1', editedByName: 'Hugo', reviewNote: null, source: 'manual' as const,
    sourceFileId: null, sourceFileName: null, isStarred: 0, favoriteName: null, createdAt: 1000, updatedAt: 1000, deletedAt: null })),
};

function demoServer() {
  const h = fixture.household;
  const bootstrap: Bootstrap = {
    me: { memberId: 'm1', role: 'owner' },
    household: { id: h.id, name: h.name, currencyCode: h.currencyCode, timezone: h.timezone, customCategories: [], currentCycleName: null },
    members: fixture.members.map(({ id, displayName, role, sortOrder, archivedAt }) =>
      ({ id, displayName, role, sortOrder, archivedAt }) as Member),
    cards: fixture.cards.map((card) => ({ ...card }) as Card),
    transactions: fixture.transactions.map((tx) => ({ ...tx }) as Transaction),
    queue: [], cycles: [], categoryPreferences: {},
  };
  return createDemoServer({ bootstrap, archived: [], history: [] }, [], { parseDelayMs: 0 });
}

type Send = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
const read = async (res: Response) => {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const init = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method, headers: { ...headers, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME_KEYS = new Set(['updatedAt', 'lastEditedAt', 'timestamp', 'createdAt']);
const SET_KEYS = new Set(['created', 'queue', 'transactions']);

/** Replaces generated ids (by first appearance) and timestamps with placeholders; drops nothing. */
function normalizer() {
  const ids = new Map<string, string>();
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string' && UUID.test(value)) {
      if (!ids.has(value)) ids.set(value, `<id-${ids.size + 1}>`);
      return ids.get(value);
    }
    if (typeof value === 'number' && key && TIME_KEYS.has(key)) return '<time>';
    if (Array.isArray(value)) {
      // Bulk `created`, bootstrap `queue` and `transactions` are sets: order rows by their client id first.
      const rows = key && SET_KEYS.has(key)
        ? [...value].sort((a, b) => String(a.id).localeCompare(String(b.id))) : value;
      return rows.map((item) => walk(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, walk((value as Record<string, unknown>)[k], k)]));
    }
    return value;
  };
  return walk;
}

/** The scripted sequence; returns each step's normalized { status, body } in order. */
async function runScript(send: Send) {
  const normalize = normalizer();
  const steps: Array<[string, { status: number; body: unknown }]> = [];
  const step = async (label: string, method: string, path: string, body?: unknown) => {
    const res = await send(method, path, body);
    steps.push([label, { status: res.status, body: normalize(res.body) }]);
    return res;
  };
  const item = (id: string, over: Record<string, unknown> = {}) => ({
    id, date: '2026-10-05', store: 'Moss Bakery', amountCents: 850, category: 'Dining', payerId: 'm1',
    cardId: null, splitType: null, splitRule: null, source: 'manual', ...over,
  });

  await step('bulk import', 'POST', '/api/queue/bulk', { items: [
    item('q1'),
    item('q2'), // same-batch duplicate of q1
    item('q3', { date: '2026-10-02', store: 'QUILLFERN MARKET', amountCents: 2565, category: 'Groceries' }), // matches t1
    item('q4', { date: '2026-10-06', store: 'Cedar Hardware', amountCents: 4200, category: 'Shopping', payerId: 'm2' }),
    item('q5', { date: '2026-10-07', store: 'Lantern Cinema', amountCents: 3000, category: 'Entertainment', source: 'image' }),
  ] });
  await step('bulk import with a reused id', 'POST', '/api/queue/bulk', { items: [item('q1'), item('q6')] });
  await step('PATCH no-op', 'PATCH', '/api/queue/q4', { revision: 1, store: 'Cedar Hardware' });
  await step('PATCH card not owned by payer', 'PATCH', '/api/queue/q4', { revision: 1, cardId: 'c1', payerId: 'm2' });
  await step('PATCH stale revision', 'PATCH', '/api/queue/q4', { revision: 7, store: 'Other Store' });
  await step('PATCH category', 'PATCH', '/api/queue/q4', { revision: 1, category: 'Groceries' });
  await step('bootstrap after category change', 'GET', '/api/bootstrap');
  const confirm = (id: string, revision: number, tx: Record<string, unknown>) =>
    step(`confirm ${id}`, 'POST', `/api/queue/${id}/confirm`, { revision, transactionId: `tx-${id}`,
      transaction: { id: `tx-${id}`, date: '2026-10-05', store: 'Moss Bakery', amountCents: 850, category: 'Dining',
        payerId: 'm1', cardId: 'c1', splitType: 'equal', splitRule: null, ...tx } });
  await confirm('q1', 1, {});
  await confirm('q3', 1, { date: '2026-10-02', store: 'Quillfern Market', amountCents: 2565, category: 'Groceries',
    payerId: 'm2', cardId: 'c2', splitType: 'single', splitRule: { memberId: 'm2' } });
  const confirmed = await confirm('q4', 2, { date: '2026-10-06', store: 'Cedar Hardware', amountCents: 4200,
    category: 'Groceries', payerId: 'm2', cardId: null, splitType: 'custom', splitRule: { percentages: { m1: 60, m2: 40 } } });
  await step('delete', 'DELETE', '/api/queue/q2', { revision: 1 });
  await step('delete-bulk', 'POST', '/api/queue/delete-bulk', { ids: ['q5', 'q6'], revisions: { q5: 1, q6: 1 } });
  await step('re-import a deleted id', 'POST', '/api/queue/bulk', { items: [item('q2')] });
  await step('history of a confirmed row', 'GET',
    `/api/transactions/history/${(confirmed.body as { expenseId: string }).expenseId}`);
  await step('final bootstrap', 'GET', '/api/bootstrap');
  return steps;
}

describe('demo queue parity with the real routes', () => {
  let cookie: string;

  beforeEach(async () => {
    for (const table of ['expense_history', 'category_preferences', 'transactions', 'queue_items', 'cycles', 'cards',
      'household_members', 'households', 'session', 'user']) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    await db().insert(households).values(fixture.household);
    await db().insert(householdMembers).values(fixture.members);
    await db().insert(cards).values(fixture.cards);
    await db().insert(transactions).values(fixture.transactions);
    const now = Date.now();
    await env.DB.prepare(
      'insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)',
    ).bind('u1', 'Hugo', 'owner@example.com', now, now).run();
    const ctx = await createAuth(testEnv).$context;
    const session = await ctx.internalAdapter.createSession('u1');
    cookie = (await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret)).split(';')[0];
  });

  it('answers the scripted Pending sequence exactly as the server does', async () => {
    const real = await runScript(async (method, path, body) =>
      read(await workerApp.request(`http://localhost${path}`, init(method, body, { Cookie: cookie }), testEnv)));
    const server = demoServer();
    const demo = await runScript(async (method, path, body) =>
      read(await server.handle(new Request(`https://demo.test${path}`, init(method, body)))));

    // Pin the server's own outcomes so a script that stopped exercising a branch cannot pass vacuously.
    expect(real.map(([, res]) => res.status)).toEqual([201, 201, 200, 403, 409, 200, 200, 201, 201, 201, 204, 200, 201, 200, 200]);
    const summary = (i: number) => (real[i][1].body as { summary: unknown }).summary;
    expect(summary(0)).toEqual({ inserted: 5, duplicate: 2, rejected: 0 }); // q2 same-batch, q3 cross-ledger
    expect(summary(1)).toEqual({ inserted: 1, duplicate: 1, rejected: 1 }); // q1 reused
    expect(demo.map(([label]) => label)).toEqual(real.map(([label]) => label));
    for (let i = 0; i < real.length; i++) expect(demo[i][1], real[i][0]).toEqual(real[i][1]);
  });
});
