import { canonicalCategory } from '../constants';

export function normalizeMerchantName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '' && !/^\d+$/.test(token))
    .join(' ');
}

interface PreferenceCandidate {
  category: string;
  rawKey: string;
  exact: boolean;
  meaningful: boolean;
  score: number;
  keyLength: number;
}

function bestPreferenceCandidate(
  store: string,
  preferences: Record<string, string>,
): PreferenceCandidate | null {
  const normalizedStore = normalizeMerchantName(store);
  if (!normalizedStore) return null;

  let best: PreferenceCandidate | null = null;
  const wrappedStore = ` ${normalizedStore} `;

  for (const [rawKey, category] of Object.entries(preferences)) {
    const key = normalizeMerchantName(rawKey);
    if (!key) continue;
    const exact = key === normalizedStore;
    const score = Math.min(key.length, normalizedStore.length);
    if (!exact) {
      // Space padding makes this token-boundary containment, so `shell` does
      // not match `shellfish`. Four characters avoids unsafe tiny aliases.
      if (score < 4) continue;
      const wrappedKey = ` ${key} `;
      if (!wrappedStore.includes(wrappedKey) && !wrappedKey.includes(wrappedStore)) continue;
    }

    const resolvedCategory = canonicalCategory(category);
    const meaningful = resolvedCategory !== 'Other';
    if (!best
      || (meaningful && !best.meaningful)
      || (meaningful === best.meaningful && score > best.score)
      || (meaningful === best.meaningful && score === best.score && key.length > best.keyLength)) {
      best = { category: resolvedCategory, rawKey, exact, meaningful, score, keyLength: key.length };
    }
  }

  return best;
}

/** Explicit user preferences use exact normalized matching; fuzzy history never overrides AI. */
export function findExplicitCategoryPreference(
  store: string,
  preferences: Record<string, string>,
): string | null {
  const normalizedStore = normalizeMerchantName(store);
  if (!normalizedStore) return null;
  for (const [rawKey, category] of Object.entries(preferences)) {
    if (normalizeMerchantName(rawKey) === normalizedStore) return canonicalCategory(category);
  }
  return null;
}

export function findCategoryPreference(
  store: string,
  preferences: Record<string, string>,
): string | null {
  return bestPreferenceCandidate(store, preferences)?.category ?? null;
}

export interface CategoryMatch {
  category: string;
  /** The preference-map key (a historical or learned merchant name) that produced this match. */
  sourceMerchant: string;
  /** `exact` = normalized merchant names matched exactly. `partial` = token-boundary containment match. */
  confidence: 'exact' | 'partial';
}

/** Same matching as findCategoryPreference, plus the provenance needed to explain a suggestion to a user. */
export function matchCategoryPreference(
  store: string,
  preferences: Record<string, string>,
): CategoryMatch | null {
  const best = bestPreferenceCandidate(store, preferences);
  if (!best) return null;
  return { category: best.category, sourceMerchant: best.rawKey, confidence: best.exact ? 'exact' : 'partial' };
}

export interface CategorySuggestion {
  transactionId: string;
  store: string;
  suggestedCategory: string;
  sourceMerchant: string;
  confidence: 'exact' | 'partial';
}

/**
 * Suggestions for the "Suggest Categories" workflow (Phase 6): only rows
 * still categorized `Other` are candidates, and a match whose own category
 * is `Other` is not a useful suggestion, so both are skipped. Pure and
 * deterministic so it can run as a client-side preview with no server call.
 */
export function buildCategorySuggestions(
  transactions: Array<{ id: string; store: string; category: string }>,
  preferences: Record<string, string>,
): CategorySuggestion[] {
  const suggestions: CategorySuggestion[] = [];
  for (const tx of transactions) {
    if (tx.category !== 'Other') continue;
    const match = matchCategoryPreference(tx.store, preferences);
    if (!match || match.category === 'Other') continue;
    suggestions.push({
      transactionId: tx.id,
      store: tx.store,
      suggestedCategory: match.category,
      sourceMerchant: match.sourceMerchant,
      confidence: match.confidence,
    });
  }
  return suggestions;
}
