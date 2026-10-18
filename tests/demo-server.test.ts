import { describe, expect, it } from 'vitest';
import sampleResults from '../src/demo/sample-results.json';
import { buildDemoData } from '../src/demo/data';
import { createDemoServer, DEMO_REFUSAL } from '../src/demo/server';
import type { SampleResult } from '../src/demo/types';
import { computeSettlement } from '../src/lib/settlement';
import type { Cycle, CycleGroup, Settlement, Transaction } from '../src/types';

const samples = sampleResults.samples as SampleResult[];
const setup = () => {
  const state = buildDemoData(samples);
  return { state, server: createDemoServer(state, samples) };
};
const send = (server: ReturnType<typeof setup>['server'], method: string, path: string) =>
  server.handle(new Request(`https://demo.test${path}`, { method }));

describe('demo server reads', () => {
  it('serves bootstrap', async () => {
    const { state, server } = setup();
    const res = await send(server, 'GET', '/api/bootstrap');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as typeof state.bootstrap;
    expect(body).toEqual(state.bootstrap);
    body.transactions.length = 0;
    expect(state.bootstrap.transactions.length).toBeGreaterThan(0);
  });

  it('serves archived transactions newest first', async () => {
    const { state, server } = setup();
    const res = await send(server, 'GET', '/api/transactions?status=archived');
    expect(res.status).toBe(200);
    const body = await res.json() as Transaction[];
    expect(body).toHaveLength(state.archived.length);
    expect(new Set(body.map((tx) => tx.id))).toEqual(new Set(state.archived.map((tx) => tx.id)));
    expect(body.map((tx) => tx.date)).toEqual(body.map((tx) => tx.date).sort().reverse());
  });

  it('serves cycles with settlement and groups', async () => {
    const { state, server } = setup();
    const res = await send(server, 'GET', '/api/cycles');
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Cycle & { settlement: Settlement; groups: CycleGroup[] }>;
    expect(body.map(({ settlement: _s, groups: _g, ...cy }) => cy)).toEqual(state.bootstrap.cycles);
    const roster = state.bootstrap.members.map((m) => m.id);
    for (const cy of body) {
      const rows = state.archived.filter((tx) => tx.cycleId === cy.id);
      expect(cy.settlement).toEqual(cy.status === 'settled' ? JSON.parse(cy.settlementJson!)
        : computeSettlement(rows.map((tx) => ({ payerId: tx.payerId, amountCents: tx.amountCents,
          shares: JSON.parse(tx.splitSharesJson) })), roster));
      expect(cy.groups.reduce((sum, g) => sum + g.count, 0)).toBe(rows.length);
      for (const g of cy.groups) {
        expect(Object.keys(g).sort()).toEqual(['cardId', 'cardNameSnapshot', 'count', 'dateEnd', 'dateStart', 'payerId']);
        const dates = rows.filter((tx) => tx.payerId === g.payerId && tx.cardId === g.cardId
          && tx.cardNameSnapshot === g.cardNameSnapshot).map((tx) => tx.date).sort();
        expect([g.count, g.dateStart, g.dateEnd]).toEqual([dates.length, dates[0], dates.at(-1)]);
      }
      expect(cy.groups.map((g) => g.count)).toEqual(cy.groups.map((g) => g.count).sort((a, b) => b - a));
    }
    expect(body.some((cy) => cy.status === 'settled') && body.some((cy) => cy.status === 'closed')).toBe(true);
  });

  it('serves cycle detail', async () => {
    const { state, server } = setup();
    const cycle = state.bootstrap.cycles.find((cy) => cy.status === 'closed')!;
    const res = await send(server, 'GET', `/api/cycles/${cycle.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { cycle: Cycle; transactions: Transaction[]; settlement: Settlement };
    expect(body.cycle).toEqual(cycle);
    expect(body.transactions).toEqual(state.archived.filter((tx) => tx.cycleId === cycle.id));
    expect(body.settlement.balances).toBeDefined();

    const missing = await send(server, 'GET', '/api/cycles/cyc_nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Cycle not found' });
  });

  it('serves expense history', async () => {
    const { state, server } = setup();
    const expenseId = state.archived[0].expenseId;
    const res = await send(server, 'GET', `/api/transactions/history/${encodeURIComponent(expenseId)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as typeof state.history;
    const expected = state.history.filter((e) => e.expenseId === expenseId);
    expect(body.map((e) => e.eventType)).toEqual(['closed', 'approved']);
    expect(body).toEqual([...expected].reverse());

    const unknown = await send(server, 'GET', '/api/transactions/history/exp_nope');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Expense history not found' });
  });

  it('answers get-session with null', async () => {
    const res = await send(setup().server, 'GET', '/api/auth/get-session');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('null');
  });

  it('reminders are empty', async () => {
    const res = await send(setup().server, 'GET', '/api/reminders?month=2026-10');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('demo server refusals', () => {
  it.each([
    ['POST', '/api/transactions'], ['PATCH', '/api/transactions/x'], ['DELETE', '/api/transactions/x'],
    ['POST', '/api/transactions/x/pending'], ['POST', '/api/transactions/x/split'],
    ['POST', '/api/transactions/apply-category-suggestions'], ['POST', '/api/queue'], ['POST', '/api/queue/x/split'],
    ['POST', '/api/cycles/close'], ['POST', '/api/cycles/x/settle'], ['POST', '/api/cycles/x/unsettle'],
    ['PATCH', '/api/household'], ['POST', '/api/members'], ['POST', '/api/cards'], ['DELETE', '/api/cards/x'],
    ['PUT', '/api/cards/order'], ['PUT', '/api/members/order'], ['PUT', '/api/reminders'], ['GET', '/api/export'],
    ['POST', '/api/auth/sign-out'], ['GET', '/api/unknown'],
    ['GET', '/api/transactions'], ['GET', '/api/transactions?cycleId=x'],
  ])('refuses %s %s', async (method, path) => {
    const res = await send(setup().server, method, path);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: DEMO_REFUSAL, reason: 'demo_read_only' });
  });
});
