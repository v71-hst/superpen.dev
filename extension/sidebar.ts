// Activity bar view: the workspace's .spen/.pen designs, each opening in the visual editor.
import * as vscode from 'vscode';
import * as path from 'node:path';
import { DESIGN_GLOB } from './bridge';

class DesignsProvider implements vscode.TreeDataProvider<vscode.Uri> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private viewType: string) {}

  refresh() {
    this.changed.fire();
  }

  getTreeItem(uri: vscode.Uri): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    const dir = vscode.workspace.asRelativePath(path.dirname(uri.fsPath), true);
    item.description = dir === path.dirname(uri.fsPath) ? undefined : dir;
    item.tooltip = uri.fsPath;
    item.resourceUri = uri;
    item.contextValue = 'penFile';
    item.command = { command: 'vscode.openWith', title: 'Open in Superpencil', arguments: [uri, this.viewType] };
    return item;
  }

  async getChildren(element?: vscode.Uri): Promise<vscode.Uri[]> {
    if (element) return [];
    const files = await vscode.workspace.findFiles(DESIGN_GLOB, '**/node_modules/**', 500);
    return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }
}

export function registerSidebar(context: vscode.ExtensionContext, viewType: string) {
  const provider = new DesignsProvider(viewType);
  // Refreshes are batched: saving a design fires several change events.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 300);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(DESIGN_GLOB, false, true, false);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('superpencil.designs', provider),
    vscode.commands.registerCommand('penEditorRemake.refreshDesigns', () => provider.refresh()),
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  );
}
