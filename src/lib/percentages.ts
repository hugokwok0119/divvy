import type { SplitRule } from './settlement';

export function parsePercentageDraft(input: string): number {
  const text = input.trim();
  const value = Number(text);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
    || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError('Enter a percentage from 0 to 100.');
  }
  return value;
}

export function customPercentagesError(percentages: Record<string, number>): string | null {
  const values = Object.values(percentages);
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
    return 'Enter a percentage from 0 to 100 for each member.';
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  // Permit accumulation error only; percentage inputs are never rounded.
  const tolerance = Number.EPSILON * 100 * Math.max(1, values.length);
  return Math.abs(total - 100) <= tolerance ? null : 'Custom percentages must total 100%.';
}

export function sameSplitRule(left: SplitRule | null, right: SplitRule | null): boolean {
  if (!left || !right) return left === right;
  if (left.memberId !== right.memberId) return false;
  const a = left.percentages;
  const b = right.percentages;
  if (!a || !b) return a === b;
  return Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([id, value]) => Object.hasOwn(b, id) && b[id] === value);
}

export function canNormalizePercentages(percentages: Record<string, number>): boolean {
  const values = Object.values(percentages);
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0)
    && Number.isFinite(total) && total > 0;
}

/**
 * Pre-tax item amounts act as weights: the bill total, including tax and tip,
 * is split in the same proportion. Blank entries count as zero.
 */
export function amountWeightsError(cents: Record<string, number>): string | null {
  const values = Object.values(cents);
  if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    return 'Enter an amount of zero or more for each member.';
  }
  return values.some(value => value > 0) ? null : 'Enter at least one amount above zero.';
}

export function percentagesFromAmounts(cents: Record<string, number>): Record<string, number> {
  const ids = Object.keys(cents);
  const total = ids.reduce((sum, id) => sum + cents[id], 0);
  const out = Object.fromEntries(ids.map(id => [id, (cents[id] * 100) / total]));
  // Give float drift to the largest weight so the total stays at exactly 100.
  const largest = ids.reduce((best, id) => (cents[id] > cents[best] ? id : best));
  out[largest] = 100 - ids.reduce((sum, id) => (id === largest ? sum : sum + out[id]), 0);
  return out;
}

/** Display only: splits saved from amounts carry long fractions. */
export function formatPercentage(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}
