interface Filterable {
  date: string | null;
  category: string | null;
  payerId: string | null;
  cardId: string | null;
}

// Values the rows actually contain, so a filter never offers a choice that matches nothing.
export function presentFilterValues(rows: Filterable[]) {
  const pick = (key: 'category' | 'payerId' | 'cardId') =>
    new Set(rows.map((row) => row[key]).filter((v): v is string => !!v));
  const dates = rows.map((row) => row.date).filter((d): d is string => !!d).sort();
  return {
    categories: pick('category'),
    payerIds: pick('payerId'),
    cardIds: pick('cardId'),
    minDate: dates[0] as string | undefined,
    maxDate: dates[dates.length - 1] as string | undefined,
  };
}

// Empty means the filter was cleared, which is always allowed.
export const isDateInRange = (date: string, min?: string, max?: string) =>
  !date || ((!min || date >= min) && (!max || date <= max));

export const dateOutOfRangeMessage = (min?: string, max?: string) =>
  `No expenses on that date. Choose a date from ${min} to ${max}.`;
