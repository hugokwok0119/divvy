import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
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

async function call(path: string, cookie: string, method: string, body?: unknown) {
  return workerApp.request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
}

beforeEach(async () => {
  for (const t of ['transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0, role: 'owner', userId: 'u1' },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
});

describe('POST /api/queue/bulk validation', () => {
  it('returns 400, not 500, when items is missing', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/queue/bulk', cookie, 'POST', {});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; fields: Record<string, string> };
    expect(body.error).toBeTruthy();
    expect(body.fields.items).toBeTruthy();
    expect(await repo().queueItems()).toHaveLength(0);
  });

  it('returns 400 when items is not an array', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/queue/bulk', cookie, 'POST', { items: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(await repo().queueItems()).toHaveLength(0);
  });

  it('returns 400 for an empty items array', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/queue/bulk', cookie, 'POST', { items: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 with per-row field errors for a malformed row, and writes nothing', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/queue/bulk', cookie, 'POST', {
      items: [
        { id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 500, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
        { id: 'q2', date: 'not-a-date', store: 'Lyft', amountCents: 1.5, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; fields: Record<string, string> };
    expect(Object.keys(body.fields).some((k) => k.includes('date'))).toBe(true);
    expect(Object.keys(body.fields).some((k) => k.includes('amountCents'))).toBe(true);
    expect(await repo().queueItems()).toHaveLength(0);
  });

  it('accepts a well-formed batch and returns created rows plus a summary', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/queue/bulk', cookie, 'POST', {
      items: [
        { id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 500, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
        { id: 'q2', date: '2024-06-10', store: 'Lyft', amountCents: 700, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      created: unknown[];
      summary: { inserted: number; duplicate: number; rejected: number };
    };
    expect(body.created).toHaveLength(2);
    expect(body.summary).toEqual({ inserted: 2, duplicate: 0, rejected: 0 });
  });

  it('retrying the exact same upload creates zero extra rows', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const items = [
      { id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 500, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
    ];
    await call('/api/queue/bulk', cookie, 'POST', { items });
    const res = await call('/api/queue/bulk', cookie, 'POST', { items });
    expect(res.status).toBe(201);
    const body = await res.json() as { created: unknown[]; summary: { inserted: number; rejected: number } };
    expect(body.summary.inserted).toBe(0);
    expect(body.summary.rejected).toBe(1);
    expect(await repo().queueItems()).toHaveLength(1);
  });
});

describe('POST /api/queue/delete-bulk validation', () => {
  it('rejects missing, empty, duplicate, and blank ids', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    for (const body of [{}, { ids: [] }, { ids: ['q1', 'q1'] }, { ids: [''] }]) {
      const res = await call('/api/queue/delete-bulk', cookie, 'POST', body);
      expect(res.status).toBe(400);
    }
  });

  it('deletes selected queue rows', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    await repo().insertQueueItemsBulk([
      { id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 500, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
      { id: 'q2', date: '2024-06-10', store: 'Lyft', amountCents: 700, category: 'Transport', payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv' },
    ]);

    const res = await call('/api/queue/delete-bulk', cookie, 'POST', { ids: ['q2'], revisions: { q2: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletedIds: ['q2'] });
    expect((await repo().queueItems()).map((item) => item.id)).toEqual(['q1']);
  });
});

describe('POST /api/transactions validation', () => {
  it('rejects an invalid calendar date with 400, not 500', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/transactions', cookie, 'POST', {
      id: 't1', date: '2024-02-30', store: 'Uber', amountCents: 500, category: 'Transport',
      payerId: 'm1', cardId: null, splitType: 'equal', splitRule: null,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { fields: Record<string, string> };
    expect(body.fields.date).toBeTruthy();
    expect(await repo().activeTransactions()).toHaveLength(0);
  });

  it('rejects a non-integer amountCents with 400, not 500', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/transactions', cookie, 'POST', {
      id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 5.5, category: 'Transport',
      payerId: 'm1', cardId: null, splitType: 'equal', splitRule: null,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a single split naming an unknown member with 400, not 500', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/transactions', cookie, 'POST', {
      id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 500, category: 'Transport',
      payerId: 'm1', cardId: null, splitType: 'single', splitRule: { memberId: 'ghost' },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { fields: Record<string, string> };
    expect(body.fields.splitRule).toBeTruthy();
  });

  it('accepts a well-formed transaction', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/transactions', cookie, 'POST', {
      id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 500, category: 'Transport',
      payerId: 'm1', cardId: null, splitType: 'equal', splitRule: null,
    });
    expect(res.status).toBe(201);
  });

  it('leaves zero rows when ownership validation fails partway through a bulk import', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/transactions/bulk', cookie, 'POST', {
      transactions: [
        {
          id: 't1', date: '2024-06-09', store: 'Uber', amountCents: 500,
          category: 'Transport', payerId: 'm1', cardId: null,
          splitType: 'equal', splitRule: null,
        },
        {
          id: 't2', date: '2024-06-10', store: 'Lyft', amountCents: 700,
          category: 'Transport', payerId: 'not-a-member', cardId: null,
          splitType: 'equal', splitRule: null,
        },
      ],
    });

    expect(res.status).toBe(403);
    expect(await repo().activeTransactions()).toHaveLength(0);
  });
});

describe('POST /api/cycles/close validation', () => {
  it('rejects a non-array transactionIds with 400, not 500', async () => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/cycles/close', cookie, 'POST', { cycleId: 'cy1', transactionIds: 'nope' });
    expect(res.status).toBe(400);
  });
});


describe('queue file metadata validation', () => {
  const row = { id: 'q-file', date: null, store: null, amountCents: null, category: null,
    payerId: null, cardId: null, splitType: null, source: 'csv' };

  it.each([
    { sourceFileId: 'file' },
    { sourceFileName: 'a.csv' },
    { sourceFileId: null, sourceFileName: 'a.csv' },
    { sourceFileId: 'file', sourceFileName: null },
    { sourceFileId: 3, sourceFileName: 'a.csv' },
    { sourceFileId: 'file', sourceFileName: 3 },
    { sourceFileId: '', sourceFileName: 'a.csv' },
    { sourceFileId: 'file', sourceFileName: '   ' },
    { sourceFileId: 'x'.repeat(101), sourceFileName: 'a.csv' },
    { sourceFileId: 'file', sourceFileName: 'x'.repeat(256) },
  ])('rejects malformed metadata in single and bulk inputs: %j', async (metadata) => {
    const cookie = await signInAs('u1', 'owner@example.com');
    for (const bulk of [false, true]) {
      const res = await call(bulk ? '/api/queue/bulk' : '/api/queue', cookie, 'POST', bulk
        ? { items: [{ ...row, ...metadata }] } : { ...row, ...metadata });
      expect(res.status).toBe(400);
      const body = await res.json() as { fields: Record<string, string> };
      expect(Object.keys(body.fields).some((key) => key.includes('sourceFile'))).toBe(true);
    }
    expect(await repo().queueItems()).toEqual([]);
  });

  it.each([
    {}, { sourceFileId: null, sourceFileName: null },
    { sourceFileId: 'x'.repeat(100), sourceFileName: 'x'.repeat(255) },
  ])('accepts absent, null, and boundary-length paired metadata: %j', async (metadata) => {
    const cookie = await signInAs('u1', 'owner@example.com');
    const res = await call('/api/queue', cookie, 'POST', { ...row, ...metadata });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      sourceFileId: ('sourceFileId' in metadata ? metadata.sourceFileId : null),
      sourceFileName: ('sourceFileName' in metadata ? metadata.sourceFileName : null),
    });
  });
});
