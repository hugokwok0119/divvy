import { describe, it, expect } from 'vitest';
import { monthReminders, todayIn } from '../src/lib/reminders';
import { distinctColors } from '../src/components/ledger';

const card = (id: string, name: string, statementDay: number | null, archived = 0) => ({ id, name, statementDay, archived });

describe('monthReminders', () => {
  it('leaves out rent when the group turns it off', () => {
    expect(monthReminders(2026, 10, [], false).map((r) => r.id)).toEqual([]);
  });

  it('gives each card on a shared day its own reminder, plus month-end rent', () => {
    const reminders = monthReminders(2026, 10, [card('c1', 'Amex', 15), card('c2', 'Visa', 15)]);
    expect(reminders).toEqual([
      { id: 'card:c1', cardId: 'c1', label: 'Amex statement', date: '2026-10-15' },
      { id: 'card:c2', cardId: 'c2', label: 'Visa statement', date: '2026-10-15' },
      { id: 'rent', cardId: null, label: 'Rent', date: '2026-10-31' },
    ]);
  });

  it('clamps day 31 to short months and leap years, landing on the same date as rent', () => {
    const dates = (year: number, month: number) =>
      monthReminders(year, month, [card('c1', 'Amex', 31)]).map((r) => `${r.id} ${r.date}`);
    expect(dates(2027, 2)).toEqual(['card:c1 2027-02-28', 'rent 2027-02-28']);
    expect(dates(2028, 2)).toEqual(['card:c1 2028-02-29', 'rent 2028-02-29']);
    expect(dates(2026, 4)).toEqual(['card:c1 2026-04-30', 'rent 2026-04-30']);
    expect(dates(2026, 12)).toEqual(['card:c1 2026-12-31', 'rent 2026-12-31']);
    expect(dates(2027, 1)).toEqual(['card:c1 2027-01-31', 'rent 2027-01-31']);
  });

  it('skips archived cards and cards without a statement day; identity is the card id, not its name', () => {
    const reminders = monthReminders(2026, 10, [card('c1', 'Renamed', 3), card('c2', 'Old', 4, 1), card('c3', 'None', null)]);
    expect(reminders.map((r) => r.id)).toEqual(['card:c1', 'rent']);
    expect(reminders[0].label).toBe('Renamed statement');
  });
});

describe('todayIn', () => {
  it('reads the calendar date in the household timezone', () => {
    const instant = new Date('2026-10-31T23:30:00Z');
    expect(todayIn('America/Vancouver', instant)).toBe('2026-10-31');
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-11-01');
  });

  it('falls back to the browser local date for an invalid stored timezone', () => {
    const instant = new Date(2026, 9, 31, 12);
    expect(todayIn('Not/AZone', instant)).toBe('2026-10-31');
  });
});

describe('distinctColors', () => {
  it('keeps the ledger card color and moves a colliding card to an unused color', () => {
    // 'a' and 'k' hash to the same palette slot.
    const colors = distinctColors(['a', 'k']);
    expect(colors.a).toBe('#8b5cf6');
    expect(colors.k).not.toBe(colors.a);
  });
});
