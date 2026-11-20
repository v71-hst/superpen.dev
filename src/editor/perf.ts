// Performance mode: for machines with little memory or a weak GPU. It trades some sharpness and smoothness for a much
// smaller footprint: top-level frames away from the viewport are unloaded (shown as their snapshot or background),
// zoomed-out snapshots and pictures use half the resolution, shader animation runs slower and coarser, and a design
// whose tab is in the background lets go of its frames until the tab is shown again.
import { useStore } from './store';

const KEY = 'pen.perfMode';

/** Whether the user (or an earlier automatic choice) has set the mode on this machine. */
export function perfModeChosen() {
  return localStorage.getItem(KEY) !== null;
}

export function setPerfMode(on: boolean, remember = true) {
  if (remember) localStorage.setItem(KEY, on ? '1' : '0');
  if (useStore.getState().perfMode === on) return;
  // Skia reads its limits (perfLimits.ts) as it draws.
  useStore.setState({ perfMode: on, asleep: false });
}

/** On first use, machines with 16 GB of memory or less start in performance mode. Returns true if it was turned on. */
export function applyDefaultPerfMode(memoryGb: number | undefined): boolean {
  if (perfModeChosen() || !memoryGb) return false;
  const on = memoryGb <= 16.5;
  setPerfMode(on);
  return on;
}

let installed = false;
let sleepTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * A design whose tab is in the background lets go of its frames after a while (20 seconds in performance mode, five
 * minutes otherwise) and loads them again when shown: several open designs otherwise all hold their memory and GPU
 * resources at once. Toggles made in other tabs are followed.
 */
export function installPerf() {
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(sleepTimer);
    if (!document.hidden) {
      if (useStore.getState().asleep) useStore.setState({ asleep: false });
      return;
    }
    sleepTimer = setTimeout(
      () => {
        if (document.hidden) useStore.setState({ asleep: true });
      },
      useStore.getState().perfMode ? 20_000 : 300_000,
    );
  });
  window.addEventListener('storage', e => {
    if (e.key === KEY && e.newValue !== null) setPerfMode(e.newValue === '1', false);
  });
}
