// Pure module: no React, no DOM API, no `?url` assets. The Workers-runtime parity test loads it.
import type { CycleGroup, Settlement, Transaction } from '../types';
import { computeSettlement } from '../lib/settlement';
import type { DemoState, SampleResult } from './types';
import { queueRoutes } from './queue';
import { DEMO_REFUSAL, HttpError, json } from './http';
import { parseHandler } from './parse';

export { DEMO_REFUSAL, DEMO_SAMPLE_ONLY } from './http';

export interface DemoServerOptions { now?: () => number; newId?: () => string; parseDelayMs?: number }
export interface DemoServer { handle(request: Request): Promise<Response>; state: DemoState }

export interface RouteContext { request: Request; url: URL; params: Record<string, string> }
export interface Route { method: string; pattern: string; handler: (ctx: RouteContext) => Response | Promise<Response> }

const refusal = () => json({ error: DEMO_REFUSAL, reason: 'demo_read_only' }, 403);
/** SQLite ordering for ids and dates: binary compare, NULL first. */
const cmp = (a: string | null, b: string | null) => (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
const newestFirst = (rows: Transaction[]) => [...rows].sort((a, b) => cmp(b.date, a.date));

/** Matches `/api/cycles/:id` style patterns segment by segment; returns params or null. */
function match(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':') && got[i]) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

export function createDemoServer(state: DemoState, samples: SampleResult[], options: DemoServerOptions = {}): DemoServer {
  const { now = Date.now, newId = () => crypto.randomUUID(), parseDelayMs = 1000 } = options;
  const roster = () => state.bootstrap.members.filter((m) => m.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder).map((m) => m.id);
  const transactionsByCycle = (cycleId: string) => newestFirst(state.archived.filter((tx) => tx.cycleId === cycleId));
  const findCycle = (id: string) => state.bootstrap.cycles.find((cy) => cy.id === id);

  /** Mirrors `cycleSettlement` (worker/lib/scope.ts): frozen snapshot once settled, live otherwise. */
  function cycleSettlement(cycleId: string): Settlement {
    const cycle = findCycle(cycleId)!;
    if (cycle.status === 'settled') {
      if (!cycle.settlementJson) throw new Error(`Cycle ${cycleId} is settled but has no settlement snapshot`);
      return JSON.parse(cycle.settlementJson) as Settlement;
    }
    return computeSettlement(transactionsByCycle(cycleId).map((tx) => ({
      payerId: tx.payerId, amountCents: tx.amountCents, shares: JSON.parse(tx.splitSharesJson) as Record<string, number>,
    })), roster());
  }

  /** Mirrors `cycleGroups`: group by payer, card and card name; order count desc, dateStart, payer, card. */
  function cycleGroups(cycleId: string): CycleGroup[] {
    const groups = new Map<string, CycleGroup>();
    for (const tx of state.archived.filter((row) => row.cycleId === cycleId)) {
      const key = JSON.stringify([tx.payerId, tx.cardId, tx.cardNameSnapshot]);
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { payerId: tx.payerId, cardId: tx.cardId, cardNameSnapshot: tx.cardNameSnapshot,
          dateStart: tx.date, dateEnd: tx.date, count: 1 });
      } else {
        g.count++;
        if (tx.date < g.dateStart) g.dateStart = tx.date;
        if (tx.date > g.dateEnd) g.dateEnd = tx.date;
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || cmp(a.dateStart, b.dateStart)
      || cmp(a.payerId, b.payerId) || cmp(a.cardId, b.cardId));
  }

  // Every request not listed here is refused.
  const routes: Route[] = [
    { method: 'GET', pattern: '/api/bootstrap', handler: () => json(state.bootstrap) },
    {
      method: 'GET', pattern: '/api/transactions', handler: ({ url }) =>
        // The client only reads the archive; active and per-cycle listings stay refused.
        url.searchParams.get('status') === 'archived' && !url.searchParams.has('cycleId')
          ? json(newestFirst(state.archived)) : refusal(),
    },
    {
      method: 'GET', pattern: '/api/transactions/history/:expenseId', handler: ({ params }) => {
        // No lineage walk: the demo refuses splits and seeds no split children, so an expense's history is its own events.
        const events = state.history.filter((e) => e.expenseId === params.expenseId)
          .sort((a, b) => b.timestamp - a.timestamp || b.after.revision - a.after.revision);
        return events.length ? json(events) : json({ error: 'Expense history not found' }, 404);
      },
    },
    {
      method: 'GET', pattern: '/api/cycles', handler: () => json(state.bootstrap.cycles.map((cy) => ({
        ...cy, settlement: cycleSettlement(cy.id), groups: cycleGroups(cy.id),
      }))),
    },
    {
      method: 'GET', pattern: '/api/cycles/:id', handler: ({ params }) => {
        const cycle = findCycle(params.id);
        if (!cycle) return json({ error: 'Cycle not found' }, 404);
        return json({ cycle, transactions: transactionsByCycle(cycle.id), settlement: cycleSettlement(cycle.id) });
      },
    },
    {
      method: 'GET', pattern: '/api/groups', handler: () => {
        const { household, me, members, queue } = state.bootstrap;
        return json({
          groups: [{ id: household.id, name: household.name, role: 'owner', memberId: me.memberId,
            peopleCount: members.filter((m) => m.archivedAt === null).length, pendingCount: queue.length }],
          canCreate: false,
        });
      },
    },
    { method: 'GET', pattern: '/api/reminders', handler: () => json([]) },
    { method: 'GET', pattern: '/api/auth/get-session', handler: () => json(null) },
    ...queueRoutes({ state, now, newId, roster }),
    { method: 'POST', pattern: '/api/ai/parse-receipt', handler: parseHandler(state, samples, parseDelayMs) },
  ];

  return {
    state,
    async handle(request) {
      try {
        const url = new URL(request.url);
        for (const route of routes) {
          if (route.method !== request.method) continue;
          const params = match(route.pattern, url.pathname);
          if (params) return await route.handler({ request, url, params });
        }
        return refusal();
      } catch (error) {
        // AbortError and unexpected errors propagate; the guard rethrows the first and renders the generic 500.
        if (!(error instanceof HttpError)) throw error;
        return json({ error: error.message, ...(error.reason && { reason: error.reason }) }, error.status);
      }
    },
  };
}
