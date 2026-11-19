import { describe, expect, it } from 'vitest';
import { cycleLocked, rosterNeedsConfirm } from '../src/lib/cycleRoster';
import type { Bootstrap, Cycle, QueueItem, Transaction } from '../src/types';

const cycle = (closedAt: number): Cycle => ({
  id: `c${closedAt}`, status: 'closed', settlementJson: null, closedByMemberId: null, closedByName: null,
  closingSnapshotJson: null, closedAt, settledAt: null, name: null,
});

const boot = (over: {
  role?: 'owner' | 'member'; rosterConfirmedAt?: number | null; cycles?: Cycle[];
  queue?: unknown[]; transactions?: unknown[];
} = {}): Bootstrap => ({
  me: { memberId: 'm1', role: over.role ?? 'owner' },
  household: {
    id: 'h1', name: 'Home', currencyCode: 'AUD', timezone: 'Australia/Sydney', customCategories: [],
    currentCycleName: null, rentReminder: false, rosterConfirmedAt: over.rosterConfirmedAt ?? null,
  },
  members: [], cards: [], categoryPreferences: {},
  transactions: (over.transactions ?? []) as Transaction[],
  queue: (over.queue ?? []) as QueueItem[],
  cycles: over.cycles ?? [],
});

describe('cycleLocked', () => {
  it('locks once the cycle has a Pending row or an Approved expense', () => {
    expect(cycleLocked(boot())).toBe(false);
    expect(cycleLocked(boot({ queue: [{}] }))).toBe(true);
    expect(cycleLocked(boot({ transactions: [{}] }))).toBe(true);
  });
});

describe('rosterNeedsConfirm', () => {
  it('asks a new group that was never saved', () => {
    expect(rosterNeedsConfirm(boot())).toBe(true);
  });
  it('asks again after a cycle closes later than the last save', () => {
    expect(rosterNeedsConfirm(boot({ rosterConfirmedAt: 100, cycles: [cycle(50), cycle(200)] }))).toBe(true);
  });
  it('does not ask once saved after the last close', () => {
    expect(rosterNeedsConfirm(boot({ rosterConfirmedAt: 300, cycles: [cycle(200), cycle(50)] }))).toBe(false);
    expect(rosterNeedsConfirm(boot({ rosterConfirmedAt: 300 }))).toBe(false);
  });
  it('does not ask a member who is not the owner', () => {
    expect(rosterNeedsConfirm(boot({ role: 'member' }))).toBe(false);
  });
  it('does not ask while the cycle is locked', () => {
    expect(rosterNeedsConfirm(boot({ queue: [{}] }))).toBe(false);
  });
});
