import { statementDateFor } from './money';

export interface Reminder {
  /** Completion identity: `card:<cardId>` or `rent`. Never the day, so statement-day edits keep ticks. */
  id: string;
  cardId: string | null;
  label: string;
  date: string;
}

/** A month's statement reminders for active cards with a day, then the month-end rent reminder. */
export function monthReminders(
  year: number, month: number,
  cards: Array<{ id: string; name: string; statementDay: number | null; archived: number }>,
): Reminder[] {
  return [
    ...cards.filter((c) => !c.archived && c.statementDay != null).map((c) => ({
      id: `card:${c.id}`, cardId: c.id, label: `${c.name} statement`, date: statementDateFor(year, month, c.statementDay!),
    })),
    { id: 'rent', cardId: null, label: 'Rent', date: statementDateFor(year, month, 31) },
  ];
}

/** Today's YYYY-MM-DD in the household timezone, or the browser's local date if that zone is invalid. */
export function todayIn(timeZone: string, now = new Date()): string {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  try {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', options).format(now);
  }
}
