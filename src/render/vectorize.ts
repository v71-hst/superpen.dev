// Traces a raster image into SVG paths locally (imagetracerjs), for converting to editable vector nodes.
import ImageTracer from 'imagetracerjs';

export type VectorizeOptions = {
  /** Number of colors in the traced result (2 = black & white logo). */
  colors?: number;
  /** 0 = smooth/simple … 1 = detailed. */
  detail?: number;
};

export async function vectorizeImage(url: string, opts: VectorizeOptions = {}): Promise<{ svg: string; width: number; height: number }> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  // Trace at a bounded resolution: bigger inputs are slow and produce no better paths.
  const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h);
  const detail = Math.max(0, Math.min(1, opts.detail ?? 0.5));
  const svg: string = ImageTracer.imagedataToSVG(data, {
    numberofcolors: Math.max(2, Math.min(64, Math.round(opts.colors ?? 8))),
    ltres: 1.5 - detail * 1.2,
    qtres: 1.5 - detail * 1.2,
    pathomit: Math.round(16 - detail * 14),
    blurradius: detail < 0.3 ? 2 : 0,
    roundcoords: 2,
    colorquantcycles: 3,
    strokewidth: 0,
    linefilter: detail < 0.5,
    viewbox: true,
  });
  // Drop fully transparent layers the tracer emits for the background.
  const cleaned = svg.replace(/<path[^>]*opacity="0"[^>]*\/>/g, '');
  return { svg: cleaned, width: img.naturalWidth, height: img.naturalHeight };
}
