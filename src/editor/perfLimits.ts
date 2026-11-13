// What performance mode lowers (see perf.ts). Kept apart from perf.ts so render modules can read the limits without
// importing the modules that perf.ts resets.
import { useStore } from './store';

export type PerfLimits = {
  /** Longest side of a zoomed-out snapshot, in pixels. */
  bitmapSide: number;
  /** Snapshots are made for at most this many device pixels per CSS pixel. */
  bitmapDpr: number;
  shaderFrameMs: number;
  shaderMaxScale: number;
  shaderMaxPixels: number;
};
const NORMAL: PerfLimits = { bitmapSide: 2048, bitmapDpr: 4, shaderFrameMs: 1000 / 30, shaderMaxScale: 2, shaderMaxPixels: 420_000 };
const LOW: PerfLimits = { bitmapSide: 1024, bitmapDpr: 1, shaderFrameMs: 1000 / 12, shaderMaxScale: 1, shaderMaxPixels: 160_000 };

export function perfLimits(): PerfLimits {
  return useStore.getState().perfMode ? LOW : NORMAL;
}
