import { describe, expect, it } from 'vitest';
import sampleResults from '../src/demo/sample-results.json';
import { buildDemoData } from '../src/demo/data';
import type { SampleResult } from '../src/demo/types';
import type { ClosingSnapshot } from '../src/types';
import { CATEGORIES } from '../src/constants';
import { normalizeMerchantName } from '../src/lib/category';
import { isDuplicateMatch } from '../src/lib/duplicates';

const samples = sampleResults.samples as SampleResult[];
type SampleRow = { date: string; store: string; amountCents: number; category: string };
const rowsOf = (sample: SampleResult): SampleRow[] =>
  sample.status === 200 ? (sample.body as { transactions: SampleRow[] }).transactions : [];

describe('buildDemoData', () => {
  const state = buildDemoData(samples);
  const { bootstrap, archived, history } = state;
  const open = bootstrap.transactions;
  const all = [...open, ...archived];

  it('is deterministic', () => {
    expect(buildDemoData(samples)).toEqual(state);
  });

  it('has the household and roster', () => {
    expect(bootstrap.me).toEqual({ memberId: 'mem_alex', role: 'owner' });
    expect(bootstrap.household).toEqual({
      id: 'hh_demo', name: 'Demo Household', currencyCode: 'CAD', timezone: 'America/Vancouver', customCategories: [],
      currentCycleName: null,
    });
    expect(bootstrap.members.map(({ id, displayName, role, sortOrder }) => ({ id, displayName, role, sortOrder }))).toEqual([
      { id: 'mem_alex', displayName: 'Alex', role: 'owner', sortOrder: 0 },
      { id: 'mem_sam', displayName: 'Sam', role: 'member', sortOrder: 1 },
    ]);
    expect(bootstrap.cards.map(({ id, name, memberId, sortOrder, statementDay }) => ({ id, name, memberId, sortOrder, statementDay }))).toEqual([
      { id: 'card_demo_visa', name: 'Demo Visa', memberId: 'mem_alex', sortOrder: 0, statementDay: 5 },
      { id: 'card_demo_mc', name: 'Demo Mastercard', memberId: 'mem_sam', sortOrder: 1, statementDay: 20 },
    ]);
  });

  it('ids are unique', () => {
    const ids = [...open, ...archived, ...bootstrap.queue, ...bootstrap.cycles, ...history].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shares sum to amounts', () => {
    for (const tx of all) {
      const shares = Object.values(JSON.parse(tx.splitSharesJson) as Record<string, number>);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(tx.amountCents);
    }
    expect(new Set(all.map((tx) => tx.splitType))).toEqual(new Set(['equal', 'single', 'custom']));
  });

  it('categories are canonical', () => {
    for (const row of [...all, ...bootstrap.queue]) {
      if (row.category !== null) expect(CATEGORIES).toContain(row.category);
    }
  });

  it('six closed cycles March to August 2026', () => {
    const cycles = bootstrap.cycles;
    expect(cycles).toHaveLength(6);
    const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    for (const month of months) {
      const rows = archived.filter((tx) => tx.date.startsWith(month));
      expect(rows.length).toBeGreaterThan(0);
      const cycle = cycles.find((c) => c.id === rows[0].cycleId)!;
      expect(rows.every((tx) => tx.cycleId === cycle.id)).toBe(true);
      if (month === '2026-08') {
        expect(cycle.status).toBe('closed');
        expect(cycle.settlementJson).toBeNull();
      } else {
        expect(cycle.status).toBe('settled');
        expect(cycle.settlementJson).not.toBeNull();
      }
    }
    for (const cycle of cycles) {
      const closing = JSON.parse(cycle.closingSnapshotJson!) as ClosingSnapshot;
      expect(closing.transactions.map((tx) => tx.id).sort())
        .toEqual(archived.filter((tx) => tx.cycleId === cycle.id).map((tx) => tx.id).sort());
      // At the closed revision, so History does not report the cycle as changed since closing.
      const byId = new Map(archived.map((tx) => [tx.id, tx]));
      for (const tx of closing.transactions) expect(tx).toEqual({ ...byId.get(String(tx.id)), state: 'approved' });
      expect(closing.members).toEqual(bootstrap.members.map(({ id, displayName, role, sortOrder, archivedAt }) =>
        ({ id, displayName, role, sortOrder, archivedAt })));
      expect(archived.some((tx) => tx.cycleId === cycle.id)).toBe(true);
    }
    for (const tx of archived) expect(cycles.map((c) => c.id)).toContain(tx.cycleId);
  });

  it('open month is September 2026', () => {
    expect(open.length).toBeGreaterThan(0);
    for (const tx of open) {
      expect(tx.date.startsWith('2026-09')).toBe(true);
      expect(tx.cycleId).toBeNull();
    }
  });

  it('seeds two sample-a1 matches', () => {
    const a1 = rowsOf(samples.find((s) => s.id === 'sample-a1')!);
    const matches = open.filter((tx) => a1.some((row) => isDuplicateMatch(tx, row)));
    expect(matches).toHaveLength(2);
    for (const tx of matches) {
      expect(tx.payerId).toBe('mem_alex');
      expect(tx.cardId).toBe('card_demo_visa');
    }
  });

  it('no other seeded open or Pending row matches any sample row', () => {
    const pairs: string[] = [];
    for (const sample of samples) {
      for (const row of rowsOf(sample)) {
        for (const seeded of [...open, ...bootstrap.queue]) {
          if (isDuplicateMatch(seeded, row)) pairs.push(`${sample.id}:${seeded.id}`);
        }
      }
    }
    expect(pairs).toHaveLength(2);
    expect(pairs.every((pair) => pair.startsWith('sample-a1:'))).toBe(true);
    expect(new Set(pairs).size).toBe(2);
  });

  it('category preferences name only merchants absent from every sample', () => {
    const sampleStores = new Set(samples.flatMap(rowsOf).map((row) => normalizeMerchantName(row.store)));
    const keys = Object.keys(bootstrap.categoryPreferences);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(sampleStores.has(normalizeMerchantName(key))).toBe(false);
      expect(CATEGORIES).toContain(bootstrap.categoryPreferences[key]);
    }
  });

  it('pending rows are never approved', () => {
    const queue = bootstrap.queue;
    expect(queue.length).toBeGreaterThanOrEqual(2);
    expect(queue.length).toBeLessThanOrEqual(3);
    for (const item of queue) expect(item.hasBeenApproved).toBe(false);
    const required = ['date', 'store', 'amountCents', 'category', 'payerId', 'splitType'] as const;
    expect(queue.some((item) => required.some((field) => item[field] === null))).toBe(true);
  });

  it('history covers approved and archived rows', () => {
    const events = (expenseId: string, type: string) =>
      history.filter((e) => e.expenseId === expenseId && e.eventType === type);
    for (const tx of open) {
      const approved = events(tx.expenseId, 'approved');
      expect(approved).toHaveLength(1);
      expect(approved[0].after.state).toBe('approved');
      expect(approved[0].before?.state).toBe('pending');
    }
    for (const tx of archived) {
      const approved = events(tx.expenseId, 'approved');
      const closed = events(tx.expenseId, 'closed');
      expect(approved).toHaveLength(1);
      expect(closed).toHaveLength(1);
      expect(approved[0].after.state).toBe('approved');
      expect(closed[0].after.state).toBe('approved');
      expect(closed[0].after.cycleId).toBe(tx.cycleId);
      expect(closed[0].after.revision).toBe(tx.revision);
      expect(closed[0].before?.revision).toBe(tx.revision - 1);
    }
  });
});
