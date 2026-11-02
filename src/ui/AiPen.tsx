// AI Pen on the canvas: the prompt after dragging out an area, cards for requests waiting on the connected AI, and the
// replay of each drawing pass (strokes drawn one by one under an "AI Pen" cursor).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PenTool, Sparkles, X } from 'lucide-react';
import { useStore, type AiPenBox, type AiPenPass, type AiPenRequest } from '../editor/store';
import { cancelRequest, requestDrawing } from '../editor/aipen';
import { canvasRect, worldRectOf } from '../editor/ops';

function useScreenRect(box: AiPenBox) {
  const view = useStore(s => s.view);
  return { left: view.x + box.wx * view.zoom, top: view.y + box.wy * view.zoom, width: box.width * view.zoom, height: box.height * view.zoom };
}

function Prompt({ box }: { box: AiPenBox }) {
  const r = useScreenRect(box);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  const close = () => useStore.setState({ aiPenDraft: null });
  const submit = () => {
    if (!text.trim()) return;
    requestDrawing(text, box);
    close();
  };
  return (
    <>
      <div className="aipen-box draft" style={r} />
      <div className="island aipen-prompt" style={{ left: r.left, top: r.top + r.height + 8 }} onPointerDown={e => e.stopPropagation()}>
        <textarea
          ref={ref}
          value={text}
          rows={2}
          placeholder="Describe what to draw, e.g. heraldic lion with a crown, white line art"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') close();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="hint">Your connected AI chat (Claude Code, Codex…) draws it. If it's idle, tell it “draw my AI Pen requests”.</div>
        <div className="aipen-actions">
          <span className="hint">
            {Math.round(box.width)} × {Math.round(box.height)}
          </span>
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={!text.trim()} onClick={submit}>
            <Sparkles size={13} /> Draw
          </button>
        </div>
      </div>
    </>
  );
}

/** A request the AI hasn't started on yet: a dashed box (or outline of the frame to change) with the prompt. */
function Waiting({ req }: { req: AiPenRequest }) {
  const view = useStore(s => s.view);
  const fr = req.refine ? worldRectOf(req.refine) : null;
  const b = fr ? { wx: fr.x, wy: fr.y, width: fr.w, height: fr.h } : req.box;
  const r = { left: view.x + b.wx * view.zoom, top: view.y + b.wy * view.zoom, width: b.width * view.zoom, height: b.height * view.zoom };
  return (
    <div className={'aipen-box waiting' + (req.refine ? ' refine' : '')} style={r}>
      <span>
        <Sparkles size={12} /> {req.refine ? 'Change' : 'Waiting for your AI'}: {req.prompt.length > 40 ? req.prompt.slice(0, 40) + '…' : req.prompt}
        <button title="Cancel this request" onPointerDown={e => e.stopPropagation()} onClick={() => cancelRequest(req.id)}>
          <X size={11} />
        </button>
      </span>
    </div>
  );
}

const SHAPES = 'path, circle, ellipse, rect, line, polyline, polygon';
/** Total replay time for one pass is capped so big passes still finish quickly. */
const MAX_PASS_MS = 3500;

/** Replays one pass: each shape's outline is traced, then its fill fades in; the cursor rides the pen tip. */
function Replay({ pass, onTip, onDone }: { pass: AiPenPass; onTip: (p: { x: number; y: number } | null) => void; onDone: () => void }) {
  const view = useStore(s => s.view);
  const host = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useLayoutEffect(() => setRect(worldRectOf(pass.frame)), [pass.frame, view]);

  useEffect(() => {
    const div = host.current;
    if (!div || !rect) return;
    div.innerHTML = pass.markup;
    const svg = div.querySelector('svg');
    if (!svg) return onDone();
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const els = [...svg.querySelectorAll<SVGGeometryElement>(SHAPES)].filter(el => typeof el.getTotalLength === 'function');
    const items = els.map(el => {
      let len = 0;
      try {
        len = el.getTotalLength();
      } catch {
        len = 0;
      }
      const cs = getComputedStyle(el);
      const stroked = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
      const orig = { stroke: el.style.stroke, strokeWidth: el.style.strokeWidth, fillOpacity: el.style.fillOpacity };
      // Unstroked shapes are traced with a thin outline in their fill colour, then filled.
      if (!stroked) {
        el.style.stroke = cs.fill !== 'none' ? cs.fill : '#8b5cf6';
        el.style.strokeWidth = '1.5';
        el.setAttribute('vector-effect', 'non-scaling-stroke');
      }
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.style.fillOpacity = '0';
      return { el, len, stroked, orig, ms: Math.max(90, Math.min(650, len * 1.6)) };
    });
    const total = items.reduce((a, b) => a + b.ms, 0);
    const k = total > MAX_PASS_MS ? MAX_PASS_MS / total : 1;
    let i = 0;
    let start = performance.now();
    let raf = 0;
    const finish = (it: (typeof items)[number]) => {
      it.el.style.strokeDasharray = '';
      it.el.style.strokeDashoffset = '';
      it.el.style.transition = 'fill-opacity 160ms';
      it.el.style.fillOpacity = it.orig.fillOpacity;
      if (!it.stroked) {
        it.el.style.stroke = it.orig.stroke;
        it.el.style.strokeWidth = it.orig.strokeWidth;
        it.el.removeAttribute('vector-effect');
      }
    };
    const step = (now: number) => {
      const it = items[i];
      if (!it) {
        onTip(null);
        setTimeout(onDone, 180);
        return;
      }
      const t = Math.min(1, (now - start) / (it.ms * k));
      it.el.style.strokeDashoffset = `${it.len * (1 - t)}`;
      try {
        const pt = it.el.getPointAtLength(it.len * t);
        const m = it.el.getScreenCTM();
        const c = canvasRect();
        if (m) {
          const sp = new DOMPoint(pt.x, pt.y).matrixTransform(m);
          onTip({ x: sp.x - c.left, y: sp.y - c.top });
        }
      } catch {
        /* zero-length shape */
      }
      if (t >= 1) {
        finish(it);
        i++;
        start = now;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // The replay runs once per pass; view changes only move the host box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pass.id, !!rect]);

  if (!rect) return null;
  return <div ref={host} className="aipen-replay" style={{ left: view.x + rect.x * view.zoom, top: view.y + rect.y * view.zoom, width: rect.w * view.zoom, height: rect.h * view.zoom }} />;
}

/** The pen-tip cursor with its "AI Pen" tag; lingers a moment after the last stroke. */
function Cursor({ tip }: { tip: { x: number; y: number } }) {
  return (
    <div className="aipen-cursor" style={{ left: tip.x, top: tip.y }}>
      <PenTool size={18} />
      <span>AI Pen</span>
    </div>
  );
}

export function AiPenLayer() {
  const draft = useStore(s => s.aiPenDraft);
  const requests = useStore(s => s.aiPenRequests);
  const passes = useStore(s => s.aiPenPasses);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [lastTip, setLastTip] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (tip) setLastTip(tip);
  }, [tip]);
  useEffect(() => {
    if (tip || !lastTip) return;
    const t = setTimeout(() => setLastTip(null), 1500);
    return () => clearTimeout(t);
  }, [tip, lastTip]);

  const current = passes[0];
  const hidden = passes.flatMap(p => p.keys);
  const waiting = requests.filter(r => r.status === 'waiting');
  if (!draft && !waiting.length && !current && !lastTip) return null;
  return (
    <div className="overlay aipen-layer">
      {/* Shapes still waiting to be traced stay hidden so they appear as the pen reaches them. */}
      {hidden.length > 0 && <style>{hidden.map(k => `[data-k="${CSS.escape(k)}"]`).join(',') + '{visibility:hidden!important}'}</style>}
      {waiting.map(r => (
        <Waiting key={r.id} req={r} />
      ))}
      {current && <Replay key={current.id} pass={current} onTip={setTip} onDone={() => useStore.setState(s => ({ aiPenPasses: s.aiPenPasses.filter(p => p.id !== current.id) }))} />}
      {(tip ?? lastTip) && <Cursor tip={(tip ?? lastTip)!} />}
      {draft && <Prompt box={draft} />}
    </div>
  );
}
