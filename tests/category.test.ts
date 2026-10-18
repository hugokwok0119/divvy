import { describe, expect, it } from 'vitest';
import {
  findCategoryPreference, findExplicitCategoryPreference, normalizeMerchantName,
  matchCategoryPreference, buildCategorySuggestions,
} from '../src/lib/category';
import { canonicalCategory, categoryOptions } from '../src/constants';

describe('normalizeMerchantName', () => {
  it('removes statement punctuation and standalone terminal numbers', () => {
    expect(normalizeMerchantName("Church’s Chicken #123 Vancouver BC"))
      .toBe('churchs chicken vancouver bc');
  });
});

describe('findCategoryPreference', () => {
  it('matches a historical merchant inside a longer statement descriptor', () => {
    expect(findCategoryPreference('TIM HORTONS #123 VANCOUVER BC', {
      'tim hortons': 'Dining',
    })).toBe('Dining');
  });

  it('uses the longest merchant match when names overlap', () => {
    expect(findCategoryPreference('UBER EATS VANCOUVER', {
      uber: 'Transport',
      'uber eats': 'Dining',
    })).toBe('Dining');
  });

  it('prefers a meaningful historical category over a generic Other match', () => {
    expect(findCategoryPreference('QUILLFERN MARKET #0042 DEMO CITY', {
      'quillfern market #0042 demo city': 'Other',
      'quillfern market': 'Groceries',
    })).toBe('Groceries');
  });

  it('does not match partial words', () => {
    expect(findCategoryPreference('Shellfish Cafe', { shell: 'Transport' })).toBeNull();
  });

  it('leaves unknown merchants uncategorized', () => {
    expect(findCategoryPreference('New Merchant', { walmart: 'Groceries' })).toBeNull();
  });
});

describe('findExplicitCategoryPreference', () => {
  it('matches an explicitly saved merchant after normalization', () => {
    expect(findExplicitCategoryPreference('Quillfern Market #0042', {
      'quillfern market #0042': 'Groceries',
    })).toBe('Groceries');
  });

  it('does not let a fuzzy merchant match override Gemini', () => {
    expect(findExplicitCategoryPreference('TIM HORTONS VANCOUVER', {
      'tim hortons': 'Dining',
    })).toBeNull();
  });

  it('canonicalizes legacy saved categories', () => {
    expect(findExplicitCategoryPreference('Adobe', {
      adobe: 'Software & Subscriptions',
    })).toBe('Subscriptions');
  });
});

describe('category compatibility', () => {
  it('maps the old long label to Subscriptions', () => {
    expect(canonicalCategory('Software & Subscriptions')).toBe('Subscriptions');
  });

  it('does not duplicate a legacy alias from custom categories', () => {
    expect(categoryOptions(['Software & Subscriptions']).filter((c) => c === 'Subscriptions'))
      .toHaveLength(1);
  });
});

describe('matchCategoryPreference', () => {
  it('reports an exact normalized match with its source merchant', () => {
    expect(matchCategoryPreference('Tim Hortons', { 'tim hortons': 'Dining' })).toEqual({
      category: 'Dining',
      sourceMerchant: 'tim hortons',
      confidence: 'exact',
    });
  });

  it('reports a token-boundary match as partial with its source merchant', () => {
    expect(matchCategoryPreference('TIM HORTONS #123 VANCOUVER BC', { 'tim hortons': 'Dining' })).toEqual({
      category: 'Dining',
      sourceMerchant: 'tim hortons',
      confidence: 'partial',
    });
  });

  it('returns null when nothing matches', () => {
    expect(matchCategoryPreference('New Merchant', { walmart: 'Groceries' })).toBeNull();
  });
});

describe('buildCategorySuggestions', () => {
  const preferences = { 'tim hortons': 'Dining', walmart: 'Groceries' };

  it('suggests an exact match for an Other transaction', () => {
    const result = buildCategorySuggestions(
      [{ id: 't1', store: 'Tim Hortons', category: 'Other' }],
      preferences,
    );
    expect(result).toEqual([{
      transactionId: 't1', store: 'Tim Hortons', suggestedCategory: 'Dining',
      sourceMerchant: 'tim hortons', confidence: 'exact',
    }]);
  });

  it('suggests a partial match for an Other transaction with confidence partial', () => {
    const result = buildCategorySuggestions(
      [{ id: 't2', store: 'WALMART SUPERCENTER #4521', category: 'Other' }],
      preferences,
    );
    expect(result).toEqual([{
      transactionId: 't2', store: 'WALMART SUPERCENTER #4521', suggestedCategory: 'Groceries',
      sourceMerchant: 'walmart', confidence: 'partial',
    }]);
  });

  it('never suggests a change for a transaction not categorized Other', () => {
    const result = buildCategorySuggestions(
      [{ id: 't3', store: 'Tim Hortons', category: 'Dining' }],
      preferences,
    );
    expect(result).toEqual([]);
  });

  it('produces no suggestion when no preference matches', () => {
    const result = buildCategorySuggestions(
      [{ id: 't4', store: 'Unknown Merchant Inc', category: 'Other' }],
      preferences,
    );
    expect(result).toEqual([]);
  });

  it('does not suggest Other as a category even if that is the best historical match', () => {
    const result = buildCategorySuggestions(
      [{ id: 't5', store: 'Weird Shop', category: 'Other' }],
      { 'weird shop': 'Other' },
    );
    expect(result).toEqual([]);
  });
});
