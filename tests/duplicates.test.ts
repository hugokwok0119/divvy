import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS, isDuplicateMatch } from '../src/lib/duplicates';

describe('isDuplicateMatch', () => {
  const base = { date: '2026-09-10', store: 'Quillfern Market', amountCents: 2565, payerId: 'mem_alex', cardId: 'card_demo_visa' };

  it('matches same amount and normalized merchant within 3 days', () => {
    expect(isDuplicateMatch(base, { ...base, date: '2026-09-13', store: 'QUILLFERN MARKET' })).toBe(true);
  });

  it('rejects different amount', () => {
    expect(isDuplicateMatch(base, { ...base, amountCents: 2566 })).toBe(false);
  });

  it('rejects missing amount or date', () => {
    expect(isDuplicateMatch(base, { ...base, amountCents: null })).toBe(false);
    expect(isDuplicateMatch(base, { ...base, date: null })).toBe(false);
  });

  it('rejects dates more than 3 days apart', () => {
    expect(isDuplicateMatch(base, { ...base, date: '2026-09-14' })).toBe(false);
  });

  it('rejects when both name different payers', () => {
    expect(isDuplicateMatch(base, { ...base, payerId: 'mem_sam' })).toBe(false);
  });

  it('ignores payer when one side has none', () => {
    expect(isDuplicateMatch(base, { ...base, payerId: null })).toBe(true);
  });

  it('rejects when both name different cards', () => {
    expect(isDuplicateMatch(base, { ...base, cardId: 'card_demo_mc' })).toBe(false);
  });

  it('window is three days', () => {
    expect(DUPLICATE_WINDOW_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });
});
