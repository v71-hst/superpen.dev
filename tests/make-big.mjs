// Writes a synthetic big design for renderer tests, so nobody's real design is needed (docs/SKIA_REWORK.md, stage 0).
// Seeded, so the same arguments always give the same file: N phone-sized top-level frames of nested auto layout with
// text, shapes, icons, gradients, shadows and picture fills, plus generated PNGs in images/ next to it.
// The defaults (320 frames) give about 41,000 nodes, like the owner's biggest file.
// Usage: node make-big.mjs <out.spen> [frames=320] [seed=1] [pictures=24] [pictureSize=512]
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [, , out = 'big.spen', framesArg = '320', seedArg = '1', picsArg = '24', sizeArg = '512'] = process.argv;
const FRAMES = Number(framesArg);
const PICS = Number(picsArg);
// Side of each generated picture in pixels.
const SIZE = Number(sizeArg);
let seed = Number(seedArg) >>> 0 || 1;
// mulberry32
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = a => a[Math.floor(rand() * a.length)];
const hex = () => '#' + Array.from({ length: 3 }, () => int(0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();

let ids = 0;
const id = () => 'n' + (ids++).toString(36);
let count = 0;
const node = n => (count++, { id: id(), ...n });

const WORDS = 'quest shop daily reward level boss coins gems hero arena guild season pass craft forge raid loot chest map island trade'.split(' ');
const ICONS = ['star', 'heart', 'settings', 'shopping-cart', 'trophy', 'map', 'user', 'bell', 'search', 'gift', 'shield', 'zap'];
const words = n => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const cap = s => s[0].toUpperCase() + s.slice(1);

const text = (content, size, extra = {}) => node({ type: 'text', content, fontFamily: '$font', fontSize: size, fill: '$text', ...extra });
const icon = (size = 20) => node({ type: 'icon', library: 'lucide', icon: pick(ICONS), width: size, height: size, fill: '$text-dim' });
const picture = (w, h, r = 12) => node({ type: 'rectangle', width: w, height: h, cornerRadius: r, fill: { type: 'image', url: `./images/pic-${int(0, PICS - 1)}.png`, mode: 'cover' } });
const gradient = () => ({ type: 'gradient', gradientType: pick(['linear', 'radial']), rotation: int(0, 359), colors: [{ color: hex(), position: 0 }, { color: hex(), position: 1 }] });
const shadow = () => ({ type: 'shadow', shadowType: 'outer', color: '#00000040', offset: { x: 0, y: int(2, 10) }, blur: int(8, 30) });

function listItem() {
  return node({
    type: 'frame', name: 'Item', width: 'fill_container', layout: 'horizontal', gap: 12, padding: 12, alignItems: 'center', cornerRadius: 14, fill: '$surface',
    children: [
      picture(48, 48, 10),
      node({ type: 'frame', name: 'Text', width: 'fill_container', layout: 'vertical', gap: 4, children: [text(cap(words(2)), 15, { fontWeight: '600' }), text(words(4), 12, { fill: '$text-dim' })] }),
      node({ type: 'frame', name: 'Badge', layout: 'horizontal', padding: [4, 8], cornerRadius: 999, fill: hex() + '33', children: [text(String(int(1, 999)), 11, { fontWeight: '700' })] }),
      icon(16),
    ],
  });
}

function tile() {
  return node({
    type: 'frame', name: 'Tile', width: 'fill_container', height: 110, layout: 'vertical', gap: 6, padding: 12, justifyContent: 'end', cornerRadius: 16, fill: gradient(), effect: shadow(),
    children: [node({ type: pick(['ellipse', 'rectangle']), width: 28, height: 28, cornerRadius: 6, fill: '#FFFFFF55' }), text(cap(pick(WORDS)), 14, { fontWeight: '700' })],
  });
}

function screen(i) {
  const items = int(8, 13);
  return node({
    type: 'frame', name: `Screen ${i + 1}`, x: (i % 20) * 520, y: Math.floor(i / 20) * 1000, width: 390, height: 844,
    layout: 'vertical', gap: 16, padding: [20, 16], clip: true, fill: '$bg',
    children: [
      node({
        type: 'frame', name: 'Header', width: 'fill_container', layout: 'horizontal', gap: 10, alignItems: 'center',
        children: [node({ type: 'ellipse', width: 36, height: 36, fill: gradient() }), text(cap(words(2)), 18, { fontWeight: '800' }), node({ type: 'frame', width: 'fill_container', height: 1, children: [] }), icon(22), icon(22)],
      }),
      node({
        type: 'frame', name: 'Hero', width: 'fill_container', height: 170, layout: 'vertical', gap: 8, padding: 18, justifyContent: 'end', cornerRadius: 20, clip: true,
        fill: [{ type: 'image', url: `./images/pic-${int(0, PICS - 1)}.png`, mode: 'cover' }, { type: 'gradient', gradientType: 'linear', rotation: 0, colors: [{ color: '#00000000', position: 0 }, { color: '#000000AA', position: 1 }] }],
        effect: shadow(),
        children: [text(cap(words(3)), 22, { fontWeight: '800' }), text(words(6), 13, { fill: '#FFFFFFCC', textGrowth: 'fixed-width', width: 'fill_container' })],
      }),
      node({
        type: 'frame', name: 'Chips', width: 'fill_container', layout: 'horizontal', gap: 6,
        children: Array.from({ length: 4 }, () => node({ type: 'frame', layout: 'horizontal', padding: [6, 10], cornerRadius: 999, stroke: '$border', strokeWidth: 1, children: [text(cap(pick(WORDS)), 12)] })),
      }),
      node({ type: 'frame', name: 'Tiles', width: 'fill_container', layout: 'horizontal', gap: 10, children: [tile(), tile(), tile()] }),
      node({ type: 'frame', name: 'List', width: 'fill_container', layout: 'vertical', gap: 8, children: Array.from({ length: items }, listItem) }),
      node({
        type: 'frame', name: 'Tab bar', width: 'fill_container', layout: 'horizontal', justifyContent: 'space_between', padding: [10, 18], cornerRadius: 18, fill: '$surface', stroke: '$border', strokeWidth: 1,
        children: Array.from({ length: 4 }, () => node({ type: 'frame', layout: 'vertical', gap: 2, alignItems: 'center', children: [icon(20), text(cap(pick(WORDS)), 10)] })),
      }),
    ],
  });
}

const doc = {
  version: '2.21',
  variables: {
    bg: { type: 'color', value: '#0B0F1A' },
    surface: { type: 'color', value: '#151B2C' },
    border: { type: 'color', value: '#FFFFFF1A' },
    text: { type: 'color', value: '#F1F5F9' },
    'text-dim': { type: 'color', value: '#94A3B8' },
    font: { type: 'string', value: 'Inter' },
  },
  children: Array.from({ length: FRAMES }, (_, i) => screen(i)),
};

const dir = path.dirname(path.resolve(out));
fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
for (let p = 0; p < PICS; p++) {
  const png = new PNG({ width: SIZE, height: SIZE });
  const [a, b, c] = [(rand() * 0.05 * 512) / SIZE, (rand() * 0.05 * 512) / SIZE, rand() * 6];
  const base = [int(0, 255), int(0, 255), int(0, 255)];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const v = Math.sin(x * a + c) * Math.cos(y * b) * 0.5 + 0.5;
      const k = (y * SIZE + x) * 4;
      png.data[k] = base[0] * v + 40 * (1 - v);
      png.data[k + 1] = base[1] * (1 - v) + 30;
      png.data[k + 2] = base[2] * v;
      png.data[k + 3] = 255;
    }
  fs.writeFileSync(path.join(dir, 'images', `pic-${p}.png`), PNG.sync.write(png));
}
fs.writeFileSync(out, JSON.stringify(doc));
console.log(`${out}: ${FRAMES} top-level frames, ${count} nodes, ${PICS} pictures of ${SIZE}px in ${path.join(dir, 'images')}`);
