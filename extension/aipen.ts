// AI Pen in VS Code: provider settings, the API key in secret storage, and the request from the editor webview.
// Keys never reach the webview; the model call runs here (no CORS in the extension host).
import * as vscode from 'vscode';
import { DEFAULT_MODEL, requestSvg, type AiPenConfig, type AiPenRequest, type Provider } from './aipenCore';

const SECRET = (p: Provider) => `superpencil.aiPen.key.${p}`;

function config(): AiPenConfig {
  const c = vscode.workspace.getConfiguration('superpencil.aiPen');
  const provider = c.get<Provider>('provider', 'anthropic');
  return {
    provider,
    model: c.get<string>('model', '').trim() || DEFAULT_MODEL[provider],
    baseUrl: c.get<string>('baseUrl', 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    effort: c.get<AiPenConfig['effort']>('effort', 'medium'),
  };
}

export async function generateSvg(context: vscode.ExtensionContext, r: AiPenRequest): Promise<{ svg: string; model: string }> {
  const cfg = config();
  const key = await context.secrets.get(SECRET(cfg.provider));
  try {
    return { svg: await requestSvg(r, cfg, key), model: cfg.model };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/api key/i.test(msg)) throw new Error(`${msg}. Run "Superpencil: Set AI Pen API Key"${cfg.provider === 'anthropic' ? ' (or set ANTHROPIC_API_KEY)' : ''}.`);
    throw e;
  }
}

/** Command: store the API key for the configured provider in VS Code's secret storage. */
export async function setAiPenKey(context: vscode.ExtensionContext) {
  const { provider } = config();
  const label = provider === 'anthropic' ? 'Anthropic API key' : 'API key for your OpenAI-compatible endpoint';
  const key = await vscode.window.showInputBox({ title: `AI Pen: ${label}`, prompt: 'Stored in VS Code secret storage, never in your files. Leave empty to remove it.', password: true, ignoreFocusOut: true });
  if (key === undefined) return;
  if (key.trim()) await context.secrets.store(SECRET(provider), key.trim());
  else await context.secrets.delete(SECRET(provider));
  vscode.window.showInformationMessage(key.trim() ? `AI Pen: ${label} saved.` : `AI Pen: ${label} removed.`);
}
