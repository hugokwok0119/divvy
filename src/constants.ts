export const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

export const CATEGORIES = [
  'Groceries',
  'Dining',
  'Utilities',
  'Rent',
  'Entertainment',
  'Transport',
  'Shopping',
  'Travel',
  'Health',
  'Education',
  'Personal Care',
  'Services',
  'Subscriptions',
  'Other'
];

const CATEGORY_ALIASES: Record<string, string> = {
  'Software & Subscriptions': 'Subscriptions',
};

/** Compatibility layer for data written before the shorter label shipped. */
export function canonicalCategory(category: string): string {
  return CATEGORY_ALIASES[category] ?? category;
}

/** Built-ins first, then unique household categories that are not aliases of a built-in. */
export function categoryOptions(customCategories: readonly string[] = []): string[] {
  return [...new Set([...CATEGORIES, ...customCategories.map(canonicalCategory)])];
}
