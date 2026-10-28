// Start screen: lists .pen files in the workspace folder, recent files, and open/new actions.
import React, { useEffect, useState } from 'react';
import { FilePlus, FolderOpen, PenLine, File } from 'lucide-react';
import { useStore } from '../editor/store';
import { newDocument, withDesignExt, openFromWorkspace, openLocalFile, recentFiles, workspaceInfo } from '../editor/fileio';

export function Home() {
  const [info, setInfo] = useState<{ workspace: string; files: string[] } | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    workspaceInfo().then(setInfo);
  }, []);
  const open = (p: string) => openFromWorkspace(p).catch(e => setError(String(e)));
  const recent = recentFiles().filter(p => info?.files.includes(p));
  const createNew = async () => {
    if (info) {
      const name = prompt('New file name (relative to the workspace folder):', 'untitled.spen');
      if (!name) return;
      const path = withDesignExt(name);
      if (info.files.includes(path) && !confirm(`${path} already exists. Open it instead?`)) return;
      if (!info.files.includes(path)) await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify(newDocument(), null, 2) });
      return open(path);
    }
    useStore.getState().openDoc(newDocument(), { name: 'untitled.spen', path: null });
  };
  return (
    <div className="home">
      <div className="home-card">
        <h1>
          <PenLine size={20} /> pen editor
        </h1>
        <p>{info ? `Workspace: ${info.workspace}` : info === null ? 'Running without the local file server — open files from disk.' : 'Loading…'}</p>
        <div className="home-actions">
          <button className="primary" onClick={() => openLocalFile().catch(e => e?.name !== 'AbortError' && setError(String(e)))}>
            <FolderOpen /> Open file…
          </button>
          <button onClick={createNew}>
            <FilePlus /> New file
          </button>
        </div>
        {error && <p style={{ color: '#f87171' }}>{error}</p>}
        <div className="home-list">
          {recent.length > 0 && <div className="h">Recent</div>}
          {recent.map(p => (
            <FileRow key={'r' + p} path={p} onOpen={open} />
          ))}
          {info && info.files.length > 0 && <div className="h">Designs in workspace</div>}
          {info?.files.map(p => <FileRow key={p} path={p} onOpen={open} />)}
          {info && !info.files.length && <p>No .spen or .pen files found in this folder. Drop a file here or use Open file…</p>}
        </div>
      </div>
    </div>
  );
}

function FileRow({ path, onOpen }: { path: string; onOpen: (p: string) => void }) {
  const i = path.lastIndexOf('/');
  return (
    <button className="home-file" onClick={() => onOpen(path)}>
      <File />
      {path.slice(i + 1)}
      <span className="dir">{i > 0 ? path.slice(0, i) : ''}</span>
    </button>
  );
}
