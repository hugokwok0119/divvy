/**
 * Highest pixel ratio (up to `max`) that keeps the canvas under `maxArea` pixels.
 * 16,777,216 (4096²) is a conservative ceiling for mobile Safari's canvas area.
 */
export function safePixelRatio(width: number, height: number, max = 2, maxArea = 16_777_216): number {
  return Math.min(max, Math.sqrt(maxArea / (width * height)));
}

/** The `latin` @font-face blocks of a Google Fonts css2 response, and their distinct font URLs. */
export function latinFontFaces(css: string): { css: string; urls: string[] } {
  const blocks = css.split('/*').filter((b) => b.startsWith(' latin */')).map((b) => b.slice(' latin */'.length));
  const urls = [...new Set(blocks.flatMap((b) => [...b.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1])))];
  return { css: blocks.join('\n'), urls };
}

const toDataUrl = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

let interCss: Promise<string | undefined> | undefined;
/**
 * html-to-image cannot read the cross-origin Google Fonts stylesheet (SecurityError on
 * cssRules), so Inter is fetched and inlined here. Undefined means: fall back to system fonts.
 */
function interFontEmbedCss(): Promise<string | undefined> {
  interCss ??= (async () => {
    const href = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
      .map((link) => link.href).find((h) => h.includes('fonts.googleapis.com'));
    if (!href) return undefined;
    const { css, urls } = latinFontFaces(await (await fetch(href)).text());
    let inlined = css;
    for (const url of urls) inlined = inlined.replaceAll(url, await toDataUrl(url));
    return inlined;
  })().catch(() => undefined);
  return interCss;
}

/** Rasterizes `node` to a JPG and saves it as `fileName`. */
export async function downloadJpeg(node: HTMLElement, fileName: string): Promise<void> {
  await document.fonts.ready;
  const [{ toJpeg }, fontEmbedCSS] = await Promise.all([import('html-to-image'), interFontEmbedCss()]);
  const dataUrl = await toJpeg(node, {
    backgroundColor: '#ffffff',
    quality: 0.92,
    pixelRatio: safePixelRatio(node.scrollWidth, node.scrollHeight),
    ...(fontEmbedCSS ? { fontEmbedCSS } : { skipFonts: true }),
  });
  const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
