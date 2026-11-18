// Writes tests/fixtures/layout.pen: hand-picked layout edge cases for tests/layout-diff.mjs (justify/align in both
// directions, fill and fit sizing with fallbacks, layout none, absolute children, wrapping text, rotation and flips,
// groups, shapes, icons, nested auto containers, other node types, auto-width roots).
// Usage: node tests/fixtures/make-layout.mjs [out=tests/fixtures/layout.pen]
import fs from 'node:fs';

let n = 0;
const id = p => `${p}${n++}`;
const R = (w, h, extra = {}) => ({ type: 'rectangle', id: id('r'), width: w, height: h, fill: '#60A5FA', ...extra });
const T = (content, extra = {}) => ({ type: 'text', id: id('t'), content, fontFamily: 'Inter', fontSize: 14, fill: '#111111', ...extra });
const F = (extra, children = []) => ({ type: 'frame', id: id('f'), fill: '#E5E7EB', ...extra, children });
const G = (extra, children) => ({ type: 'group', id: id('g'), ...extra, children });
const LONG = 'The quick brown fox jumps over the lazy dog near the riverbank';
const cases = [];

// justify / align / padding / gap, both directions
for (const layout of ['horizontal', 'vertical'])
  for (const justifyContent of ['start', 'center', 'end', 'space_between', 'space_around'])
    for (const alignItems of ['start', 'center', 'end'])
      cases.push(F({ layout, justifyContent, alignItems, gap: 6, padding: [4, 8, 12, 16], width: 260, height: 140 }, [R(30, 20), R(40, 35), R(25, 50)]));
cases.push(F({ width: 200, height: 80, padding: [10, 30], gap: 3 }, [R(20, 20), R(20, 20)]));
cases.push(F({ width: 200, height: 80, padding: [7], layout: 'vertical' }, [R(20, 20)]));

// fill on main and cross, several fills, auto containers with fills, negative free space
cases.push(F({ width: 300, height: 60, gap: 10, padding: 5 }, [R('fill_container', 'fill_container'), R(50, 20), R('fill_container', 30)]));
cases.push(F({ layout: 'vertical', width: 200, height: 220, gap: 4, padding: [10, 20] }, [R('fill_container', 'fill_container'), R(50, 20), R('fill_container', 'fill_container')]));
cases.push(F({ gap: 8, padding: 6 }, [T('short', { width: 'fill_container', textGrowth: 'fixed-width' }), T('a much longer label', { width: 'fill_container', textGrowth: 'fixed-width' })]));
cases.push(F({ layout: 'vertical', padding: 6, gap: 4 }, [R('fill_container', 10), T('stretch me please'), R(80, 'fill_container')]));
cases.push(F({ width: 100, height: 40, justifyContent: 'center', alignItems: 'center' }, [R(80, 60), R(70, 20)]));
cases.push(F({ width: 100, height: 40, justifyContent: 'space_between' }, [R(80, 20), R(70, 20)]));
cases.push(F({ width: 100, height: 40, justifyContent: 'space_around' }, [R(80, 20), R(70, 20)]));
cases.push(F({ width: 120, height: 50, gap: 5 }, [R('fill_container', 20), R(150, 20)]));

// sizing fallbacks and layout none
cases.push(F({ width: 'fit_content(120)', height: 'fit_content(50)', layout: 'vertical' }, [R(30, 10)]));
cases.push(F({ width: 'fit_content(120)', height: 'fit_content(50)', layout: 'none' }, [R(30, 10, { x: 5, y: 7 })]));
cases.push(F({ width: 'fit_content(120)', height: 'fit_content(50)', layout: 'none' }, []));
cases.push(F({ width: 'fit_content', height: 'fit_content', layout: 'none' }, [R(30, 10, { x: 40, y: 7 }), R('fill_container(25)', 'fit_content(9)', { x: 3, y: 60 }), R(10, 10, { x: 200, y: 200, enabled: false })]));
cases.push(F({ width: 240, height: 120, layout: 'none' }, [R('fill_container', 'fill_container(30)', { x: 10, y: 10 }), R('fill_container(50)', 20, { x: 20, y: 80 }), T('abs auto text', { x: 150, y: 20 }), T(LONG, { x: 120, y: 50, textGrowth: 'fixed-width', width: 'fit_content' })]));
cases.push(F({ width: 260, height: 90, gap: 6, padding: 8 }, [R(40, 40), R(30, 30, { layoutPosition: 'absolute', x: 100, y: 50 }), R(40, 40, { enabled: false }), R(40, 40)]));

// text
cases.push(
  F({ layout: 'vertical', width: 220, gap: 6, padding: 10 }, [
    T('auto text'),
    T(LONG, { textGrowth: 'fixed-width', width: 'fill_container' }),
    T(LONG, { textGrowth: 'fixed-width', width: 150, lineHeight: 1.6, letterSpacing: 0.5 }),
    T(LONG, { textGrowth: 'fixed-width-height', width: 180, height: 30 }),
    T(LONG, { textGrowth: 'fixed-width', width: 'fit_content' }),
    T('Line one\nLine two is longer\n3', { fontSize: 18, fontWeight: '700' }),
    T(''),
    T('middle', { textGrowth: 'fixed-width-height', width: 120, height: 50, textAlignVertical: 'middle', textAlign: 'center' }),
    T('fill height', { textGrowth: 'fixed-width-height', width: 120, height: 'fill_container' }),
  ]),
);
cases.push(F({ gap: 10, alignItems: 'center', padding: 8 }, [T('Row label'), T(LONG, { textGrowth: 'fixed-width', width: 'fill_container' }), R(30, 30)]));
cases.push(F({ width: 300, gap: 10, padding: 8 }, [T('Row label'), T(LONG, { textGrowth: 'fixed-width', width: 'fill_container' }), R(30, 'fill_container')]));

// rotation / flips
cases.push(
  F({ width: 260, height: 160, layout: 'none' }, [
    R(60, 30, { x: 40, y: 40, rotation: 30 }),
    R(60, 30, { x: 140, y: 40, flipX: true, rotation: 45 }),
    F({ x: 60, y: 90, width: 80, height: 40, rotation: -20, flipY: true, gap: 4, padding: 4 }, [R(20, 20), R('fill_container', 'fill_container')]),
  ]),
);
cases.push(F({ width: 300, height: 100, gap: 10, padding: 10, alignItems: 'center' }, [R(40, 40, { rotation: 15 }), F({ width: 60, height: 40, rotation: 90, padding: 5 }, [R('fill_container', 'fill_container')]), R(40, 40, { flipX: true, flipY: true })]));

// groups
cases.push(F({ gap: 8, padding: 8, alignItems: 'end' }, [G({}, [R(30, 30, { x: 0, y: 0 }), R(20, 40, { x: 25, y: 10 })]), R(30, 30)]));
cases.push(F({ width: 200, height: 120, layout: 'none' }, [G({ x: 20, y: 20, rotation: 20 }, [R(30, 30, { x: 0, y: 0 }), R(20, 40, { x: 25, y: 10 })])]));

// shapes and icons
cases.push(
  F({ gap: 6, padding: 6, alignItems: 'center' }, [
    { type: 'ellipse', id: id('e'), width: 30, height: 20, fill: '#F87171' },
    { type: 'ellipse', id: id('e'), fill: '#F87171' },
    { type: 'path', id: id('p'), width: 40, height: 30, geometry: 'M0 0L40 30', stroke: { fill: '#000000', thickness: 2 } },
    { type: 'line', id: id('l'), width: 30, height: 0, stroke: { fill: '#000000', thickness: 1 } },
    { type: 'polygon', id: id('pg'), width: 28, height: 28, polygonCount: 5, fill: '#34D399' },
    { type: 'icon', id: id('i'), library: 'lucide', icon: 'star', fill: '#000000' },
    { type: 'icon', id: id('i'), library: 'lucide', icon: 'heart', width: 40, fill: '#000000' },
    { type: 'icon', id: id('i'), library: 'lucide', icon: 'heart', height: 16, fill: '#000000' },
    { type: 'icon', id: id('i'), library: 'lucide', icon: 'heart', width: 'fill_container', height: 20, fill: '#000000' },
    { type: 'icon', id: id('i'), library: 'lucide', icon: 'no-such-icon', width: 18, height: 18, fill: '#000000' },
  ]),
);

// nested auto containers
cases.push(F({ gap: 12, padding: 10 }, [F({ layout: 'vertical', gap: 4 }, [T('Title', { fontSize: 18, fontWeight: '700' }), T('Subtitle text here')]), F({ layout: 'vertical', gap: 2, padding: [4, 8] }, [R('fill_container', 4), T('x'), T('a wider caption')])]));
cases.push(F({ layout: 'vertical', padding: 12, gap: 6 }, [F({ gap: 6, width: 'fill_container' }, [R(20, 20), T('grow', { width: 'fill_container', textGrowth: 'fixed-width' }), R(20, 20)]), F({ gap: 6 }, [R(50, 10), R(60, 10)])]));
cases.push(F({ layout: 'vertical', width: 180, padding: 6, gap: 4, alignItems: 'center' }, [F({ gap: 4, padding: 4 }, [T(LONG, { textGrowth: 'fixed-width', width: 'fill_container' })]), F({ padding: 4 }, [T(LONG, { textGrowth: 'fixed-width', width: 'fit_content' })])]));

// other node types
cases.push(
  F({ width: 600, height: 260, layout: 'none' }, [
    { type: 'note', id: id('n'), x: 10, y: 10, content: 'A note' },
    { type: 'prompt', id: id('n'), x: 260, y: 10, width: 200, content: 'A prompt' },
    { type: 'script', id: id('s'), x: 10, y: 180, width: 60 },
    { type: 'mystery_node', id: id('u'), x: 100, y: 180 },
  ]),
);

const roots = [];
cases.forEach((c, i) => {
  c.x = (i % 8) * 340;
  c.y = Math.floor(i / 8) * 300;
  c.name = `Case ${i + 1}`;
  roots.push(c);
});
// Roots: auto sizes (shrink-to-fit against the zero-width world), a rotated root, root text and a fill-sized rectangle.
roots.push(F({ x: 0, y: 2400, layout: 'vertical', padding: 8, name: 'Root auto width, fill text' }, [T(LONG, { textGrowth: 'fixed-width', width: 'fill_container' })]));
roots.push(F({ x: 400, y: 2400, padding: 8, gap: 6, name: 'Root auto row' }, [T('one two'), R(20, 20)]));
roots.push(F({ x: 800, y: 2400, width: 120, height: 80, rotation: 25, name: 'Root rotated', padding: 10 }, [R('fill_container', 'fill_container')]));
roots.push(T('Root text', { x: 1100, y: 2400 }));
roots.push(T(LONG, { x: 1300, y: 2400, textGrowth: 'fixed-width', width: 'fit_content' }));
roots.push(R('fill_container', 'fill_container(40)', { x: 1600, y: 2400 }));

const out = process.argv[2] ?? new URL('./layout.pen', import.meta.url).pathname;
fs.writeFileSync(out, JSON.stringify({ version: '2.21', children: roots }, null, 1));
console.log(`${out}: ${roots.length} top-level nodes`);
