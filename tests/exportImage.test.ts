import { describe, expect, it } from 'vitest';
import { safePixelRatio } from '../src/lib/exportImage';

describe('safePixelRatio', () => {
  it('keeps 2x for normal images', () => {
    expect(safePixelRatio(1342, 1000)).toBe(2);
    expect(safePixelRatio(400, 600)).toBe(2);
  });
  it('lowers the ratio so very long cycles stay under the canvas area limit', () => {
    const r = safePixelRatio(1342, 10_400);
    expect(r).toBeLessThanOrEqual(2);
    expect(1342 * 10_400 * r * r).toBeLessThanOrEqual(16_777_216);
    expect(safePixelRatio(1342, 20_000)).toBeCloseTo(0.79, 2);
  });
});
