import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';

describe('unauthenticated access', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['GET', '/api/bootstrap'],
    ['GET', '/api/transactions'],
    ['POST', '/api/transactions'],
    ['POST', '/api/transactions/bulk'],
    ['PATCH', '/api/transactions/t1'],
    ['DELETE', '/api/transactions/t1'],
    ['GET', '/api/queue'],
    ['POST', '/api/queue'],
    ['POST', '/api/queue/bulk'],
    ['POST', '/api/queue/delete-bulk'],
    ['PATCH', '/api/queue/q1'],
    ['DELETE', '/api/queue/q1'],
    ['POST', '/api/queue/q1/confirm'],
    ['GET', '/api/cycles'],
    ['GET', '/api/cycles/cy1'],
    ['POST', '/api/cycles/close'],
    ['POST', '/api/cycles/cy1/settle'],
    ['POST', '/api/cycles/cy1/unsettle'],
    ['PATCH', '/api/household'],
    ['GET', '/api/members'],
    ['POST', '/api/members'],
    ['PATCH', '/api/members/m1'],
    ['DELETE', '/api/members/m1'],
    ['GET', '/api/cards'],
    ['POST', '/api/cards'],
    ['PATCH', '/api/cards/c1'],
    ['DELETE', '/api/cards/c1'],
    ['GET', '/api/export'],
    ['POST', '/api/ai/parse-receipt'],
  ];

  it.each(protectedRoutes)('%s %s returns 401', async (method, path) => {
    const res = await SELF.fetch(`https://divvy.test${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    expect(res.status).toBe(401);
  });

  it('leaves /api/health open', async () => {
    expect((await SELF.fetch('https://divvy.test/api/health')).status).toBe(200);
  });

  it('never falls back to the SPA shell for an unmatched API path', async () => {
    // requireScope runs on /api/* before Hono resolves the route, so an
    // unauthenticated request to an unknown API path gets 401, not 404 —
    // that's correct: 404ing unknown paths while 401ing real ones would let
    // an unauthenticated caller enumerate the route table by status code.
    // The property this test guards is narrower: with run_worker_first now
    // true, the app.get('*', ...) fallback added for static assets must
    // never catch an unmatched /api/* path and serve the SPA's index.html.
    const res = await SELF.fetch('https://divvy.test/api/nonexistent');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('<title>Divvy</title>');
  });

  it('sets no-store on API responses', async () => {
    const res = await SELF.fetch('https://divvy.test/api/bootstrap');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('security headers', () => {
  // Registered as the very first `app.use('*', ...)` in worker/index.ts, so
  // it should wrap every response — an API route and a non-API (static
  // asset / SPA) route both need to carry it, not just /api/*.
  const expectSecurityHeaders = (res: Response) => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe(
      'camera=(self), geolocation=(), microphone=()',
    );
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
  };

  it('applies to an API route', async () => {
    const res = await SELF.fetch('https://divvy.test/api/health');
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it('applies to a non-API path served through the assets fallback', async () => {
    const res = await SELF.fetch('https://divvy.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Divvy</title>');
    expectSecurityHeaders(res);
  });
});

describe('queue date updates', () => {
  const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;
  const db = () => drizzle(env.DB);
  const repo = () => new ScopedRepository(db(), 'h1');
  let cookie: string;

  beforeEach(async () => {
    for (const table of ['transactions', 'queue_items', 'cards', 'household_members', 'households', 'session', 'user']) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
    await db().insert(householdMembers).values({
      id: 'm1', householdId: 'h1', displayName: 'Hugo', userId: 'u1', createdAt: 0, sortOrder: 0,
    });
    const now = Date.now();
    await env.DB.prepare(
      'insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)',
    ).bind('u1', 'Hugo', 'owner@example.com', now, now).run();
    const ctx = await createAuth(testEnv).$context;
    const session = await ctx.internalAdapter.createSession('u1');
    cookie = (await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret)).split(';')[0];
    await repo().insertQueueItem({
      id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 586, category: 'Transport',
      payerId: 'm1', cardId: null, splitType: 'equal', source: 'csv',
    });
  });

  const request = (path: string, method: string, body: unknown) => workerApp.request(
    `http://localhost/api/queue${path ? `/${path}` : ''}`, {
      method, headers: { Cookie: cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, testEnv,
  );

  it('retains file provenance through POST, PATCH, queue reload and bootstrap', async () => {
    const create = await request('', 'POST', {
      id: 'file-q', date: null, store: 'File store', amountCents: 500, category: null,
      payerId: 'm1', cardId: null, splitType: null, source: 'csv',
      sourceFileId: 'upload-1', sourceFileName: 'original.csv',
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ sourceFileId: 'upload-1', sourceFileName: 'original.csv' });
    const patch = await request('file-q', 'PATCH', { revision: 1, store: 'Updated store', sourceFileId: 'other', sourceFileName: 'changed.csv' });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ revision: 2, store: 'Updated store', sourceFileId: 'upload-1', sourceFileName: 'original.csv' });
    for (const path of ['/api/queue', '/api/bootstrap']) {
      const response = await workerApp.request(`http://localhost${path}`, { headers: { Cookie: cookie } }, testEnv);
      expect(response.status).toBe(200);
      const body = await response.json() as { queue?: unknown[] } | unknown[];
      const queue = Array.isArray(body) ? body : body.queue;
      expect(queue).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'file-q', sourceFileId: 'upload-1', sourceFileName: 'original.csv' }),
      ]));
    }
  });

  it.each(['2024-06-10', null])('persists a date PATCH with %s', async (date) => {
    const response = await request('q1', 'PATCH', { date, revision: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'q1', date });
    expect((await repo().queueItems())[0].date).toBe(date);
  });

  it.each(['2024-06-10', null])('confirms a known date and rejects a cleared date: %s', async (date) => {
    expect((await request('q1', 'PATCH', { date, revision: 1 })).status).toBe(200);
    const response = await request('q1/confirm', 'POST', {
      revision: 2, transactionId: 't1',
      transaction: {
        id: 't1', date, store: 'Uber', amountCents: 586, category: 'Transport',
        payerId: 'm1', cardId: null, splitType: 'equal', splitRule: null,
      },
    });
    expect(response.status).toBe(date === null ? 400 : 201);
    if (date === null) {
      expect(await response.json()).toMatchObject({ fields: { date: 'Expected YYYY-MM-DD' } });
      expect((await repo().queueItems())[0].date).toBeNull();
      expect(await repo().activeTransactions()).toHaveLength(0);
    } else {
      expect((await repo().activeTransactions())[0].date).toBe('2024-06-10');
      expect(await repo().queueItems()).toHaveLength(0);
    }
  });
});


describe('cycle closing HTTP boundary', () => {
  const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;
  const db = () => drizzle(env.DB);
  const repo = () => new ScopedRepository(db(), 'h1');
  let cookie: string;
  const input = { cycleId: 'cy1', transactionIds: ['t1'], confirmed: true, revisions: { t1: 1 } };
  const request = (path: string, method = 'GET', body?: unknown) => workerApp.request(`http://localhost/api/${path}`, {
    method, headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);

  beforeEach(async () => {
    for (const table of ['transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households', 'session', 'user']) await env.DB.exec(`DELETE FROM ${table}`);
    await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
    await db().insert(householdMembers).values({ id: 'm1', householdId: 'h1', userId: 'u1', displayName: 'Alex', role: 'member', createdAt: 0 });
    const now = Date.now();
    await env.DB.prepare('insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)').bind('u1', 'Account name', 'owner@example.com', now, now).run();
    const ctx = await createAuth(testEnv).$context;
    const session = await ctx.internalAdapter.createSession('u1');
    cookie = (await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret)).split(';')[0];
    await repo().insertTransaction({ id: 't1', date: '2026-10-13', store: 'Market', amountCents: 1000, category: 'Groceries', payerId: 'm1', cardId: null, splitType: 'equal', splitRule: null });
  });

  it.each([undefined, false, 'true', 1])('rejects confirmation %s', async confirmed => {
    expect((await request('cycles/close', 'POST', { ...input, confirmed })).status).toBe(400);
    expect(await repo().cycles()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it.each([undefined, {}, { t1: 0 }, { t1: 1.5 }, { t1: '1' }, { t1: Number.MAX_SAFE_INTEGER + 1 }, { t1: 1, extra: 1 }])('rejects malformed selected revisions %s', async revisions => {
    expect((await request('cycles/close', 'POST', { ...input, revisions })).status).toBe(400);
    expect(await repo().cycles()).toEqual([]);
  });

  it('allows ordinary member closure, ignores spoofed closer and keeps settlement owner-only', async () => {
    const response = await request('cycles/close', 'POST', { ...input, closedByMemberId: 'other', closedByName: 'Imposter', actor: { memberId: 'other', displayName: 'Imposter' } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ closedByMemberId: 'm1', closedByName: 'Alex', status: 'closed', settledAt: null });
    expect((await request('cycles/cy1/settle', 'POST')).status).toBe(403);
    await repo().settleCycle('cy1');
    expect((await request('cycles/cy1/unsettle', 'POST')).status).toBe(403);
    expect((await request('transactions/t1', 'PATCH', { revision: 2, amountCents: 2000 })).status).toBe(409);
    for (const path of ['cycles', 'cycles/cy1']) {
      const read = await request(path);
      expect(read.status).toBe(200);
      const result = await read.json() as any;
      const saved = Array.isArray(result) ? result[0] : result.cycle;
      expect(saved).toMatchObject({ closedByName: 'Alex', closingSnapshotJson: expect.any(String) });
    }
  });
});
