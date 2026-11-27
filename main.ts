// Squeeze screenshots into the smallest PNG: colour-type reduction, palette
// ordering trials, per-row adaptive filters screened by real deflate size, and
// the best zlib stream found for the winning filtered data.
// Lossless by construction: every candidate is built from the exact pixels.
import { createDeflate, deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- PNG primitives ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function pngOf(width: number, height: number, ct: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = ct;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- Decode the stored input (colour type 6, depth 8) ----------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function decodeInput(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  let width = 0, height = 0, ct = -1;
  const idats: Uint8Array[] = [];
  let at = 8;
  while (at < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + at + 8);
      width = dv.getUint32(0); height = dv.getUint32(4); ct = data[9];
      if (data[8] !== 8 || data[10] !== 0) throw new Error('unsupported input PNG');
    } else if (type === 'IDAT') idats.push(data);
    at += 12 + len;
  }
  if (ct !== 6) throw new Error('input is not RGBA');
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= 4 ? rgba[dst + x - 4] : 0;
      const b = y > 0 ? rgba[up + x] : 0;
      const c = y > 0 && x >= 4 ? rgba[up + x - 4] : 0;
      let out = v;
      if (f === 1) out = (v + a) & 255;
      else if (f === 2) out = (v + b) & 255;
      else if (f === 3) out = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) out = (v + paeth(a, b, c)) & 255;
      rgba[dst + x] = out;
    }
  }
  return { rgba, width, height };
}

// ---------- Filters ----------
function filterRowInto(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  for (let x = 0; x < cur.length; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) pred = paeth(a, b, c);
    out[x] = (cur[x] - pred) & 255;
  }
}
function signedCost(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}
const PAIR_SEEN = new Uint32Array(65536);
let pairStamp = 0;
function pairsCost(row: Uint8Array): number {
  pairStamp++;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const p = (row[i - 1] << 8) | row[i];
    if (PAIR_SEEN[p] !== pairStamp) { PAIR_SEEN[p] = pairStamp; n++; }
  }
  return n;
}
function entropyCost(row: Uint8Array, counts: Uint32Array): number {
  counts.fill(0);
  for (let i = 0; i < row.length; i++) counts[row[i]]++;
  let s = 0;
  for (let i = 0; i < 256; i++) { const c = counts[i]; if (c) s += c * Math.log2(c); }
  return row.length * Math.log2(row.length) - s; // total estimated bits-ish (monotone in entropy)
}
// Build filtered data for one form. choice: 0..4 fixed, or 'minsum' / 'entropy' adaptive.
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const counts = new Uint32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let bestT = 0, bestC = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t]);
      const cost = choice === 'minsum' ? signedCost(trials[t]) : choice === 'pairs' ? pairsCost(trials[t]) : entropyCost(trials[t], counts);
      if (cost < bestC) { bestC = cost; bestT = t; }
    }
    raw[at] = bestT;
    raw.set(trials[bestT], at + 1);
  }
  return raw;
}
// Per-row brute force: each row's filter is the one whose bytes deflate smallest
// against the 32 KiB of already-chosen filtered data before it (level 4 trials).
function bruteFiltered(samples: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride + 1);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let bestT = 0, bestLen = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      filterRowInto(t, cur, prev, bpp, trial.subarray(1));
      const z = before.length === 0
        ? deflateSync(trial, { level: 4, memLevel: 9 })
        : deflateSync(trial, { level: 4, memLevel: 9, dictionary: Buffer.from(before) });
      if (z.length < bestLen) { bestLen = z.length; bestT = t; }
    }
    raw[at] = bestT;
    filterRowInto(bestT, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// ---------- Forms ----------
interface Form { ct: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; chunkBytes: number; }
interface Colour { r: number; g: number; b: number; a: number; count: number; first: number; }

function analyse(rgba: Uint8Array) {
  const n = rgba.length >>> 2;
  let opaque = true, grey = true;
  const map = new Map<number, Colour>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const c = map.get(key);
      if (c) c.count++;
      else if (map.size >= 256) many = true;
      else map.set(key, { r, g, b, a, count: 1, first: i });
    }
  }
  return { opaque, grey, colours: many ? null : [...map.values()] };
}
function transparentKey(rgba: Uint8Array, grey: boolean): number {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -2;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return -2;
  }
  if (key === -1) return -2;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -2;
  }
  return key;
}
function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): Form {
  const lum = (c: Colour) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0, ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.first - y.first;
    if (order === 'first') return x.first - y.first;
    return y.count - x.count || x.first - y.first;
  });
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a) >>> 0, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => { plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b; if (c.a !== 255) transparent = i + 1; });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const samples = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    samples[i] = index.get(((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0)!;
  }
  return { ct: 3, bpp: 1, samples, plte, trns, chunkBytes: 12 + plte.length + (trns ? 12 + trns.length : 0) };
}
function channelForm(rgba: Uint8Array, ct: number, trns: Uint8Array | null): Form {
  const bpp = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  if (ct === 6) return { ct, bpp, samples: rgba, plte: null, trns, chunkBytes: trns ? 12 + trns.length : 0 };
  const n = rgba.length >>> 2;
  const samples = new Uint8Array(n * bpp);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += bpp) {
    if (ct === 0) samples[s] = rgba[d];
    else if (ct === 4) { samples[s] = rgba[d]; samples[s + 1] = rgba[d + 3]; }
    else { samples[s] = rgba[d]; samples[s + 1] = rgba[d + 1]; samples[s + 2] = rgba[d + 2]; }
  }
  return { ct, bpp, samples, plte: null, trns, chunkBytes: trns ? 12 + trns.length : 0 };
}
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours) {
    for (const order of ['count', 'luminance', 'first']) forms.push(paletteForm(rgba, colours, order));
    if (!grey) return forms;
  }
  const key = opaque ? -2 : transparentKey(rgba, grey);
  let trns: Uint8Array | null = null;
  let ct: number;
  if (grey) {
    ct = opaque || key >= 0 ? 0 : 4;
    if (key >= 0) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key >= 0 ? 2 : 6;
    if (key >= 0) trns = Uint8Array.of(0, (key >> 16) & 255, 0, (key >> 8) & 255, 0, key & 255);
  }
  forms.push(channelForm(rgba, ct, trns));
  return forms;
}

// One zlib stream whose deflate blocks are closed every `rows` image rows
// (Z_BLOCK flush): fresh Huffman tables for each stretch of rows, while the
// 32 KiB dictionary keeps flowing across the boundary. Deterministic: the
// split points depend only on the row count, never on the clock.
function deflateSegmented(data: Uint8Array, stridePlus: number, rows: number, strategy: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const d = createDeflate({ level: 9, memLevel: 8, strategy });
    const chunks: Buffer[] = [];
    d.on('data', (c: Buffer) => chunks.push(c));
    d.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    d.on('error', reject);
    const seg = stridePlus * rows;
    let at = 0;
    while (at < data.length) {
      const end = Math.min(data.length, at + seg);
      if (end >= data.length) d.end(Buffer.from(data.subarray(at, end)));
      else { d.write(Buffer.from(data.subarray(at, end))); d.flush(constants.Z_BLOCK, () => {}); }
      at = end;
    }
  });
}

// ---------- Squeeze one image ----------
async function squeeze(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  let best: { form: Form; zlib: Uint8Array; total: number; data: Uint8Array } | null = null;
  const choices: (number | string)[] = [0, 1, 2, 3, 4, 'minsum', 'entropy', 'pairs'];
  const polish = (form: Form, data: Uint8Array) => {
    const optsList: object[] = [
      { level: 9, memLevel: 8 },
      { level: 9, memLevel: 9 },
      { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
    ];
    if (form.bpp === 1) optsList.push({ level: 9, memLevel: 8, strategy: constants.Z_RLE });
    for (const opts of optsList) {
      const z = deflateSync(data, opts);
      const total = z.length + form.chunkBytes;
      if (!best || total < best.total) best = { form, zlib: new Uint8Array(z), total, data };
    }
  };
  let bruteForm: Form | null = null, bruteLen = Infinity;
  for (const form of formsOf(rgba)) {
    // Screen every filter choice at level 6, keep the best two, then polish at level 9.
    const scored: { data: Uint8Array; len: number }[] = [];
    for (const choice of choices) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, { level: 6, memLevel: 8 });
      scored.push({ data, len: z.length + form.chunkBytes });
    }
    scored.sort((a, b) => a.len - b.len);
    if (scored[0].len < bruteLen) { bruteLen = scored[0].len; bruteForm = form; }
    polish(form, scored[0].data);
    if (scored[1] && scored[1].len < scored[0].len * 1.02) polish(form, scored[1].data);
  }
  // One per-row brute-force pass on the screened best form, polished the same way.
  // Brute trials only pay on 1-byte-per-pixel forms (palette / grey) in testing;
  // on RGB(A) rows they cost seconds and never won, so they are skipped there.
  if (bruteForm && bruteForm.bpp === 1) polish(bruteForm, bruteFiltered(bruteForm.samples, width, height, bruteForm.bpp));
  if (!best) throw new Error('no form');
  // Segmented-block trials on the winning filtered data only.
  const stridePlus = width * best.form.bpp + 1;
  for (const [rows, strategy] of [
    [120, constants.Z_DEFAULT_STRATEGY],
    [60, constants.Z_DEFAULT_STRATEGY],
    [30, constants.Z_DEFAULT_STRATEGY],
    [60, constants.Z_FILTERED],
    [30, constants.Z_FILTERED],
  ] as [number, number][]) {
    const z = await deflateSegmented(best.data, stridePlus, rows, strategy);
    const total = z.length + best.form.chunkBytes;
    if (total < best.total) best = { form: best.form, zlib: z, total, data: best.data };
  }
  return pngOf(width, height, best.form.ct, best.form.plte, best.form.trns, best.zlib);
}

for (const id of readdirSync(I).sort()) {
  const { rgba, width, height } = decodeInput(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), await squeeze(rgba, width, height));
}
