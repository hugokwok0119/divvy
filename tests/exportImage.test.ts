import { afterEach, describe, expect, it, vi } from 'vitest';
import { interFontEmbedCss, safePixelRatio } from '../src/lib/exportImage';

describe('interFontEmbedCss', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back on failure, retries, and caches only the success', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:font/woff2;base64,AAAA';
      onload = () => {};
      readAsDataURL() { this.onload(); }
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response(new Blob(['font'])));
    vi.stubGlobal('fetch', fetchMock);

    expect(await interFontEmbedCss()).toBeUndefined();
    const css = await interFontEmbedCss();
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain('font-weight: 300 700');
    expect(css).toContain('url(data:font/woff2;base64,AAAA)');
    expect(await interFontEmbedCss()).toBe(css);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/fonts/inter-latin-wght.woff2');
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
