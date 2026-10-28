import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function boot() {
  // Test hooks for dev/harness; VITE_PEN_HOOKS is set by `PEN_PROD=1 node start.mjs`, never by the extension build.
  if (import.meta.env.DEV || import.meta.env.VITE_PEN_HOOKS) {
    (window as any).__penStore = (await import('./editor/store')).useStore;
    (window as any).__penAgent = (await import('./editor/agent')).handleAgentRequest;
    (window as any).__penRaster = await import('./render/rasterize');
    (window as any).__penSvg = await import('./model/svgImport');
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void boot();
