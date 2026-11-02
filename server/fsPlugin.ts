// Vite plugin exposing a tiny local file API so the browser editor can open/save .spen/.pen files on disk.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.pen': 'application/json',
  '.spen': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glsl': 'text/plain',
  '.js': 'text/javascript',
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'app', 'dist']);

function listPenFiles(root: string, dir = root, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) listPenFiles(root, full, depth + 1, out);
    } else if (e.name.endsWith('.pen') || e.name.endsWith('.spen')) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function penFsPlugin(workspace: string): Plugin {
  const root = path.resolve(workspace);

  // Resolves a workspace-relative path and refuses anything that escapes the workspace.
  const safe = (rel: string | null): string | null => {
    if (!rel) return null;
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return full;
  };

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'application/json') => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  };

  const api = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next();
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/info') {
        return send(res, 200, JSON.stringify({ workspace: root, files: listPenFiles(root).sort() }));
      }
      if (url.pathname === '/api/file') {
        const full = safe(url.searchParams.get('path'));
        if (!full) return send(res, 400, JSON.stringify({ error: 'bad path' }));
        if (req.method === 'GET') {
          if (!fs.existsSync(full)) return send(res, 404, JSON.stringify({ error: 'not found' }));
          return send(res, 200, fs.readFileSync(full), MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, body);
          return send(res, 200, JSON.stringify({ ok: true, mtime: fs.statSync(full).mtimeMs }));
        }
      }
      if (url.pathname === '/api/stat') {
        const full = safe(url.searchParams.get('path'));
        if (!full || !fs.existsSync(full)) return send(res, 404, JSON.stringify({ error: 'not found' }));
        return send(res, 200, JSON.stringify({ mtime: fs.statSync(full).mtimeMs }));
      }
      if (url.pathname === '/api/watch') {
        const full = safe(url.searchParams.get('path'));
        if (!full || !fs.existsSync(full)) return send(res, 404, JSON.stringify({ error: 'not found' }));
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ok\n\n');
        let timer: NodeJS.Timeout | undefined;
        const watcher = fs.watch(full, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            try {
              res.write(`data: ${JSON.stringify({ mtime: fs.statSync(full).mtimeMs })}\n\n`);
            } catch {
              /* file may be mid-write */
            }
          }, 150);
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          watcher.close();
          clearInterval(ping);
          clearTimeout(timer);
        });
        return;
      }
      send(res, 404, JSON.stringify({ error: 'unknown endpoint' }));
    } catch (err) {
      send(res, 500, JSON.stringify({ error: String(err) }));
    }
  };

  return {
    name: 'pen-fs',
    configureServer(server) {
      server.middlewares.use(api);
    },
    // `PEN_PROD=1 node start.mjs` serves the production build (for measuring performance without React dev checks).
    configurePreviewServer(server) {
      server.middlewares.use(api);
    },
  };
}
