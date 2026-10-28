// Review mode: agent edits are applied (so the user sees them) but held as one pending change set that the user
// accepts or rejects. Rejecting restores the document as it was before the first pending agent edit.
import { useStore } from './store';
import { flushEdits } from './host';

let agentWriting = false;
let restoring = false;

export function setReviewMode(on: boolean) {
  try {
    localStorage.setItem('pen.reviewMode', on ? '1' : '0');
  } catch {
    /* storage unavailable: the setting just isn't remembered */
  }
  useStore.setState({ reviewMode: on });
  useStore.getState().notify(on ? 'Review mode on: AI edits wait for your approval' : 'Review mode off: AI edits apply immediately');
}

/** Runs an agent write; in review mode the change joins the pending change set. */
export function agentEdit<T>(label: string, fn: () => T, touched: (r: T) => string[]): T {
  const before = useStore.getState().doc;
  agentWriting = true;
  let r: T;
  try {
    r = fn();
  } finally {
    agentWriting = false;
  }
  recordAgentChange(before, label, () => touched(r));
  return r;
}

/** For async agent writes: call with the document from before the write once it has finished. */
export function recordAgentChange(before: ReturnType<typeof useStore.getState>['doc'], label: string, touched: () => string[]) {
  const s = useStore.getState();
  if (s.reviewMode && before && s.doc !== before) {
    watchOtherEdits();
    const keys = touched();
    const p = s.pending;
    useStore.setState({
      pending: p
        ? { ...p, touched: [...new Set([...p.touched, ...keys])], batches: p.batches + 1, label }
        : { base: before, touched: keys, batches: 1, label, since: Date.now(), mixed: false },
    });
  }
}

export function acceptPending() {
  useStore.setState({ pending: null });
}

export function rejectPending() {
  const { pending, doc, past } = useStore.getState();
  if (!pending || !doc) return;
  restoring = true;
  useStore.setState({ doc: pending.base, past: [...past.slice(-199), doc], future: [], pending: null, stateView: null });
  restoring = false;
  flushEdits();
}

/** Summary for agents (included in their tool results). */
export function reviewStatus() {
  const { reviewMode, pending } = useStore.getState();
  if (!reviewMode) return null;
  return pending
    ? `Review mode is ON: your changes (${pending.batches} batch${pending.batches > 1 ? 'es' : ''}, ${pending.touched.length} node(s)) are visible but pending until the user accepts or rejects them.`
    : 'Review mode is ON: your changes will be shown to the user for approval.';
}

// Notices other edits made while changes are pending. Subscribed lazily: this module is reached through an import
// cycle (store -> diagnostics -> host -> agent -> review) before the store exists.
let watching = false;
function watchOtherEdits() {
  if (watching) return;
  watching = true;
  useStore.subscribe((s, prev) => {
    if (s.doc !== prev.doc && s.pending && s.pending === prev.pending && !agentWriting && !restoring && !s.pending.mixed) useStore.setState({ pending: { ...s.pending, mixed: true } });
  });
}
