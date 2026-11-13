// Waiting for the browser to lay out and paint.

/**
 * Resolves after `n` animation frames. A tab in the background gets no animation frames at all, which used to leave
 * screenshots of a design in a background tab hanging until the tab was shown; there a short timer stands in.
 */
export function nextFrames(n = 2): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, document.hidden ? 50 : 1500);
    const step = (k: number) => (k <= 0 ? finish() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
}
