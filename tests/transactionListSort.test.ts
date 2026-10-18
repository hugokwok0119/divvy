import { describe, it, expect } from 'vitest';
import { sortAriaValue } from '../src/components/TransactionList';

describe('sortAriaValue', () => {
  it('is none for a column that is not the active sort key', () => {
    expect(sortAriaValue('date', 'asc', 'store')).toBe('none');
  });

  it('is ascending for the active column when sorted ascending', () => {
    expect(sortAriaValue('amount', 'asc', 'amount')).toBe('ascending');
  });

  it('is descending for the active column when sorted descending', () => {
    expect(sortAriaValue('amount', 'desc', 'amount')).toBe('descending');
  });
});
