/**
 * Highest pixel ratio (up to `max`) that keeps the canvas under `maxArea` pixels.
 * 16,777,216 (4096²) is a conservative ceiling for mobile Safari's canvas area.
 */
export function safePixelRatio(width: number, height: number, max = 2, maxArea = 16_777_216): number {
  return Math.min(max, Math.sqrt(maxArea / (width * height)));
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

let interCss: string | undefined;
/**
 * html-to-image needs fonts inlined as data URLs, so the self-hosted Inter is fetched from the
 * same origin (allowed by connect-src 'self'). Undefined means: fall back to system fonts. Only a
 * success is cached, so a transient failure is retried on the next download.
 */
export async function interFontEmbedCss(): Promise<string | undefined> {
  if (interCss) return interCss;
  try {
    const font = await toDataUrl('/fonts/inter-latin-wght.woff2');
    return (interCss = `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 300 700; src: url(${font}) format('woff2'); }`);
  } catch {
    return undefined;
  }
}

/** Rasterizes `node` to a JPG and saves it as `fileName`. */
export async function downloadJpeg(node: HTMLElement, fileName: string): Promise<void> {
  await document.fonts.ready;
  const [{ toCanvas }, fontEmbedCSS] = await Promise.all([import('html-to-image'), interFontEmbedCss()]);
  const canvas = await toCanvas(node, {
    backgroundColor: '#ffffff',
    pixelRatio: safePixelRatio(node.scrollWidth, node.scrollHeight),
    ...(fontEmbedCSS ? { fontEmbedCSS } : { skipFonts: true }),
  });
  // canvas.toBlob, not fetch(dataUrl): the production CSP (connect-src 'self') blocks data: fetches.
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPG encoding failed'))), 'image/jpeg', 0.92));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
