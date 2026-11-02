// AI Pen core: turns a prompt (and, when refining, a screenshot plus the previous SVG) into SVG markup with the user's
// own model provider. No VS Code dependency, so the extension and the standalone dev server (start.mjs) share it.
import Anthropic from '@anthropic-ai/sdk';

export type AiPenRequest = {
  prompt: string;
  width: number;
  height: number;
  /** Refinement: what to change, the SVG it produced last time, and a PNG data URL of how it looks now. */
  feedback?: string;
  previousSvg?: string;
  image?: string;
};

export type Provider = 'anthropic' | 'openai-compatible';

export const DEFAULT_MODEL: Record<Provider, string> = { anthropic: 'claude-opus-5-5', 'openai-compatible': '' };
/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const SYSTEM = `You are an expert vector illustrator working inside a UI design tool. You draw icons and illustrations as clean,
editable SVG that a designer will keep editing point by point.

Rules for the SVG you return:
- Return exactly one complete <svg> element and nothing else: no prose, no code fences.
- Use the viewBox given in the request, and keep every shape inside it.
- Draw with <path> elements (plus <circle>, <ellipse>, <rect>, <polygon> where they are the natural shape). Prefer fewer,
  well-constructed paths with smooth cubic Béziers over many tiny segments.
- Use solid fills and strokes only: no <image>, <text>, <foreignObject>, <script>, filters, masks or clip paths, and no
  external references. Gradients are allowed only when the request asks for them.
- Give each shape a short id describing what it is (e.g. "mane", "crown").
- Follow the requested style exactly (line art means strokes with fill="none"; flat means filled shapes, and so on).`;

export type AiPenConfig = { provider: Provider; model: string; baseUrl: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };

function userText(r: AiPenRequest): string {
  const box = `viewBox="0 0 ${Math.round(r.width)} ${Math.round(r.height)}"`;
  if (r.feedback || r.previousSvg) {
    return [
      `Revise this drawing. Original request: ${r.prompt}`,
      r.feedback ? `Change: ${r.feedback}` : 'Improve it: fix anything that looks wrong or unbalanced.',
      r.image ? 'The attached image shows how it currently looks (it may have been edited by hand since).' : '',
      r.previousSvg ? `Previous SVG:\n${r.previousSvg}` : '',
      `Return the full revised SVG with ${box}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return `Draw: ${r.prompt}\n\nUse ${box}.`;
}

function extractSvg(text: string): string {
  const m = /<svg[\s\S]*<\/svg>/i.exec(text);
  if (!m) throw new Error('the model did not return an SVG');
  return m[0];
}

async function viaAnthropic(r: AiPenRequest, cfg: AiPenConfig, key: string | undefined): Promise<string> {
  // Without a stored key the SDK resolves credentials itself (ANTHROPIC_API_KEY, an `ant auth login` profile, ...).
  const client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const png = r.image ? /^data:image\/png;base64,(.+)$/.exec(r.image) : null;
  if (png) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png[1] } });
  content.push({ type: 'text', text: userText(r) });
  const fallback = FALLBACK_MODELS.has(cfg.model);
  const stream = client.beta.messages.stream({
    model: cfg.model,
    max_tokens: 64000,
    system: SYSTEM,
    output_config: { effort: cfg.effort },
    messages: [{ role: 'user', content }],
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error(`the model declined this drawing${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}`);
  if (msg.stop_reason === 'max_tokens') throw new Error('the drawing was too long for one response; try a simpler prompt');
  const text = msg.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
  return extractSvg(text);
}

async function viaOpenAiCompatible(r: AiPenRequest, cfg: AiPenConfig, key: string | undefined): Promise<string> {
  if (!cfg.model) throw new Error('set "superpencil.aiPen.model" to a model your endpoint serves (for example an OpenRouter model id)');
  const user: any[] = [{ type: 'text', text: userText(r) }];
  if (r.image) user.unshift({ type: 'image_url', image_url: { url: r.image } });
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${cfg.baseUrl} returned ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  const text = body?.choices?.[0]?.message?.content;
  return extractSvg(typeof text === 'string' ? text : Array.isArray(text) ? text.map((p: any) => p?.text ?? '').join('') : '');
}

/** Asks the configured provider for SVG; errors carry a message meant for the user. */
export async function requestSvg(r: AiPenRequest, cfg: AiPenConfig, key: string | undefined): Promise<string> {
  if (!r.prompt?.trim()) throw new Error('describe what to draw');
  try {
    return cfg.provider === 'openai-compatible' ? await viaOpenAiCompatible(r, cfg, key) : await viaAnthropic(r, cfg, key);
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('the Anthropic API key was rejected');
    if (e instanceof Anthropic.RateLimitError) throw new Error('rate limited by Anthropic; try again in a moment');
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status}: ${e.message}`);
    if (cfg.provider === 'anthropic' && /api key|credentials|authentication/i.test(String(e?.message))) throw new Error('no Anthropic API key found');
    throw e;
  }
}
