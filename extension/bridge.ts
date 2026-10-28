// Per-window MCP bridge: a localhost RPC server that exposes this window's open .pen editors and manages edit locks.
import * as vscode from 'vscode';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export const PEN_HOME = path.join(os.homedir(), '.pen-editor');
export const BRIDGE_DIR = path.join(PEN_HOME, 'bridges');

/** How long a lock survives without heartbeats (the MCP process sends one every 15s). */
const LOCK_TTL_MS = 45_000;
/** A holder idle for longer than this can be taken over with a warning, without force. */
const TAKEOVER_IDLE_MS = 120_000;

type Session = { id: string; label: string };

type Lock = { session: string; label: string; since: number; lastActive: number; heartbeat: number };

type DocEntry = {
  document: vscode.TextDocument;
  panels: Set<vscode.WebviewPanel>;
  loaded: boolean;
};

export class Bridge {
  private docs = new Map<string, DocEntry>();
  private locks = new Map<string, Lock>();
  /** Why a session lost a lock, reported on its next write attempt. */
  private lostLocks = new Map<string, string>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private server?: http.Server;
  private token = crypto.randomBytes(24).toString('hex');
  private file = '';
  private lastFocused = Date.now();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly viewType: string) {}

  async start(context: vscode.ExtensionContext) {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', () => r()));
    const port = (this.server.address() as any).port;
    this.file = path.join(BRIDGE_DIR, `${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`);
    this.writeRegistry(port);
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState(s => {
        if (s.focused) {
          this.lastFocused = Date.now();
          this.writeRegistry(port);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.writeRegistry(port)),
      { dispose: () => this.stop() },
    );
    this.sweeper = setInterval(() => this.sweep(), 10_000);
  }

  private writeRegistry(port: number) {
    const info = {
      port,
      token: this.token,
      pid: process.pid,
      window: vscode.workspace.name ?? 'VS Code',
      folders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      lastFocused: this.lastFocused,
    };
    try {
      fs.writeFileSync(this.file, JSON.stringify(info), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  stop() {
    clearInterval(this.sweeper);
    this.server?.close();
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }

  // ---------- documents (called by the custom editor provider) ----------

  register(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const key = document.uri.toString();
    let e = this.docs.get(key);
    if (!e) this.docs.set(key, (e = { document, panels: new Set(), loaded: false }));
    e.panels.add(panel);
    panel.onDidDispose(() => {
      e!.panels.delete(panel);
      if (!e!.panels.size) {
        this.docs.delete(key);
        this.locks.delete(key);
      }
    });
  }

  markLoaded(document: vscode.TextDocument) {
    const e = this.docs.get(document.uri.toString());
    if (e) e.loaded = true;
    this.pushLocks(document.uri.toString());
  }

  /** Messages from a webview that belong to the bridge. Returns true when handled. */
  onWebviewMessage(document: vscode.TextDocument, m: any): boolean {
    if (m?.type === 'mcpResult') {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
      }
      return true;
    }
    if (m?.type === 'revokeLock') {
      const key = document.uri.toString();
      const l = this.locks.get(key);
      if (l) {
        this.lostLocks.set(`${l.session}|${key}`, 'the user revoked your lock in the editor');
        this.locks.delete(key);
        this.pushLocks(key);
      }
      return true;
    }
    return false;
  }

  private pushLocks(key: string) {
    const e = this.docs.get(key);
    if (!e) return;
    const l = this.locks.get(key);
    const locks = l ? [{ session: l.session, label: l.label, since: l.since, lastActive: l.lastActive }] : [];
    for (const p of e.panels) p.webview.postMessage({ type: 'locks', locks });
  }

  private sweep() {
    const now = Date.now();
    for (const [key, l] of this.locks) {
      if (now - l.heartbeat > LOCK_TTL_MS) {
        this.locks.delete(key);
        this.pushLocks(key);
      }
    }
  }

  // ---------- RPC ----------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body: any) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-pen-token'] !== this.token) return send(403, { error: 'bad token' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: any;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { error: 'bad json' });
    }
    try {
      send(200, { result: await this.dispatch(msg.method, msg.params ?? {}, msg.session) });
    } catch (e) {
      send(200, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private findDoc(file: string): DocEntry | undefined {
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const want = norm(file);
    for (const e of this.docs.values()) if (norm(e.document.uri.fsPath) === want) return e;
    return undefined;
  }

  private lockInfo(key: string, session?: Session) {
    const l = this.locks.get(key);
    if (!l) return null;
    return { session: l.session, label: l.label, you: l.session === session?.id, idleSeconds: Math.round((Date.now() - l.lastActive) / 1000) };
  }

  private async dispatch(method: string, params: any, session: Session | undefined): Promise<any> {
    switch (method) {
      case 'ping':
        return { ok: true, window: vscode.workspace.name ?? 'VS Code' };
      case 'listFiles': {
        const open = [...this.docs.values()].map(e => ({
          path: e.document.uri.fsPath,
          name: path.basename(e.document.uri.fsPath),
          open: true,
          dirty: e.document.isDirty,
          window: vscode.workspace.name ?? 'VS Code',
          lock: this.lockInfo(e.document.uri.toString(), session),
        }));
        if (!params.includeClosed) return open;
        const found = await vscode.workspace.findFiles('**/*.pen', '**/node_modules/**', 500);
        const openSet = new Set(open.map(o => o.path.toLowerCase()));
        const closed = found
          .filter(u => !openSet.has(u.fsPath.toLowerCase()))
          .map(u => ({ path: u.fsPath, name: path.basename(u.fsPath), open: false, dirty: false, window: vscode.workspace.name ?? 'VS Code', lock: null }));
        return [...open, ...closed];
      }
      case 'claim':
        return this.claim(params.path, !!params.force, session);
      case 'release': {
        if (!session) return { ok: true };
        for (const [key, l] of this.locks) {
          if (l.session === session.id && (!params.path || this.docs.get(key)?.document.uri.fsPath.toLowerCase() === String(params.path).toLowerCase())) {
            this.locks.delete(key);
            this.pushLocks(key);
          }
        }
        return { ok: true };
      }
      case 'heartbeat': {
        const now = Date.now();
        let held = 0;
        for (const l of this.locks.values()) if (l.session === session?.id) {
          l.heartbeat = now;
          held++;
        }
        return { held };
      }
      case 'call':
        return this.call(params.path, params.method, params.params ?? {}, !!params.write, session);
      case 'save': {
        const e = this.requireDoc(params.path);
        this.assertLock(e, session);
        await new Promise(r => setTimeout(r, 120));
        const ok = await e.document.save();
        return { saved: ok };
      }
      case 'writeAsset':
      case 'readAsset': {
        const e = this.requireDoc(params.path);
        const rel = String(params.rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error('asset path must be relative to the .pen file and stay inside its folder');
        if (!/\.(js|glsl|frag|svg|json|txt|css|md)$/i.test(rel)) throw new Error('only text assets can be read/written: .js .glsl .frag .svg .json .txt .css .md');
        const target = path.join(path.dirname(e.document.uri.fsPath), rel);
        if (method === 'readAsset') {
          if (!fs.existsSync(target)) throw new Error(`${rel} does not exist`);
          return { path: target, content: fs.readFileSync(target, 'utf8') };
        }
        this.assertLock(e, session);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(params.content ?? ''), 'utf8');
        return { path: target, url: `./${rel}` };
      }
      case 'export': {
        const e = this.requireDoc(params.path);
        const out: any = await this.call(params.path, 'exportNode', params.params ?? {}, false, session);
        const docDir = path.dirname(e.document.uri.fsPath);
        const target = params.target ? path.resolve(docDir, params.target) : path.join(docDir, 'exports', out.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const comma = out.dataUrl.indexOf(',');
        const meta = out.dataUrl.slice(0, comma);
        const body = out.dataUrl.slice(comma + 1);
        fs.writeFileSync(target, meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8'));
        return { path: target };
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  private requireDoc(file: string): DocEntry {
    const e = this.findDoc(file);
    if (!e) throw new Error(`${path.basename(file)} is not open in this window. Call select_file first.`);
    return e;
  }

  private async claim(file: string, force: boolean, session: Session | undefined) {
    if (!session) throw new Error('missing session');
    let e = this.findDoc(file);
    if (!e) {
      // Open it as a background tab in this window and wait for the editor to load.
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.openWith', uri, this.viewType, { preview: false, preserveFocus: true });
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        e = this.findDoc(file);
        if (e?.loaded) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (!e) throw new Error(`could not open ${file}`);
    }
    const key = e.document.uri.toString();
    const now = Date.now();
    const cur = this.locks.get(key);
    let warning: string | undefined;
    if (cur && cur.session !== session.id && now - cur.heartbeat < LOCK_TTL_MS) {
      const idle = now - cur.lastActive;
      if (!force && idle < TAKEOVER_IDLE_MS) {
        throw new Error(
          `${path.basename(file)} is locked by another AI session "${cur.label}" (active ${Math.round(idle / 1000)}s ago). ` +
            `Ask the user before interrupting it; call select_file again with force: true to take over.`,
        );
      }
      warning = `Took over the lock from session "${cur.label}" (${force ? 'forced' : `idle for ${Math.round(idle / 1000)}s`}). That session can no longer edit this file.`;
      this.lostLocks.set(`${cur.session}|${key}`, `session "${session.label}" took over the lock`);
    }
    this.lostLocks.delete(`${session.id}|${key}`);
    this.locks.set(key, { session: session.id, label: session.label, since: cur?.session === session.id ? cur.since : now, lastActive: now, heartbeat: now });
    this.pushLocks(key);
    return { path: e.document.uri.fsPath, name: path.basename(e.document.uri.fsPath), warning };
  }

  private assertLock(e: DocEntry, session: Session | undefined) {
    const key = e.document.uri.toString();
    const l = this.locks.get(key);
    if (l && l.session === session?.id) {
      l.lastActive = Date.now();
      l.heartbeat = Date.now();
      return;
    }
    const lost = session ? this.lostLocks.get(`${session.id}|${key}`) : undefined;
    if (lost) throw new Error(`You no longer hold the lock on ${path.basename(e.document.uri.fsPath)}: ${lost}. Call select_file (with force: true if needed) to continue editing.`);
    if (l) throw new Error(`${path.basename(e.document.uri.fsPath)} is locked by session "${l.label}". Call select_file with force: true to take over.`);
    throw new Error(`You do not hold the edit lock on ${path.basename(e.document.uri.fsPath)}. Call select_file first.`);
  }

  private async call(file: string, method: string, params: any, write: boolean, session: Session | undefined) {
    const e = this.requireDoc(file);
    if (write) this.assertLock(e, session);
    else {
      const l = this.locks.get(e.document.uri.toString());
      if (l && l.session === session?.id) l.lastActive = Date.now();
    }
    const t0 = Date.now();
    while (!e.loaded && Date.now() - t0 < 15_000) await new Promise(r => setTimeout(r, 100));
    const panel = [...e.panels][0];
    if (!panel) throw new Error('editor is not open');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the editor did not respond to ${method} within 60s`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      panel.webview.postMessage({ type: 'mcp', id, method, params });
    });
  }
}
