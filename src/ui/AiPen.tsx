// AI Pen on the canvas: the prompt box that opens after dragging out an area, and placeholders while drawings render.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useStore, type AiPenBox } from '../editor/store';
import { drawWithAiPen, runAiPen } from '../editor/aipen';

function useScreenRect(box: AiPenBox) {
  const view = useStore(s => s.view);
  return { left: view.x + box.wx * view.zoom, top: view.y + box.wy * view.zoom, width: box.width * view.zoom, height: box.height * view.zoom };
}

function Placeholder({ box, prompt }: { box: AiPenBox; prompt: string }) {
  const r = useScreenRect(box);
  return (
    <div className="aipen-box" style={r}>
      <span>
        <Sparkles size={12} /> Drawing {prompt.length > 32 ? prompt.slice(0, 32) + '…' : prompt}
      </span>
    </div>
  );
}

function Prompt({ box }: { box: AiPenBox }) {
  const r = useScreenRect(box);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  const close = () => useStore.setState({ aiPenDraft: null });
  const submit = () => {
    const prompt = text.trim();
    if (!prompt) return;
    close();
    runAiPen(() => drawWithAiPen(prompt, box).then(({ id }) => useStore.getState().select([id])));
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

export function AiPenLayer() {
  const draft = useStore(s => s.aiPenDraft);
  const jobs = useStore(s => s.aiPenJobs);
  if (!draft && !jobs.length) return null;
  return (
    <div className="overlay aipen-layer">
      {jobs.map(j => (
        <Placeholder key={j.id} box={j.box} prompt={j.prompt} />
      ))}
      {draft && <Prompt box={draft} />}
    </div>
  );
}
