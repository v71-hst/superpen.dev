// Reads the outer layers of Figma data: the .fig ZIP archive, the "fig-kiwi" binary inside it, and the HTML that
// Figma puts on the clipboard. The result is the decoded Kiwi message (a flat list of node changes plus blobs).
import { unzipSync, inflateSync, unzlibSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { decodeKiwi, decodeKiwiSchema } from './kiwi';

export type FigMessage = {
  nodeChanges?: any[];
  blobs?: { bytes: Uint8Array }[];
  [key: string]: any;
};

export type FigData = {
  /** "fig-kiwi" for design files; FigJam, Slides and others use different names. */
  magic: string;
  version: number;
  message: FigMessage;
  /** The .fig archive the message came from (undefined for a bare fig-kiwi binary or the clipboard). */
  archive?: Uint8Array;
  /** Names of the image files in the archive ("images/<hash>"). */
  archiveImages: Set<string>;
  /** The node fields the file's own schema knows, as "NodeChange.<field>": tells how old the writer was. */
  fields: Set<string>;
};

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isZstd = (b: Uint8Array) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

function magicOf(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  let s = '';
  for (let i = 0; i < 8; i++) s += String.fromCharCode(b[i]);
  return /^fig-[a-z.]{4}$/.test(s) ? s : null;
}

/** True for a .fig archive (a ZIP with canvas.fig inside) or a bare fig-kiwi binary. */
export function isFigFile(bytes: Uint8Array): boolean {
  if (magicOf(bytes)) return true;
  if (!isZip(bytes)) return false;
  let found = false;
  try {
    // The filter sees every entry name; returning false means nothing is decompressed.
    unzipSync(bytes, {
      filter: f => {
        if (f.name === 'canvas.fig') found = true;
        return false;
      },
    });
  } catch {
    return false;
  }
  return found;
}

function inflateChunk(chunk: Uint8Array): Uint8Array {
  if (isZstd(chunk)) return zstdDecompress(chunk);
  try {
    return inflateSync(chunk); // raw DEFLATE, which is what Figma writes
  } catch (e) {
    try {
      return unzlibSync(chunk);
    } catch {
      throw e;
    }
  }
}

// Parts of the scene the importer never reads. Leaving them out roughly halves the memory a big file needs:
// glyph outlines and per-character layout of every text node are the bulk of it.
const OMIT = new Set([
  'TextData.glyphs',
  'TextData.decorations',
  'TextData.hyperlinkBoxes',
  'TextData.mentionBoxes',
  'TextData.blockquotes',
  'TextData.logicalIndexToCharacterOffsetMap',
  'TextData.derivedLines',
  'DerivedTextData.glyphs',
  'DerivedTextData.decorations',
  'DerivedTextData.hyperlinkBoxes',
  'DerivedTextData.mentionBoxes',
  'DerivedTextData.blockquotes',
  'DerivedTextData.logicalIndexToCharacterOffsetMap',
  'DerivedTextData.derivedLines',
  'NodeChange.editInfo',
  'NodeChange.pluginData',
  'NodeChange.pluginRelaunchData',
  'NodeChange.prototypeInteractions',
  'NodeChange.variableConsumptionMap',
  'NodeChange.parameterConsumptionMap',
  'NodeChange.annotations',
  'NodeChange.exportSettings',
  'NodeChange.layoutGrids',
  'NodeChange.guides',
  'NodeChange.handoffStatusMap',
  'NodeChange.codeSyntax',
  'NodeChange.symbolLinks',
  'NodeChange.stateGroupPropertyValueOrders',
  'NodeChange.variantPropSpecs',
  'NodeChange.sourceCode',
  'NodeChange.collaborativeSourceCode',
  'NodeChange.chatMessages',
  'NodeChange.aiChatThread',
  'NodeChange.widgetSyncedState',
  'NodeChange.renderedSyncedState',
  'NodeChange.developerRelatedLinks',
  'Paint.thumbHash',
  'Paint.thumbHashBase64',
  'Paint.imageThumbnail',
]);

/** Decodes a fig-kiwi binary: 8-byte name, 4-byte version, then length-prefixed chunks (schema, then data). */
function readKiwiBinary(bytes: Uint8Array): { magic: string; version: number; message: FigMessage; fields: Set<string> } {
  const magic = magicOf(bytes);
  if (!magic) throw new Error('This is not Figma data (the "fig-kiwi" header is missing).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off + 4 <= bytes.length && chunks.length < 2) {
    const n = view.getUint32(off, true);
    off += 4;
    if (off + n > bytes.length) throw new Error('The Figma data is cut off (a chunk is longer than the file).');
    chunks.push(bytes.subarray(off, off + n));
    off += n;
  }
  if (chunks.length < 2) throw new Error('The Figma data is incomplete (expected a schema and a data chunk).');
  const schema = decodeKiwiSchema(inflateChunk(chunks[0]));
  const message = decodeKiwi(schema, inflateChunk(chunks[1]), 'Message', OMIT) as FigMessage;
  const fields = new Set<string>();
  const nodeChange = schema.byName.get('NodeChange');
  if (nodeChange !== undefined) for (const f of schema.defs[nodeChange].fields) fields.add(`NodeChange.${f.name}`);
  return { magic, version, message, fields };
}

/** Reads a .fig file: either the ZIP archive Figma saves today, or the bare fig-kiwi binary of older files. */
export function readFig(bytes: Uint8Array): FigData {
  if (!isZip(bytes)) return { ...readKiwiBinary(bytes), archiveImages: new Set() };
  const archiveImages = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: f => {
        if (f.name.startsWith('images/') && f.name.length > 7 && !f.name.endsWith('/')) archiveImages.add(f.name);
        return f.name === 'canvas.fig';
      },
    });
  } catch {
    throw new Error('The .fig file is damaged or incomplete (it cannot be unpacked).');
  }
  const canvas = files['canvas.fig'];
  if (!canvas) throw new Error('This ZIP file is not a Figma file (there is no canvas.fig inside).');
  return { ...readKiwiBinary(canvas), archive: bytes, archiveImages };
}

/** Pulls the named files ("images/<hash>") out of a .fig archive. */
export function readArchiveFiles(archive: Uint8Array, names: ReadonlySet<string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!names.size) return out;
  const files = unzipSync(archive, { filter: f => names.has(f.name) });
  for (const name of Object.keys(files)) out.set(name, files[name]);
  return out;
}

// ---------- clipboard ----------

const FIGMA_RE = /\(figma\)([A-Za-z0-9+/=_\-\s]+?)\(\/figma\)/;
const FIGMETA_RE = /\(figmeta\)([A-Za-z0-9+/=_\-\s]+?)\(\/figmeta\)/;

/** The base64 payload of a Figma copy (the fig-kiwi binary), or null when the HTML did not come from Figma. */
export function figmaClipboard(html: string): string | null {
  if (typeof html !== 'string' || html.indexOf('(figma)') < 0) return null;
  const m = html.match(FIGMA_RE);
  if (!m) return null;
  const payload = m[1].replace(/\s+/g, '');
  return payload.length ? payload : null;
}

/** The small JSON that travels with a Figma copy: { fileKey, pasteID, dataType }. Null when missing or unreadable. */
export function figmaClipboardMeta(html: string): { fileKey?: string; pasteID?: number; dataType?: string } | null {
  const m = typeof html === 'string' ? html.match(FIGMETA_RE) : null;
  if (!m) return null;
  try {
    return JSON.parse(utf8Text(base64Bytes(m[1].replace(/\s+/g, ''))));
  } catch {
    return null;
  }
}

function utf8Text(b: Uint8Array) {
  return new TextDecoder('utf-8').decode(b);
}

export function base64Bytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function readClipboard(html: string): FigData {
  const payload = figmaClipboard(html);
  if (!payload) throw new Error('The clipboard does not hold a Figma copy.');
  return { ...readKiwiBinary(base64Bytes(payload)), archiveImages: new Set() };
}
