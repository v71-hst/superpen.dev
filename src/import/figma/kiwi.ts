// A small decoder for the Kiwi binary format (github.com/evanw/kiwi), which Figma uses for .fig files and its
// clipboard. A file carries its own binary schema, so nothing about Figma's schema is hard-coded here. This is an
// interpreter rather than generated code (the kiwi-schema package compiles a schema with `new Function`), and it can
// leave out fields the importer never reads, which saves a lot of memory on big files.

const BUILTIN = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'] as const;

const KIND_ENUM = 0;
const KIND_STRUCT = 1;
const KIND_MESSAGE = 2;

type Field = { name: string; type: number; isArray: boolean; value: number };
type Def = { name: string; kind: number; fields: Field[] };

export type KiwiSchema = { defs: Def[]; byName: Map<string, number> };

const utf8 = new TextDecoder('utf-8');

class Reader {
  pos = 0;
  private f32 = new Float32Array(1);
  private i32 = new Int32Array(this.f32.buffer);
  constructor(readonly data: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.data.length) throw new Error('Kiwi data ends early');
    return this.data[this.pos++];
  }

  varUint(): number {
    let value = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      value |= (b & 127) << shift;
      shift += 7;
    } while (b & 128 && shift < 35);
    return value >>> 0;
  }

  varInt(): number {
    const v = this.varUint();
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }

  /** 64-bit integers come back as plain numbers (exact up to 2^53, which is plenty for what a design file holds). */
  varUint64(): number {
    let value = 0;
    let scale = 1;
    let b: number;
    let n = 0;
    while ((b = this.byte()) & 128 && n < 8) {
      value += (b & 127) * scale;
      scale *= 128;
      n++;
    }
    return value + b * scale;
  }

  varInt64(): number {
    const v = this.varUint64();
    const half = Math.floor(v / 2);
    return v % 2 ? -half - 1 : half;
  }

  float(): number {
    const d = this.data;
    const i = this.pos;
    if (i >= d.length) throw new Error('Kiwi data ends early');
    // A zero is stored as a single zero byte.
    if (d[i] === 0) {
      this.pos = i + 1;
      return 0;
    }
    if (i + 4 > d.length) throw new Error('Kiwi data ends early');
    const bits = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24);
    this.pos = i + 4;
    // The exponent is stored in the low bits, so that small numbers start with a zero byte less often.
    this.i32[0] = (bits << 23) | (bits >>> 9);
    return this.f32[0];
  }

  string(): string {
    const d = this.data;
    const start = this.pos;
    let end = start;
    while (end < d.length && d[end] !== 0) end++;
    if (end >= d.length) throw new Error('Kiwi string is not terminated');
    this.pos = end + 1;
    return utf8.decode(d.subarray(start, end));
  }

  skipString() {
    const d = this.data;
    let end = this.pos;
    while (end < d.length && d[end] !== 0) end++;
    this.pos = end + 1;
  }

  bytes(): Uint8Array {
    const n = this.varUint();
    const start = this.pos;
    if (start + n > this.data.length) throw new Error('Kiwi data ends early');
    this.pos = start + n;
    return this.data.subarray(start, start + n);
  }
}

export function decodeKiwiSchema(bytes: Uint8Array): KiwiSchema {
  const r = new Reader(bytes);
  const count = r.varUint();
  const defs: Def[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const kind = r.byte();
    const fieldCount = r.varUint();
    const fields: Field[] = [];
    for (let j = 0; j < fieldCount; j++) {
      const fname = r.string();
      const type = r.varInt();
      const isArray = !!(r.byte() & 1);
      const value = r.varUint();
      fields.push({ name: fname, type, isArray, value });
    }
    defs.push({ name, kind, fields });
  }
  const byName = new Map<string, number>();
  defs.forEach((d, i) => byName.set(d.name, i));
  return { defs, byName };
}

type Read = (r: Reader) => any;
type Skip = (r: Reader) => void;

/**
 * Decodes a message of type `root`. `omit` lists fields to leave out, as "Type.field" (the bytes are still walked,
 * but nothing is allocated for them).
 */
export function decodeKiwi(schema: KiwiSchema, bytes: Uint8Array, root: string, omit: ReadonlySet<string> = new Set()): any {
  const { defs } = schema;
  const readers: (Read | undefined)[] = new Array(defs.length);
  const skippers: (Skip | undefined)[] = new Array(defs.length);

  const builtinRead: Read[] = [
    r => !!r.byte(),
    r => r.byte(),
    r => r.varInt(),
    r => r.varUint(),
    r => r.float(),
    r => r.string(),
    r => r.varInt64(),
    r => r.varUint64(),
  ];
  const builtinSkip: Skip[] = [
    r => void r.pos++,
    r => void r.pos++,
    r => void r.varUint(),
    r => void r.varUint(),
    r => void r.float(),
    r => r.skipString(),
    r => void r.varUint64(),
    r => void r.varUint64(),
  ];

  const readType = (type: number): Read => {
    if (type < 0) {
      const b = builtinRead[~type];
      if (!b) throw new Error(`Kiwi schema uses an unknown built-in type (${type})`);
      return b;
    }
    // Looked up at call time: definitions may refer to each other in a cycle.
    return r => reader(type)(r);
  };
  const skipType = (type: number): Skip => {
    if (type < 0) {
      const b = builtinSkip[~type];
      if (!b) throw new Error(`Kiwi schema uses an unknown built-in type (${type})`);
      return b;
    }
    return r => skipper(type)(r);
  };

  const fieldRead = (f: Field): Read => {
    if (f.isArray && f.type === ~1) return r => r.bytes(); // byte[]
    const one = readType(f.type);
    if (!f.isArray) return one;
    return r => {
      const n = r.varUint();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = one(r);
      return out;
    };
  };
  const fieldSkip = (f: Field): Skip => {
    if (f.isArray && f.type === ~1) return r => void r.bytes();
    const one = skipType(f.type);
    if (!f.isArray) return one;
    return r => {
      const n = r.varUint();
      for (let i = 0; i < n; i++) one(r);
    };
  };

  function reader(index: number): Read {
    let fn = readers[index];
    if (fn) return fn;
    const def = defs[index];
    if (!def) throw new Error(`Kiwi schema refers to a missing type (${index})`);
    if (def.kind === KIND_ENUM) {
      const names = new Map<number, string>();
      for (const f of def.fields) names.set(f.value, f.name);
      fn = r => {
        const v = r.varUint();
        return names.get(v) ?? v;
      };
    } else if (def.kind === KIND_STRUCT) {
      const fields = def.fields.map(f => ({ name: f.name, read: fieldRead(f) }));
      fn = r => {
        const out: any = {};
        for (const f of fields) out[f.name] = f.read(r);
        return out;
      };
    } else if (def.kind === KIND_MESSAGE) {
      const byValue = new Map<number, { name: string; read: Read; skip: Skip; omit: boolean }>();
      for (const f of def.fields) byValue.set(f.value, { name: f.name, read: fieldRead(f), skip: fieldSkip(f), omit: omit.has(`${def.name}.${f.name}`) });
      fn = r => {
        const out: any = {};
        for (;;) {
          const id = r.varUint();
          if (id === 0) return out;
          const f = byValue.get(id);
          if (!f) throw new Error(`Kiwi message ${def.name} has an unknown field (${id})`);
          if (f.omit) f.skip(r);
          else out[f.name] = f.read(r);
        }
      };
    } else {
      throw new Error(`Kiwi schema has an unknown kind of type (${def.kind})`);
    }
    readers[index] = fn;
    return fn;
  }

  function skipper(index: number): Skip {
    let fn = skippers[index];
    if (fn) return fn;
    const def = defs[index];
    if (!def) throw new Error(`Kiwi schema refers to a missing type (${index})`);
    if (def.kind === KIND_ENUM) {
      fn = r => void r.varUint();
    } else if (def.kind === KIND_STRUCT) {
      const fields = def.fields.map(fieldSkip);
      fn = r => {
        for (const f of fields) f(r);
      };
    } else {
      const byValue = new Map<number, Skip>();
      for (const f of def.fields) byValue.set(f.value, fieldSkip(f));
      fn = r => {
        for (;;) {
          const id = r.varUint();
          if (id === 0) return;
          const f = byValue.get(id);
          if (!f) throw new Error(`Kiwi message ${def.name} has an unknown field (${id})`);
          f(r);
        }
      };
    }
    skippers[index] = fn;
    return fn;
  }

  const rootIndex = schema.byName.get(root);
  if (rootIndex === undefined) throw new Error(`Kiwi schema has no "${root}" type`);
  return reader(rootIndex)(new Reader(bytes));
}

export const KIWI_BUILTINS = BUILTIN;
