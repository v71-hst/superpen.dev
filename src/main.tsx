import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function boot() {
  // Test hooks for tests/; VITE_PEN_HOOKS is set by `PEN_PROD=1 node start.mjs`, never by the extension build.
  if (import.meta.env.DEV || import.meta.env.VITE_PEN_HOOKS) {
    (window as any).__penStore = (await import('./editor/store')).useStore;
    (window as any).__penAgent = (await import('./editor/agent')).handleAgentRequest;
    (window as any).__penExport = await import('./export/html');
    (window as any).__penSvg = await import('./model/svgImport');
    (window as any).__penSkia = { ...(await import('./skia/renderer')), ...(await import('./skia/SkiaLayer')), ...(await import('./skia/testing')), ...(await import('./skia/frames')) };
    // Lets a test drive the page from inside (tests/memory.mjs): an attached debugger distorts memory use.
    const harness = new URLSearchParams(location.search).get('penHarness');
    if (harness) void import(/* @vite-ignore */ harness);
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void boot();
