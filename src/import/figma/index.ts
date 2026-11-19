// Figma import: turns a .fig file, or what Figma puts on the clipboard, into .pen nodes.
//
// Nothing here touches the DOM, Node or the editor's store, so it can run in the webview or in a Web Worker.
//
//   const result = await importFigFile(new Uint8Array(await file.arrayBuffer()));
//   const pasted = figmaClipboard(html) ? await importFigmaClipboard(html) : null;
//
// How things map (see the notes in convert.ts, scene.ts, paints.ts and text.ts for the details):
// - Frames, components, instances and sections become frames; groups become groups; auto layout becomes
//   layout / gap / padding / justifyContent / alignItems, with fill_container and fit_content sizes.
// - Instances are expanded into plain layers, as "detach instance" would. Components keep `reusable: true`.
// - Vectors, boolean operations, stars and polygons become paths, from the outlines Figma stores in the file.
// - Image fills point at "./images/<hash>.<ext>"; the files are returned in `images`.
import type { PenNode } from '../../model/types';
import { figmaClipboard, figmaClipboardMeta, isFigFile, readArchiveFiles, readClipboard, readFig, type FigData } from './container';
import { convertNode, isConvertible, newContext, noteLeftOut, r2 } from './convert';
import { colorHex, type ImageUse } from './paints';
import { buildScene, type FNode, type Scene } from './scene';
import { modeScope, type ModeScope } from './styles';

export { figmaClipboard, figmaClipboardMeta, isFigFile };

export type FigmaImport = {
  /**
   * Top-level .pen nodes: one per top-level layer of the chosen page, positioned with x/y as in Figma. For the
   * clipboard: the copied layers, moved so that the top-left one starts at 0,0.
   */
  nodes: PenNode[];
  /** Image files to write next to the design: relative path ("images/<hash>.png") -> bytes. Image fills point at these with "./images/<hash>.png". */
  images: { path: string; bytes: Uint8Array }[];
  /**
   * Every page of the file, with the number of top-level layers that can be imported from it and the page's
   * canvas colour in Figma (loose dark text was drawn on that, which matters on a dark canvas).
   */
  pages: { name: string; frames: number; background?: string }[];
  /** The page `nodes` came from (undefined for the clipboard). */
  page?: string;
  /** With `sections: "flatten"`: the Figma sections of the page, each with the ids of its (now top-level) frames. */
  sections: { name: string; frames: string[] }[];
  /** Human-readable notes on anything that could not be converted exactly (counted by kind, not one line per node). */
  warnings: string[];
};

export type FigmaImportOptions = {
  /** Page to import, by name or by index in `pages`. Default: the first page that has something on it. */
  page?: string | number;
  /**
   * What to do with Figma sections. "frames" (default) keeps each section as a frame around its contents, which
   * looks like Figma. "flatten" drops the section's own box and makes the layers inside it top-level nodes,
   * listing the section in `sections` (for editors that have sections of their own).
   */
  sections?: 'frames' | 'flatten';
  /** For tests: adds `figmaBox: [x, y, width, height]` (Figma's own numbers) to every node. */
  debug?: boolean;
};

class NoteList {
  private counts = new Map<string, number>();
  add(kind: string, n = 1) {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + n);
  }
  list(): string[] {
    return [...this.counts.entries()].map(([kind, n]) => `${n} × ${kind}`);
  }
}

function sniffExtension(b: Uint8Array): string {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'avif';
  return 'png';
}

/** Gives every image fill its file (or a grey placeholder when the image is not available). */
function resolveImages(uses: ImageUse[], data: FigData, scene: Scene, notes: NoteList): FigmaImport['images'] {
  const wanted = new Set<string>();
  for (const u of uses) if (data.archiveImages.has(`images/${u.hash}`)) wanted.add(`images/${u.hash}`);
  const files = data.archive ? readArchiveFiles(data.archive, wanted) : new Map<string, Uint8Array>();
  const out = new Map<string, { path: string; bytes: Uint8Array }>();
  let missing = 0;
  for (const u of uses) {
    // Current files keep images in the archive; very old ones kept them in the message's blobs.
    const bytes = files.get(`images/${u.hash}`) ?? (u.blob !== undefined ? scene.blobs[u.blob] : undefined);
    if (!bytes || !bytes.length) {
      missing++;
      const enabled = u.fill.enabled;
      for (const k of Object.keys(u.fill)) delete u.fill[k];
      u.fill.type = 'color';
      u.fill.color = '#CCCCCC';
      if (enabled === false) u.fill.enabled = false;
      continue;
    }
    let file = out.get(u.hash);
    if (!file) {
      file = { path: `images/${u.hash}.${sniffExtension(bytes)}`, bytes };
      out.set(u.hash, file);
    }
    u.fill.url = `./${file.path}`;
  }
  if (missing) notes.add(data.archive ? 'image fills whose image is not in the file (grey instead)' : 'image fills without their image (the clipboard and old files do not carry images; grey instead)', missing);
  return [...out.values()];
}

type TopLevel = { node: FNode; dx: number; dy: number; section: string | null; hidden: boolean; modes: ModeScope | null };

/** The layers to import from a page; sections are opened up unless they are kept as frames. */
function topLevel(scene: Scene, page: FNode, flatten: boolean): TopLevel[] {
  const out: TopLevel[] = [];
  const walk = (kids: FNode[], dx: number, dy: number, section: string | null, hidden: boolean, modes: ModeScope | null) => {
    for (const k of kids) {
      if (!isConvertible(k)) continue;
      if (flatten && k.type === 'SECTION') {
        const name = section ? `${section} / ${k.name ?? 'Section'}` : String(k.name ?? 'Section');
        walk(k.kids, dx + (k.transform?.m02 ?? 0), dy + (k.transform?.m12 ?? 0), name, hidden || k.visible === false, modeScope(scene, k, modes));
      } else {
        out.push({ node: k, dx, dy, section, hidden, modes });
      }
    }
  };
  // A page (and a section) can choose variable modes for everything on it.
  walk(page.kids, 0, 0, null, false, modeScope(scene, page, null));
  return out;
}

function convert(data: FigData, opts: FigmaImportOptions, fromClipboard: boolean): FigmaImport {
  const notes = new NoteList();
  const scene = buildScene(data.message, data.fields);
  const flatten = opts.sections === 'flatten';
  const pages = scene.pages.map(p => {
    const page: FigmaImport['pages'][number] = { name: String(p.name ?? ''), frames: topLevel(scene, p, flatten).length };
    if (p.backgroundColor && p.backgroundEnabled !== false) page.background = colorHex(p.backgroundColor, typeof p.backgroundOpacity === 'number' ? p.backgroundOpacity : 1);
    return page;
  });

  let chosen: FNode[];
  let pageName: string | undefined;
  if (fromClipboard) {
    // A copy holds the copied layers under one page; take whatever is there.
    chosen = scene.pages;
  } else {
    let index = -1;
    if (typeof opts.page === 'number') index = opts.page;
    else if (typeof opts.page === 'string') index = pages.findIndex(p => p.name === opts.page);
    else index = Math.max(0, pages.findIndex(p => p.frames > 0));
    if (opts.page !== undefined && !scene.pages[index]) throw new Error(`The Figma file has no page "${opts.page}". Pages: ${pages.map(p => p.name).join(', ') || '(none)'}`);
    chosen = scene.pages[index] ? [scene.pages[index]] : [];
    pageName = scene.pages[index] ? pages[index].name : undefined;
  }

  if (data.magic !== 'fig-kiwi') notes.add(`file of another Figma product ("${data.magic}"): only ordinary design layers are imported`);

  const ctx = newContext(scene, notes, opts.debug === true);
  const nodes: PenNode[] = [];
  const sections = new Map<string, string[]>();
  for (const page of chosen) {
    for (const k of page.kids) if (!isConvertible(k)) noteLeftOut(k, notes);
    for (const t of topLevel(scene, page, flatten)) {
      ctx.modes = t.modes;
      const pen = convertNode(t.node, 'none', ctx);
      if (!pen) continue;
      if (t.dx || t.dy) {
        pen.x = r2((pen.x ?? 0) + t.dx);
        pen.y = r2((pen.y ?? 0) + t.dy);
      }
      if (t.hidden) pen.enabled = false;
      nodes.push(pen);
      if (t.section !== null) {
        let list = sections.get(t.section);
        if (!list) sections.set(t.section, (list = []));
        list.push(pen.id);
      }
    }
  }
  if (fromClipboard && nodes.length) {
    // A copy keeps the page coordinates it was made at. Move it so that its top-left corner is at 0,0: whoever
    // pastes it decides where it goes.
    const left = Math.min(...nodes.map(n => (typeof n.x === 'number' ? n.x : 0)));
    const top = Math.min(...nodes.map(n => (typeof n.y === 'number' ? n.y : 0)));
    for (const n of nodes) {
      n.x = r2((typeof n.x === 'number' ? n.x : 0) - left);
      n.y = r2((typeof n.y === 'number' ? n.y : 0) - top);
    }
  }
  const images = resolveImages(ctx.images, data, scene, notes);
  return {
    nodes,
    images,
    pages,
    page: pageName,
    sections: [...sections.entries()].map(([name, frames]) => ({ name, frames })),
    warnings: notes.list(),
  };
}

/** Imports a .fig file (the ZIP archive Figma saves, or the bare fig-kiwi binary of old files). */
export async function importFigFile(bytes: Uint8Array, opts: FigmaImportOptions = {}): Promise<FigmaImport> {
  return convert(readFig(bytes), opts, false);
}

/** Imports the layers of a Figma copy from the clipboard's text/html. Throws when the HTML is not a Figma copy. */
export async function importFigmaClipboard(html: string, opts: Pick<FigmaImportOptions, 'sections' | 'debug'> = {}): Promise<FigmaImport> {
  return convert(readClipboard(html), opts, true);
}
