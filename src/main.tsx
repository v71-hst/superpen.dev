import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if (import.meta.env.DEV) {
  (window as any).__penStore = (await import('./editor/store')).useStore;
  (window as any).__penAgent = (await import('./editor/agent')).handleAgentRequest;
  (window as any).__penRaster = await import('./render/rasterize');
  (window as any).__penSvg = await import('./model/svgImport');
}

createRoot(document.getElementById('root')!).render(<App />);
