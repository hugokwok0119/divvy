import { describe, it, expect } from 'vitest';
import { findMatchingTransaction } from '../src/components/ReviewQueue';
import type { QueueItem, Transaction } from '../src/types';

const queueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
  expenseId: 'expense-test', revision: 1, editedByMemberId: null, editedByName: null, sourceFileId: null, sourceFileName: null, reviewNote: null, splitRuleJson: null, updatedAt: 0,
  id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 586, category: null,
  payerId: null, cardId: null, splitType: null, isDuplicate: 1, source: 'csv',
  ...overrides,
});

const tx = (overrides: Partial<Transaction> = {}): Transaction => ({
  hasBeenApproved: true, lastEditedAt: null, parentExpenseId: null,
  expenseId: 'expense-approved', revision: 1, editedByMemberId: null, editedByName: null, sourceFileId: null, sourceFileName: null, reviewNote: null, source: 'manual',
  id: 't1', cycleId: null, date: '2024-06-09', store: 'Uber', amountCents: 586,
  category: 'Transport', payerId: 'm1', cardId: null, cardNameSnapshot: null,
  splitType: 'equal', splitRuleJson: null, splitSharesJson: '{}', isStarred: 0,
  favoriteName: null, updatedAt: 0,
  ...overrides,
});

describe('findMatchingTransaction', () => {
  it('excludes the same logical expense after returning to Pending', () => {
    expect(findMatchingTransaction(queueItem(), [tx({ expenseId: 'expense-test' })])).toBeNull();
  });
  it('finds a transaction with the same amount, normalized merchant, and nearby date', () => {
    const match = findMatchingTransaction(queueItem(), [tx()]);
    expect(match?.id).toBe('t1');
  });

  it('matches merchant names that differ only by case and punctuation', () => {
    const match = findMatchingTransaction(queueItem({ store: 'UBER *TRIP' }), [tx({ store: 'Uber Trip' })]);
    expect(match?.id).toBe('t1');
  });

  it('returns null when the amount differs', () => {
    expect(findMatchingTransaction(queueItem({ amountCents: 100 }), [tx()])).toBeNull();
  });

  it('returns null when the merchant differs', () => {
    expect(findMatchingTransaction(queueItem({ store: 'Lyft' }), [tx()])).toBeNull();
  });

  it('returns null when the date is outside the matching window', () => {
    expect(findMatchingTransaction(queueItem({ date: '2024-01-01' }), [tx()])).toBeNull();
  });

  it('returns null when the item names a payer that disagrees with the transaction', () => {
    expect(findMatchingTransaction(queueItem({ payerId: 'm2' }), [tx({ payerId: 'm1' })])).toBeNull();
  });

  it('still matches when the item has no payer set', () => {
    expect(findMatchingTransaction(queueItem({ payerId: null }), [tx({ payerId: 'm1' })])?.id).toBe('t1');
  });

  it('returns null when the queue item has no amount or date', () => {
    expect(findMatchingTransaction(queueItem({ amountCents: null }), [tx()])).toBeNull();
    expect(findMatchingTransaction(queueItem({ date: null }), [tx()])).toBeNull();
  });
});
