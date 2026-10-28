import React, { useEffect, useState } from 'react';
import { useStore } from './editor/store';
import { installShortcuts } from './editor/keys';
import { openDroppedFile, isDesignFile, openFromWorkspace, watchFile } from './editor/fileio';
import { zoomToFit } from './editor/ops';
import { Canvas } from './ui/Canvas';
import { LeftPanel } from './ui/LeftPanel';
import { RightPanel } from './ui/RightPanel';
import { FilePill, LockChip, PromptBar, SideToggle, Toast, Toolbar, ZoomControl } from './ui/Chrome';
import { Modals } from './ui/Modals';
import { Home } from './ui/Home';
import { Presenter } from './ui/Present';
import { isDirty } from './editor/store';
import { inVsCode, installVsCodeBridge, post } from './editor/host';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { installDiagnostics } from './editor/diagnostics';
import { resetLod } from './editor/lod';

function EditorCrashed({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="home">
      <div className="home-card">
        <h1>Something went wrong in the editor</h1>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error.message}</p>
        <p>The error was written to the Superpencil log. Your document is safe — nothing is lost.</p>
        <div className="home-actions">
          <button className="primary" onClick={reset}>
            Try again
          </button>
          <button onClick={() => (inVsCode ? post({ type: 'reload' }) : location.reload())}>Reload editor</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const doc = useStore(s => s.doc);
  const file = useStore(s => s.file);
  const leftOpen = useStore(s => s.leftOpen);
  const uiTheme = useStore(s => s.uiTheme);
  const loadError = useStore(s => (s as any).loadError as string | undefined);
  const [dragging, setDragging] = useState(false);

  useEffect(() => installShortcuts(), []);
  useEffect(() => installVsCodeBridge(), []);
  useEffect(() => installDiagnostics(), []);

  useEffect(() => {
    document.documentElement.className = uiTheme;
  }, [uiTheme]);

  // Open ?file=… on startup.
  useEffect(() => {
    const f = new URLSearchParams(location.search).get('file');
    if (f) openFromWorkspace(f).catch(err => useStore.getState().notify(String(err)));
  }, []);

  // Fit the document whenever a new file is opened.
  useEffect(() => {
    resetLod();
    if (!doc) return;
    // Skip the initial fit if the user already started panning/zooming.
    const before = useStore.getState().view;
    requestAnimationFrame(() => requestAnimationFrame(() => useStore.getState().view === before && zoomToFit()));
  }, [file?.name, file?.path]);

  useEffect(() => {
    document.title = file ? `${isDirty(useStore.getState()) ? '● ' : ''}${file.name} — pen editor` : 'pen editor';
  });

  useEffect(() => {
    if (!file?.path) return;
    return watchFile(file.path);
  }, [file?.path]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (isDirty(useStore.getState())) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    const f = [...e.dataTransfer.files].find(x => isDesignFile(x.name));
    if (!f) return;
    e.preventDefault();
    openDroppedFile(f).catch(err => useStore.getState().notify(String(err)));
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0 }}
      onDragOver={e => {
        if ([...e.dataTransfer.items].some(i => i.kind === 'file')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={e => e.relatedTarget === null && setDragging(false)}
      onDrop={onDrop}
    >
      {doc ? (
        <ErrorBoundary name="editor" fallback={(e, reset) => <EditorCrashed error={e} reset={reset} />}>
          {/* Each part is isolated: a failure in one panel never takes the canvas or the toolbar with it. */}
          <ErrorBoundary name="canvas" resetKey={doc} fallback={(e, reset) => <EditorCrashed error={e} reset={reset} />}>
            <Canvas />
          </ErrorBoundary>
          <ErrorBoundary name="left panel" resetKey={doc}>
            {leftOpen && <LeftPanel />}
            {leftOpen && <PromptBar />}
          </ErrorBoundary>
          <ErrorBoundary name="toolbar">
            <SideToggle />
            <Toolbar />
          </ErrorBoundary>
          <ErrorBoundary name="chrome" resetKey={doc}>
            <FilePill />
            <LockChip />
            <ZoomControl />
          </ErrorBoundary>
          <ErrorBoundary name="design panel" resetKey={doc}>
            <RightPanel />
          </ErrorBoundary>
        </ErrorBoundary>
      ) : inVsCode ? (
        <div className="home" style={{ color: 'var(--muted)', fontSize: 13 }}>
          {loadError ?? 'Loading…'}
        </div>
      ) : (
        <Home />
      )}
      <Modals />
      <Presenter />
      <Toast />
      {dragging && <div className="drop-hint">Drop a .spen or .pen file to open it</div>}
    </div>
  );
}
