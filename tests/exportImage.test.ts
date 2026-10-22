import { describe, expect, it } from 'vitest';
import { latinFontFaces, safePixelRatio } from '../src/lib/exportImage';

describe('latinFontFaces', () => {
  // Shape of the Google Fonts css2 response: one commented block per subset and weight.
  const css = [
    '/* cyrillic */\n@font-face { font-family: \'Inter\'; font-weight: 400; src: url(https://f/cyr.woff2) format(\'woff2\'); }',
    '/* latin-ext */\n@font-face { font-family: \'Inter\'; font-weight: 400; src: url(https://f/ext.woff2) format(\'woff2\'); }',
    '/* latin */\n@font-face { font-family: \'Inter\'; font-weight: 400; src: url(https://f/lat.woff2) format(\'woff2\'); }',
    '/* latin */\n@font-face { font-family: \'Inter\'; font-weight: 600; src: url(https://f/lat.woff2) format(\'woff2\'); }',
  ].join('\n');

  it('keeps only the latin blocks and lists their font files once', () => {
    const { css: kept, urls } = latinFontFaces(css);
    expect(urls).toEqual(['https://f/lat.woff2']);
    expect(kept).not.toContain('cyr.woff2');
    expect(kept).not.toContain('ext.woff2');
    expect(kept.match(/@font-face/g)).toHaveLength(2);
  });
});

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
