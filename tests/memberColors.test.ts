import { describe, expect, it } from 'vitest';
import { MEMBER_COLORS, memberColorAt } from '../src/lib/memberColors';

describe('member colors', () => {
  it('has 20 distinct colors', () => {
    expect(MEMBER_COLORS).toHaveLength(20);
    expect(new Set(MEMBER_COLORS).size).toBe(20);
  });

  it('keeps the original five so existing members keep their colors', () => {
    expect(MEMBER_COLORS.slice(0, 5)).toEqual(['#f59e0b', '#3b82f6', '#ec4899', '#84cc16', '#8b5cf6']);
  });

  it('gives members six to twenty their own color and wraps after twenty', () => {
    expect(memberColorAt(5)).toBe('#059669');
    expect(memberColorAt(19)).toBe('#9d174d');
    expect(memberColorAt(20)).toBe(memberColorAt(0));
  });
});
