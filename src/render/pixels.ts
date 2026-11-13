// Canvases that are drawn once and read straight back (snapshots, scaled copies of pictures).

/**
 * Context options for such canvases: kept on the CPU. A GPU-backed canvas loses its contents when the graphics
 * process restarts or runs out of memory, and what is read back from it then is silently blank; a snapshot made at
 * that moment stays an invisible frame until it happens to be remade.
 */
export const SOFT: CanvasRenderingContext2DSettings = { willReadFrequently: true };

let probe: OffscreenCanvas | null = null;

/** True when the image has no visible pixel at all (checked on a 16×16 reduction). */
export function isBlank(src: CanvasImageSource): boolean {
  probe ??= new OffscreenCanvas(16, 16);
  const g = probe.getContext('2d', SOFT) as OffscreenCanvasRenderingContext2D;
  g.clearRect(0, 0, 16, 16);
  try {
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, 16, 16);
  } catch {
    return true;
  }
  const d = g.getImageData(0, 0, 16, 16).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}
