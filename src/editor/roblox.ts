// EXPERIMENTAL: turns a rendered frame into Luau that rebuilds it as Roblox GUI objects (Frame, TextLabel,
// ImageLabel, UICorner, UIStroke, UIGradient). Positions and sizes are measured from the rendered layout, so
// auto-layout comes out exactly; vector shapes and images become ImageLabel placeholders to upload.
import { useStore } from './store';
import { currentTree } from './tree';
import { elFor } from './ops';
import { ensureRendered } from './culling';
import { deepResolve } from '../model/resolve';
import { displayName } from '../model/doc';
import { fillList, parseColor } from '../render/paint';
import type { RNode } from '../model/types';

export type RobloxOptions = {
  /** offset: pixel UDim2s (default). scale: sizes/positions as fractions of the parent. */
  units?: 'offset' | 'scale';
  /** Center the root in its parent (AnchorPoint 0.5). */
  center?: boolean;
};

// Font families that exist in Roblox's font library (rbxasset://fonts/families/<Name>.json).
const ROBLOX_FAMILIES = new Set([
  'Arial', 'Bangers', 'BuilderSans', 'Creepster', 'DenkOne', 'Fondamento', 'FredokaOne', 'GothamSSm', 'Highway', 'IndieFlower', 'Inconsolata',
  'JosefinSans', 'Jura', 'Kalam', 'LuckiestGuy', 'Merriweather', 'Michroma', 'Montserrat', 'Nunito', 'Oswald', 'PatrickHand', 'PermanentMarker',
  'Roboto', 'RobotoCondensed', 'RobotoMono', 'Sarpanch', 'SourceSansPro', 'SpecialElite', 'TitilliumWeb', 'Ubuntu', 'AmaticSC', 'Balthazar',
  'Bodoni', 'Cartoon', 'Code', 'Garamond', 'GrenzeGotisch', 'Guru', 'Legacy', 'Nunito', 'Oswald', 'SciFi', 'Antique',
]);
const FONT_ALIASES: Record<string, string> = { Gotham: 'GothamSSm', 'Source Sans Pro': 'SourceSansPro', 'Fredoka One': 'FredokaOne', Fredoka: 'FredokaOne', 'Titillium Web': 'TitilliumWeb', 'Roboto Mono': 'RobotoMono', 'Roboto Condensed': 'RobotoCondensed', 'Josefin Sans': 'JosefinSans', 'Luckiest Guy': 'LuckiestGuy', 'Permanent Marker': 'PermanentMarker', 'Patrick Hand': 'PatrickHand', 'Indie Flower': 'IndieFlower', 'Special Elite': 'SpecialElite', 'Denk One': 'DenkOne', 'Builder Sans': 'BuilderSans' };
const WEIGHTS: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Heavy' };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const str = (s: string) => JSON.stringify(s); // JSON string escapes are valid Luau string escapes
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1').slice(0, 40) || 'Node';

function color3(c: { r: number; g: number; b: number }) {
  return `Color3.fromRGB(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

export async function exportRoblox(key: string, opts: RobloxOptions = {}): Promise<{ code: string; warnings: string[]; name: string }> {
  const tree = currentTree();
  const doc = useStore.getState().doc;
  const root = tree?.byKey.get(key);
  if (!tree || !doc || !root) throw new Error(`node "${key}" not found`);
  ensureRendered([key]);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await document.fonts.ready;
  const zoom = useStore.getState().view.zoom;
  const warnings = new Set<string>();
  const lines: string[] = [];
  let counter = 0;
  const units = opts.units ?? 'offset';

  const box = (n: RNode) => {
    const el = elFor(n.key);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left / zoom, y: b.top / zoom, w: b.width / zoom, h: b.height / zoom };
  };

  const emit = (n: RNode, parentVar: string, parentBox: { x: number; y: number; w: number; h: number } | null, order: number) => {
    const p = n.props;
    const r = (k: string) => deepResolve(doc, p[k], n.theme);
    const b = box(n);
    if (!b) return;
    const v = `n${++counter}`;
    const fills = fillList(r('fill')).filter((f: any) => f && (typeof f === 'string' || f.enabled !== false));
    const image = fills.find((f: any) => typeof f === 'object' && f.type === 'image') as any;
    const vector = ['path', 'polygon', 'line', 'icon', 'icon_font'].includes(n.type);
    const cls = n.type === 'text' ? 'TextLabel' : image || vector ? 'ImageLabel' : 'Frame';
    const props: string[] = [];
    props.push(`Name = ${str(ident(displayName(p)))}`);
    // Rotated boxes: GUI rotation pivots on the center; use the unrotated size from the document.
    const rot = typeof r('rotation') === 'number' ? r('rotation') : 0;
    let w = b.w;
    let h = b.h;
    let x = b.x - (parentBox?.x ?? b.x);
    let y = b.y - (parentBox?.y ?? b.y);
    if (rot) {
      if (typeof p.width === 'number') w = p.width;
      if (typeof p.height === 'number') h = p.height;
      x += (b.w - w) / 2;
      y += (b.h - h) / 2;
      props.push(`Rotation = ${r2(-rot)}`);
    }
    if (!parentBox && opts.center) {
      props.push('AnchorPoint = Vector2.new(0.5, 0.5)', 'Position = UDim2.fromScale(0.5, 0.5)');
      props.push(units === 'scale' ? `Size = UDim2.fromOffset(${r2(w)}, ${r2(h)})\u0001root keeps its design size` : `Size = UDim2.fromOffset(${r2(w)}, ${r2(h)})`);
    } else if (units === 'scale' && parentBox) {
      props.push(`Position = UDim2.fromScale(${r4(x / parentBox.w)}, ${r4(y / parentBox.h)})`, `Size = UDim2.fromScale(${r4(w / parentBox.w)}, ${r4(h / parentBox.h)})`);
    } else {
      props.push(`Position = UDim2.fromOffset(${r2(x)}, ${r2(y)})`, `Size = UDim2.fromOffset(${r2(w)}, ${r2(h)})`);
    }
    props.push(`ZIndex = ${1 + order}`, 'BorderSizePixel = 0');
    const opacity = typeof r('opacity') === 'number' ? r('opacity') : 1;
    if (opacity < 1 && n.children.length) warnings.add(`"${displayName(p)}" has opacity; only its own colors are faded (use a CanvasGroup for whole-group transparency)`);
    // Background: first solid color, or a gradient through UIGradient on a white background.
    const solid = fills.find((f: any) => typeof f === 'string' || f.type === 'color' || (f.type === undefined && f.color));
    const grad = fills.find((f: any) => typeof f === 'object' && f.type === 'gradient') as any;
    const kids: string[] = [];
    if (n.type === 'text') {
      props.push('BackgroundTransparency = 1');
      const c = parseColor(typeof solid === 'string' ? solid : (solid as any)?.color);
      props.push(`Text = ${str(String(r('content') ?? ''))}`);
      if (c) props.push(`TextColor3 = ${color3(c)}`, `TextTransparency = ${r4(1 - c.a * opacity)}`);
      props.push(`TextSize = ${r2(Number(r('fontSize') ?? 14))}`);
      const fam0 = String(r('fontFamily') ?? 'Inter');
      const fam = FONT_ALIASES[fam0] ?? fam0.replace(/\s+/g, '');
      const weight = WEIGHTS[Math.round(Number(r('fontWeight') ?? 400) / 100) * 100] ?? 'Regular';
      const italic = r('fontStyle') === 'italic' ? 'Enum.FontStyle.Italic' : 'Enum.FontStyle.Normal';
      if (ROBLOX_FAMILIES.has(fam)) props.push(`FontFace = Font.new("rbxasset://fonts/families/${fam}.json", Enum.FontWeight.${weight}, ${italic})`);
      else {
        props.push(`FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.${weight}, ${italic})\u0001design font: ${fam0}`);
        warnings.add(`font "${fam0}" is not in Roblox's library; BuilderSans is used instead`);
      }
      const ta = r('textAlign');
      props.push(`TextXAlignment = Enum.TextXAlignment.${ta === 'center' ? 'Center' : ta === 'right' ? 'Right' : 'Left'}`);
      const tv = r('textAlignVertical');
      props.push(`TextYAlignment = Enum.TextYAlignment.${tv === 'middle' ? 'Center' : tv === 'bottom' ? 'Bottom' : 'Top'}`);
      if (p.textGrowth && p.textGrowth !== 'auto') props.push('TextWrapped = true');
      if (typeof r('lineHeight') === 'number' && r('lineHeight') > 0 && r('lineHeight') < 4) props.push(`LineHeight = ${r2(r('lineHeight'))}`);
    } else if (cls === 'ImageLabel') {
      props.push('BackgroundTransparency = 1', 'Image = ""\u0001TODO: upload and set rbxassetid://');
      if (image) {
        props.push('ScaleType = Enum.ScaleType.Crop');
        warnings.add(`image in "${displayName(p)}" (${String(image.url).slice(0, 80)}) must be uploaded to Roblox; its Image is left empty`);
      } else warnings.add(`${n.type} "${displayName(p)}" is vector art: export it as PNG (Export → PNG) and upload it; its Image is left empty`);
      const c = parseColor(typeof solid === 'string' ? solid : (solid as any)?.color);
      if (c && (n.type === 'icon' || n.type === 'icon_font')) props.push(`ImageColor3 = ${color3(c)}`);
    } else if (solid || grad) {
      const c = parseColor(typeof solid === 'string' ? solid : (solid as any)?.color) ?? { r: 255, g: 255, b: 255, a: 1 };
      props.push(`BackgroundColor3 = ${grad && !solid ? 'Color3.new(1, 1, 1)' : color3(c)}`, `BackgroundTransparency = ${r4(1 - (grad && !solid ? 1 : c.a) * opacity)}`);
      if (grad) {
        const stops = [...(grad.colors ?? [])].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
        const cs = stops.map((s: any) => ({ t: Math.max(0, Math.min(1, Number(s.position ?? 0))), c: parseColor(deepResolve(doc, s.color, n.theme)) ?? { r: 0, g: 0, b: 0, a: 1 } }));
        if (cs.length >= 2) {
          if (cs[0].t > 0) cs.unshift({ ...cs[0], t: 0 });
          if (cs[cs.length - 1].t < 1) cs.push({ ...cs[cs.length - 1], t: 1 });
          const angle = (((-Number(grad.rotation ?? 0) - 90) % 360) + 360) % 360;
          kids.push(
            `make("UIGradient", { Rotation = ${r2(angle > 180 ? angle - 360 : angle)}, Color = ColorSequence.new({ ${cs.map(s => `ColorSequenceKeypoint.new(${r4(s.t)}, ${color3(s.c)})`).join(', ')} }), Transparency = NumberSequence.new({ ${cs.map(s => `NumberSequenceKeypoint.new(${r4(s.t)}, ${r4(1 - s.c.a * Number(grad.opacity ?? 1))})`).join(', ')} }) }, ${v})`,
          );
          if ((grad.gradientType ?? 'linear') !== 'linear') warnings.add(`"${displayName(p)}" uses a ${grad.gradientType} gradient; Roblox only has linear gradients`);
        }
      }
    } else props.push('BackgroundTransparency = 1');
    if (fills.filter((f: any) => typeof f === 'object' && f.type !== 'image').length + (typeof fills[0] === 'string' ? 1 : 0) > 2) warnings.add(`"${displayName(p)}" stacks several fills; only the first solid/gradient is exported`);
    if (p.clip === true) props.push('ClipsDescendants = true');
    // Corners.
    const cr = r('cornerRadius');
    const radius = Array.isArray(cr) ? Math.max(...cr.map(Number).filter(isFinite), 0) : Number(cr ?? 0);
    if (n.type === 'ellipse') kids.push(`make("UICorner", { CornerRadius = UDim.new(0.5, 0) }, ${v})`);
    else if (radius > 0 && cls !== 'TextLabel') {
      kids.push(`make("UICorner", { CornerRadius = UDim.new(0, ${r2(radius)}) }, ${v})`);
      if (Array.isArray(cr) && new Set(cr).size > 1) warnings.add(`"${displayName(p)}" has different corner radii; Roblox uses one radius (${radius})`);
    }
    // Stroke.
    const st = r('stroke');
    const stFill = st && typeof st === 'object' && !Array.isArray(st) && !st.type && ('fill' in st || 'thickness' in st) ? st.fill : st;
    const stWidth = Number(r('strokeWidth') ?? (st && typeof st === 'object' ? st.thickness : undefined) ?? 1);
    const sc = (() => {
      for (const f of fillList(stFill)) {
        const c = parseColor(typeof f === 'string' ? f : (f as any)?.color);
        if (c) return c;
      }
      return null;
    })();
    if (sc && stWidth > 0) kids.push(`make("UIStroke", { Color = ${color3(sc)}, Thickness = ${r2(stWidth)}, Transparency = ${r4(1 - sc.a * opacity)}, ApplyStrokeMode = Enum.ApplyStrokeMode.${n.type === 'text' ? 'Contextual' : 'Border'} }, ${v})`);
    const effects = Array.isArray(p.effect) ? p.effect : p.effect ? [p.effect] : [];
    if (effects.some((e: any) => e?.enabled !== false)) warnings.add(`"${displayName(p)}" has effects (shadows/blur/shaders) that are not exported`);
    // "\u0001" separates a property from its trailing comment (placed after the comma).
    const body = props.map(s => (s.includes('\u0001') ? s.replace('\u0001', ', -- ') : s + ',')).join('\n\t\t');
    lines.push(`\tlocal ${v} = make(${str(cls)}, {\n\t\t${body}\n\t}, ${parentVar})`);
    for (const k of kids) lines.push('\t' + k);
    if (cls === 'TextLabel' || cls === 'ImageLabel') {
      if (n.children.length && cls === 'ImageLabel' && vector) return;
    }
    n.children.filter(c => c.props.enabled !== false).forEach((c, i) => emit(c, v, b, order + 1 + i));
  };

  emit(root, 'parent', null, 0);
  const name = ident(displayName(root.props));
  const code = [
    `-- ${name}: generated by superpen.dev (EXPERIMENTAL Roblox export)`,
    `-- Usage (LocalScript): require(path.to.this)(playerGui:WaitForChild("ScreenGui"))`,
    ...[...warnings].map(w => `-- NOTE: ${w}`),
    'local function make(className, props, parent)',
    '\tlocal inst = Instance.new(className)',
    '\tfor k, v in pairs(props) do',
    '\t\tinst[k] = v',
    '\tend',
    '\tinst.Parent = parent',
    '\treturn inst',
    'end',
    '',
    'return function(parent)',
    ...lines,
    '\treturn n1',
    'end',
    '',
  ].join('\n');
  return { code, warnings: [...warnings], name };
}
