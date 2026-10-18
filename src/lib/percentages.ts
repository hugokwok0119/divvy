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
