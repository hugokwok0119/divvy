import { describe, it, expect } from 'vitest';
import {
  approvedPatch,
  draftFrom,
  patchFrom,
  changePayer,
  validateDraft,
  expenseDifferences,
  rebaseDraft,
  visibleExpenseHistory,
} from '../src/components/ledger';
import type { QueueItem, ExpenseHistoryEvent } from '../src/types';
const item: QueueItem = {
  hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
  id: 'q',
  expenseId: 'e',
  revision: 3,
  date: null,
  store: null,
  amountCents: null,
  category: null,
  payerId: null,
  cardId: 'c',
  splitType: null,
  splitRuleJson: null,
  source: 'csv',
  sourceFileId: 'f',
  sourceFileName: 'statement.csv',
  isDuplicate: 0,
  editedByMemberId: null,
  editedByName: null,
  updatedAt: 0,
  reviewNote: null,
};
describe('ledger drafts', () => {
  it('hides first-time typing and no-op snapshots but retains approval and source edits', () => {
    const event = (id: string, revision: number, eventType: ExpenseHistoryEvent['eventType'], state: 'pending' | 'approved', store: string, previous?: string): ExpenseHistoryEvent => ({
      id, expenseId: 'source', eventType, actorMemberId: 'm1', actorName: 'Alex', timestamp: revision,
      before: previous === undefined ? null : { expenseId: 'source', revision: revision - 1, state, updatedAt: revision - 1, reviewNote: null, store: previous },
      after: { expenseId: 'source', revision, state, updatedAt: revision, reviewNote: null, store }, reviewNote: null,
    });
    const events = [event('import', 1, 'imported', 'pending', ''), event('typing', 2, 'edited', 'pending', 'Shop', ''),
      event('approve', 3, 'approved', 'approved', 'Shop'), event('noop', 4, 'edited', 'approved', 'Shop', 'Shop'),
      event('edit', 5, 'edited', 'approved', 'Market', 'Shop'), event('returnedEdit', 6, 'edited', 'pending', 'New', 'Market')];
    expect(visibleExpenseHistory(events).map(row => row.id)).toEqual(['approve', 'edit', 'returnedEdit']);
  });
  it('normalizes saved values while retaining typing and unfinished allocation after a request', () => {
    const sent = { ...draftFrom(item), amount: '50' };
    const saved = { ...sent, amount: '50.00' };
    expect(rebaseDraft(saved, sent, sent).amount).toBe('50.00');
    const current = { ...sent, amount: '-', store: 'new prefix', customAllocation: { percentages: { m1: '80' } } };
    expect(rebaseDraft(saved, sent, current)).toEqual(current);
  });
  it('keeps legacy malformed allocation JSON readable', () => {
    expect(draftFrom({ ...item, splitRuleJson: '{invalid' }).splitRule).toBeNull();
  });
  it('retains nullable fields and source without manufacturing a transaction', () => {
    const draft = draftFrom(item);
    expect(draft.payerId).toBe('');
    expect(draft.amount).toBe('');
    expect(patchFrom(draft)).toMatchObject({
      date: null,
      store: null,
      amountCents: null,
      payerId: null,
      splitType: null,
    });
    expect(item.sourceFileName).toBe('statement.csv');
  });
  it('persists signed amounts and single/custom rules', () => {
    const draft = {
      ...draftFrom(item),
      amount: '-12.34',
      splitType: 'single',
      splitRule: { memberId: 'm2' },
    };
    expect(patchFrom(draft)).toMatchObject({
      amountCents: -1234,
      splitRule: { memberId: 'm2' },
    });
    expect(
      patchFrom({
        ...draft,
        splitType: 'custom',
        splitRule: { percentages: { m1: 70, m2: 30 } },
      }),
    ).toMatchObject({ splitRule: { percentages: { m1: 70, m2: 30 } } });
  });
  it('clears incompatible card when payer changes', () => {
    expect(changePayer(draftFrom(item), 'm2').cardId).toBe('');
  });
  it('requires complete approval and a full custom allocation', () => {
    expect(() => validateDraft(draftFrom(item), true)).toThrow();
    const draft = {
      ...draftFrom(item),
      date: '2026-10-01',
      store: 'Shop',
      amount: '10',
      category: 'Other',
      payerId: 'm1',
      splitType: 'custom',
      splitRule: { percentages: { m1: 70 } },
    };
    expect(() => validateDraft(draft, true)).toThrow('100');
  });
  it('renders saved share differences with member names and signed money', () => {
    const before = { splitSharesJson: '{"m1":6000,"m2":4000}' };
    const after = { splitSharesJson: { m1: 7200, m2: -4800, missing: 0 } };
    expect(expenseDifferences(before, after, { m1: 'Alex', m2: 'Sam' })).toEqual([
      { field: 'Shares', before: 'Alex $60.00 · Sam $40.00', after: 'Alex $72.00 · Sam -$48.00 · Former member $0.00' },
    ]);
    expect(before.splitSharesJson).toBe('{"m1":6000,"m2":4000}');
    expect(after.splitSharesJson).toEqual({ m1: 7200, m2: -4800, missing: 0 });
  });
  it('renders string and object split rules as names or percentages', () => {
    expect(expenseDifferences(
      { splitRuleJson: '{"memberId":"m2"}' },
      { splitRuleJson: { percentages: { m1: 60, m2: 40 } } },
      { m1: 'Alex', m2: 'Sam' },
    )).toEqual([{ field: 'Split allocation', before: 'Sam', after: 'Alex 60% · Sam 40%' }]);
    expect(expenseDifferences(null, { splitRuleJson: { memberId: 'missing' } })[0].after).toBe('Former member');
  });
  it.each(['{invalid', '[]', '4', '{"m1":"bad"}', '{"m1":1.5}'])('keeps malformed saved shares readable: %s', splitSharesJson => {
    expect(expenseDifferences(null, { splitSharesJson })[0].after).toBe('Allocation unavailable');
  });
  it('handles missing, empty and malformed split rules without exposing JSON', () => {
    expect(expenseDifferences(null, { splitRuleJson: null })[0].after).toBe('Not set');
    expect(expenseDifferences(null, { splitRuleJson: '{}' })[0].after).toBe('Not set');
    expect(expenseDifferences(null, { splitSharesJson: {} })[0].after).toBe('Not set');
    expect(expenseDifferences(null, { splitRuleJson: '{invalid' })[0].after).toBe('Allocation unavailable');
    expect(expenseDifferences(null, { splitRuleJson: { percentages: { m1: 'bad' } } })[0].after).toBe('Allocation unavailable');
  });
  it('shows real value differences, without internal revision metadata', () => {
    expect(
      expenseDifferences({ amountCents: 1000, revision: 1 }, { amountCents: 2500, revision: 2 }),
    ).toEqual([{ field: 'Amount', before: '10.00', after: '25.00' }]);
  });
});


describe('numeric completion boundaries', () => {
  const complete = {
    ...draftFrom(item), date: '2026-10-13', store: 'Market', amount: '50',
    category: 'Other', payerId: 'm1', splitType: 'custom',
    splitRule: { percentages: { m1: 50, m2: 50 } },
  };
  it('keeps an erased amount unsaved instead of converting it to zero or null', () => {
    const erased = { ...complete, amount: '' };
    expect(erased.amount).toBe('');
    expect(() => validateDraft(erased, false, complete)).toThrow();
    expect(validateDraft({ ...complete, amount: '80' }, false, complete).amountCents).toBe(8000);
  });
  it('keeps untouched missing Pending amounts nullable', () => {
    const base = draftFrom(item);
    expect(validateDraft({ ...base, store: 'Updated' }, false, base).amountCents).toBeNull();
  });
  it('rejects custom totals beyond representation error', () => {
    expect(() => validateDraft({ ...complete, splitRule: { percentages: { m1: 99.9995, m2: 0 } } }, true)).toThrow();
  });
  it('preserves unchanged legacy allocations during unrelated edits', () => {
    const base = { ...complete, splitRule: { percentages: { m1: 20, m2: 20 } } };
    const changed = { ...base, store: 'Updated', amount: '-12.34' };
    const patch = approvedPatch(changed, base);
    expect(patch).toMatchObject({ store: 'Updated', amountCents: -1234 });
    expect(patch).not.toHaveProperty('splitType');
    expect(patch).not.toHaveProperty('splitRule');
    expect(() => validateDraft({ ...changed, splitRule: { percentages: { m1: 25, m2: 25 } } }, true, base)).toThrow();
  });
  it('applies the existing server money limit before saving', () => {
    for (const amount of ['1000000.01', '-1000000.01']) {
      expect(() => validateDraft({ ...complete, amount }, true)).toThrow();
    }
    expect(validateDraft({ ...complete, amount: '1000000' }, true).amountCents).toBe(100000000);
    expect(validateDraft({ ...complete, amount: '0' }, true).amountCents).toBe(0);
  });
});


it('requires explicit allocation completion before saving a row', () => {
  const base = draftFrom({ ...item, amountCents: 5000, splitType: 'equal' });
  const draft = { ...base, customAllocation: { percentages: { m1: '80', m2: '20' } } };
  expect(() => validateDraft(draft, false, base)).toThrow();
});


it('preserves reordered legacy percentages on an unrelated edit', () => {
  const base = { ...draftFrom(item), date: '2026-10-13', store: 'Market', amount: '50',
    category: 'Other', payerId: 'm1', splitType: 'custom', splitRule: { percentages: { m1: 20, m2: 20 } } };
  const patch = approvedPatch({ ...base, store: 'Updated', splitRule: { percentages: { m2: 20, m1: 20 } } }, base);
  expect(patch).toMatchObject({ store: 'Updated' });
  expect(patch).not.toHaveProperty('splitRule');
  expect(patch).not.toHaveProperty('splitType');
});
it('rejects a non-normalizable unchanged custom allocation at approval', () => {
  const base = { ...draftFrom(item), date: '2026-10-13', store: 'Market', amount: '50',
    category: 'Other', payerId: 'm1', splitType: 'custom', splitRule: { percentages: { m1: 0, m2: 0 } } };
  expect(() => validateDraft(base, true, base)).toThrow();
});
