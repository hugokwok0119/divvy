import { describe, expect, it } from 'vitest';
import { customPercentagesError, parsePercentageDraft } from '../src/lib/percentages';

describe('percentage completion', () => {
  it.each(['', ' ', '-', '.', '1e', 'Infinity', 'NaN', '0x64', 'abc', '1.2.3', '-1', '101'])('rejects invalid completed draft %j', value => {
    expect(() => parsePercentageDraft(value)).toThrow(RangeError);
  });
  it.each([['0', 0], ['80', 80], ['.5', 0.5], ['50.', 50], ['1e-7', 0.0000001], ['12.3456789012345', 12.3456789012345]] as const)('retains supported precision for %s', (text, expected) => {
    expect(parsePercentageDraft(text)).toBe(expected);
  });
  it.each([99, 101, 99.9995, 99.9999999999])('rejects total %s instead of applying a business tolerance', total => {
    expect(customPercentagesError({ m1: total, m2: 0 })).not.toBeNull();
  });
  it('allows representation error in three equal percentages', () => {
    expect(customPercentagesError({ m1: 100 / 3, m2: 100 / 3, m3: 100 / 3 })).toBeNull();
  });
  it('retains zero-percent participants and decimal precision', () => {
    expect(customPercentagesError({ m1: 0, m2: 100 })).toBeNull();
    expect(customPercentagesError({ m1: 12.3456789012345, m2: 87.6543210987655 })).toBeNull();
  });
  it.each([NaN, Infinity, -1, 101])('rejects invalid percentage %s', value => {
    expect(customPercentagesError({ m1: value, m2: 100 })).not.toBeNull();
  });
  it('rejects empty allocations', () => {
    expect(customPercentagesError({})).not.toBeNull();
  });
});
