/**
 * Highest pixel ratio (up to `max`) that keeps the canvas under `maxArea` pixels.
 * 16,777,216 (4096²) is a conservative ceiling for mobile Safari's canvas area.
 */
export function safePixelRatio(width: number, height: number, max = 2, maxArea = 16_777_216): number {
  return Math.min(max, Math.sqrt(maxArea / (width * height)));
}

/** Rasterizes `node` to a JPG and saves it as `fileName`. */
export async function downloadJpeg(node: HTMLElement, fileName: string): Promise<void> {
  await document.fonts.ready;
  const { toJpeg } = await import('html-to-image');
  const dataUrl = await toJpeg(node, {
    backgroundColor: '#ffffff',
    quality: 0.92,
    pixelRatio: safePixelRatio(node.scrollWidth, node.scrollHeight),
  });
  const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
