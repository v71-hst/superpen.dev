// VS Code extension: opens *.pen files in the visual editor (a custom text editor backed by the JSON document).
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { exec } from 'node:child_process';
import { Bridge, PEN_HOME } from './bridge';
import { registerSidebar } from './sidebar';

const VIEW_TYPE = 'penEditorRemake.editor';
const MCP_NAME = 'pen-editor';
const MCP_SCRIPT = path.join(PEN_HOME, 'mcp.cjs');

let bridge: Bridge;

export function activate(context: vscode.ExtensionContext) {
  bridge = new Bridge(VIEW_TYPE);
  bridge.start(context).catch(e => console.error('[pen-editor] bridge failed to start', e));
  installMcpScript(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('penEditorRemake.registerMcp', () => registerMcp(context, true)),
    vscode.commands.registerCommand('penEditorRemake.registerMcpCodex', () => registerMcpCodex(context)),
  );
  maybePromptMcp(context);
  registerSidebar(context, VIEW_TYPE);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new PenEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('penEditorRemake.open', openPenEditor),
    vscode.commands.registerCommand('penEditorRemake.newFile', newPenFile),
    vscode.commands.registerCommand('penEditorRemake.openAsJson', (uri?: vscode.Uri) => {
      const target = uri ?? activePenUri();
      if (target) vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
    vscode.commands.registerCommand('penEditorRemake.openInEditor', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

export function deactivate() {
  bridge?.stop();
}

/** Copies the bundled MCP server to a stable location so the registration survives extension updates. */
function installMcpScript(context: vscode.ExtensionContext) {
  try {
    fs.mkdirSync(PEN_HOME, { recursive: true });
    fs.copyFileSync(path.join(context.extensionPath, 'dist', 'mcp.cjs'), MCP_SCRIPT);
  } catch (e) {
    console.error('[pen-editor] could not install MCP script', e);
  }
}

function run(cmd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => exec(cmd, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + stderr).trim() })));
}

/** How to start the MCP server: system Node.js if present, else VS Code's own runtime. */
async function mcpLaunch(): Promise<{ command: string; env: Record<string, string> }> {
  const nodeOk = (await run('node --version')).ok;
  return nodeOk ? { command: 'node', env: {} } : { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function registerMcp(context: vscode.ExtensionContext, interactive: boolean) {
  installMcpScript(context);
  const { command, env: envVars } = await mcpLaunch();
  const launch = `"${command}" "${MCP_SCRIPT}"`;
  const env = Object.entries(envVars).map(([k, v]) => ` -e ${k}=${v}`).join('');
  const cmd = `claude mcp add --scope user${env} ${MCP_NAME} -- ${launch}`;
  if (!(await run('claude --version')).ok) {
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showWarningMessage('The Claude Code CLI ("claude") was not found on PATH. The registration command was copied to your clipboard; run it in a terminal where Claude Code is installed.');
    return;
  }
  await run(`claude mcp remove --scope user ${MCP_NAME}`);
  const r = await run(cmd);
  if (r.ok) {
    await context.globalState.update('mcpRegistered', true);
    vscode.window.showInformationMessage(`Superpencil MCP server registered with Claude Code as "${MCP_NAME}". Start a new Claude chat (or run /mcp) to use it.`);
  } else {
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showErrorMessage(`Registering the MCP server failed: ${r.out.slice(0, 300)} — the command was copied to your clipboard.`);
  }
}

/**
 * Codex (CLI and VS Code extension) reads MCP servers from $CODEX_HOME/config.toml (default ~/.codex). The
 * [mcp_servers.pen-editor] table is written directly, so this works without the codex CLI on PATH.
 */
async function registerMcpCodex(context: vscode.ExtensionContext) {
  installMcpScript(context);
  const { command, env } = await mcpLaunch();
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  // JSON strings are valid TOML basic strings (same escapes), which keeps Windows paths safe.
  const q = (v: string) => JSON.stringify(v);
  const block = [
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${q(command)}`,
    `args = [${q(MCP_SCRIPT)}]`,
    ...(Object.keys(env).length ? [`env = { ${Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`).join(', ')} }`] : []),
  ].join('\n');
  try {
    fs.mkdirSync(home, { recursive: true });
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (old) fs.copyFileSync(file, file + '.bak');
    const next = (removeTomlTable(old, `mcp_servers.${MCP_NAME}`).trimEnd() + '\n\n' + block + '\n').trimStart();
    fs.writeFileSync(file, next);
    await context.globalState.update('mcpRegisteredCodex', true);
    vscode.window.showInformationMessage(`Superpencil MCP server registered with Codex as "${MCP_NAME}" in ${file}. Start a new Codex chat to use it.`);
  } catch (e: any) {
    await vscode.env.clipboard.writeText(block + '\n');
    vscode.window.showErrorMessage(`Could not update ${file}: ${e?.message ?? e} — the config block was copied to your clipboard; paste it into that file.`);
  }
}

/** Removes a TOML table and its sub-tables ([name], [name.env], ...) from the text. */
function removeTomlTable(text: string, name: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (m) {
      const t = m[1].replace(/\s*\.\s*/g, '.').replace(/"([^"]*)"/g, '$1');
      skipping = t === name || t.startsWith(name + '.');
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

async function maybePromptMcp(context: vscode.ExtensionContext) {
  if (context.globalState.get('mcpRegistered') || context.globalState.get('mcpRegisteredCodex') || context.globalState.get('mcpPromptDismissed')) return;
  const pick = await vscode.window.showInformationMessage('Register the Superpencil MCP server so Claude Code or Codex can read and edit your .pen designs?', 'Claude Code', 'Codex', 'Not now', "Don't ask again");
  if (pick === 'Claude Code') await registerMcp(context, true);
  else if (pick === 'Codex') await registerMcpCodex(context);
  else if (pick === "Don't ask again") await context.globalState.update('mcpPromptDismissed', true);
}

function activePenUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri;
}

/** Title-bar button: open the active .pen file visually, or pick a .pen file from the workspace. */
async function openPenEditor() {
  const active = activePenUri();
  if (active && active.fsPath.toLowerCase().endsWith('.pen')) {
    await vscode.commands.executeCommand('vscode.openWith', active, VIEW_TYPE);
    return;
  }
  const files = await vscode.workspace.findFiles('**/*.pen', '**/node_modules/**', 500);
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; action?: 'new' | 'browse' };
  const items: Item[] = [
    { label: '$(new-file) New .pen file…', action: 'new' },
    { label: '$(folder-opened) Open .pen file from disk…', action: 'browse' },
  ];
  if (files.length) items.push({ label: 'Workspace', kind: vscode.QuickPickItemKind.Separator });
  for (const uri of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
    items.push({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(path.dirname(uri.fsPath)), uri });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a .pen design in Superpencil' });
  if (!pick) return;
  if (pick.action === 'new') return newPenFile();
  let uri = pick.uri;
  if (pick.action === 'browse') {
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'pen.dev design': ['pen'] } });
    uri = chosen?.[0];
  }
  if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

async function newPenFile() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, 'untitled.pen') : undefined,
    filters: { 'pen.dev design': ['pen'] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ version: '2.21', children: [] }, null, 2)));
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

// ---------- logging: Output panel ("Superpencil") + ~/.pen-editor/logs/webview.log ----------

let output: vscode.OutputChannel | undefined;
const LOG_FILE = path.join(PEN_HOME, 'logs', 'webview.log');

function writeLog(file: string, level: string, message: string) {
  output ??= vscode.window.createOutputChannel('Superpencil');
  const line = `${new Date().toISOString()} [${level}] ${file}: ${message}`;
  output.appendLine(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // Keep the log small: start over past 2 MB.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2_000_000) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* logging must never break the editor */
  }
}

function themeKind(): 'dark' | 'light' {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  return meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
}

class PenEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const roots = [webviewRoot, docDir, ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [])];
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = await this.html(panel.webview, webviewRoot);

    // Text the webview is known to have; used to avoid echoing its own edits back.
    let webviewText = document.getText();
    const post = (m: any) => panel.webview.postMessage(m);

    const sendLoad = () =>
      post({
        type: 'load',
        text: document.getText(),
        fileName: path.basename(document.uri.fsPath),
        baseUri: panel.webview.asWebviewUri(docDir).toString() + '/',
        theme: themeKind(),
      });

    bridge.register(document, panel);
    const subs: vscode.Disposable[] = [];
    subs.push(
      panel.webview.onDidReceiveMessage(async m => {
        if (bridge.onWebviewMessage(document, m)) return;
        switch (m?.type) {
          case 'ready':
            webviewText = document.getText();
            sendLoad();
            bridge.markLoaded(document);
            break;
          case 'edit': {
            if (typeof m.text !== 'string' || m.text === document.getText()) return;
            webviewText = m.text;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), m.text);
            await vscode.workspace.applyEdit(edit);
            break;
          }
          case 'save':
            // Give a just-sent edit a moment to land before saving.
            setTimeout(async () => {
              if (await document.save()) post({ type: 'saved' });
            }, 50);
            break;
          case 'saveAs':
            await vscode.commands.executeCommand('workbench.action.files.saveAs');
            break;
          case 'download': {
            const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(docDir, String(m.name ?? 'export')) });
            if (!target) return;
            await vscode.workspace.fs.writeFile(target, dataUrlToBuffer(m.dataUrl));
            vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}`);
            break;
          }
          case 'saveFiles': {
            const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: docDir, openLabel: 'Export here' });
            if (!picked?.[0]) return;
            for (const f of m.files ?? []) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(picked[0], f.name), dataUrlToBuffer(f.dataUrl));
            vscode.window.showInformationMessage(`Exported ${(m.files ?? []).length} file(s)`);
            break;
          }
          case 'writeFile': {
            let ok = false;
            try {
              const rel = String(m.relPath).replace(/\\/g, '/');
              if (!rel.includes('..')) {
                const target = vscode.Uri.joinPath(docDir, rel);
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
                await vscode.workspace.fs.writeFile(target, dataUrlToBuffer(m.dataUrl));
                ok = true;
              }
            } catch {
              ok = false;
            }
            post({ type: 'response', id: m.id, result: ok });
            break;
          }
          case 'notify':
            vscode.window.showInformationMessage(String(m.text));
            break;
          case 'log':
            writeLog(path.basename(document.uri.fsPath), String(m.level), String(m.message));
            break;
          case 'reload':
            writeLog(path.basename(document.uri.fsPath), 'info', 'editor reloaded by user');
            panel.webview.html = await this.html(panel.webview, webviewRoot);
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString() || !e.contentChanges.length) return;
        const text = document.getText();
        if (text === webviewText) return;
        webviewText = text;
        post({ type: 'update', text });
      }),
      vscode.workspace.onDidSaveTextDocument(d => {
        if (d.uri.toString() === document.uri.toString()) post({ type: 'saved' });
      }),
      vscode.window.onDidChangeActiveColorTheme(() => post({ type: 'theme', theme: themeKind() })),
    );
    // Scripts, shaders and images next to the .pen file re-render when they change on disk.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(docDir, '**/*.{js,glsl,frag,png,jpg,jpeg,webp,gif,svg}'));
    let assetTimer: NodeJS.Timeout | undefined;
    const assetsChanged = () => {
      clearTimeout(assetTimer);
      assetTimer = setTimeout(() => post({ type: 'assetsChanged' }), 120);
    };
    subs.push(watcher, watcher.onDidChange(assetsChanged), watcher.onDidCreate(assetsChanged), watcher.onDidDelete(assetsChanged));
    panel.onDidDispose(() => subs.forEach(s => s.dispose()));
  }

  private async html(webview: vscode.Webview, root: vscode.Uri): Promise<string> {
    const indexUri = vscode.Uri.joinPath(root, 'index.html');
    let html = Buffer.from(await vscode.workspace.fs.readFile(indexUri)).toString('utf8');
    const base = webview.asWebviewUri(root).toString();
    html = html.replace(/(src|href)="\.\/assets\//g, `$1="${base}/assets/`).replace(/ crossorigin/g, '');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `media-src ${webview.cspSource} https: data: blob:`,
      `font-src ${webview.cspSource} https://fonts.gstatic.com https://unpkg.com data:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com`,
      `script-src ${webview.cspSource} 'unsafe-eval'`,
      `connect-src ${webview.cspSource} https: data: blob:`,
      `frame-src https: http:`,
      // Script nodes run in a sandboxed Web Worker created from a blob URL.
      `worker-src blob:`,
    ].join('; ');
    return html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }
}
