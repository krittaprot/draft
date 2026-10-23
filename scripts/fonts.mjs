// Downloads the font families declared in src/shared/font-catalog.json from Google Fonts and writes
// src/shared/font-data.ts: real per-face advance widths and vertical metrics, so the editor and the
// server measure text in the same units the font actually draws. Run with `pnpm fonts`.
//
// The font binaries are large, so they are not committed: this script fills src/web/fonts/<slug>/ on demand
// (and build.mjs calls it before bundling). Metrics are committed, so typecheck and tests work offline.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'src/shared/font-catalog.json');
const metricsPath = path.join(root, 'src/shared/font-data.ts');
const fontsDir = path.join(root, 'src/web/fonts');
// sha256 prefix per font file: the contract between the binaries on disk and the committed metrics.
const lockPath = path.join(root, 'src/shared/fonts.lock.json');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const UA = 'Mozilla/4.0 (compatible; Draft font sync)'; // an old UA asks fonts.googleapis.com for plain TTF
// Character ranges stored per face: ASCII + Latin-1/Latin Extended-A, general punctuation, currency signs.
export const RANGES = [[32, 383], [8208, 8303], [8352, 8383]];

const readU16 = (b, o) => b.readUInt16BE(o);
const readI16 = (b, o) => b.readInt16BE(o);
const readU32 = (b, o) => b.readUInt32BE(o);

function tables(b) {
  const n = readU16(b, 4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    out[b.toString('latin1', o, o + 4)] = { off: readU32(b, o + 8), len: readU32(b, o + 12) };
  }
  return out;
}

function parseCmap(b, off) {
  const map = new Map();
  const n = readU16(b, off + 2);
  let best = null;
  for (let i = 0; i < n; i++) {
    const e = off + 4 + i * 8;
    const plat = readU16(b, e), enc = readU16(b, e + 2), sub = off + readU32(b, e + 4);
    const format = readU16(b, sub);
    const score = plat === 3 && enc === 10 ? 3 : (plat === 3 && enc === 1) || (plat === 0 && format === 4) ? 2 : format === 12 ? 1 : 0;
    if (score && (!best || score > best.score)) best = { score, sub, format };
  }
  if (!best) return map;
  const s = best.sub;
  if (best.format === 12) {
    const groups = readU32(b, s + 12);
    for (let i = 0; i < groups; i++) {
      const g = s + 16 + i * 12;
      const start = readU32(b, g), end = readU32(b, g + 4), glyph = readU32(b, g + 8);
      for (let c = start; c <= end && c - start < 0x10000; c++) map.set(c, glyph + (c - start));
    }
  } else if (best.format === 4) {
    const segX2 = readU16(b, s + 6);
    const seg = segX2 / 2;
    const ends = s + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < seg; i++) {
      const end = readU16(b, ends + i * 2), start = readU16(b, starts + i * 2);
      const delta = readI16(b, deltas + i * 2), ro = readU16(b, ranges + i * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph;
        if (ro === 0) glyph = (c + delta) & 0xffff;
        else {
          const addr = ranges + i * 2 + ro + (c - start) * 2;
          glyph = readU16(b, addr);
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) map.set(c, glyph);
      }
    }
  }
  return map;
}

/** Reads the metrics we need out of one sfnt font file. */
export function parseFont(buf, weight = 400, italic = false) {
  if (buf.length < 12) throw new Error('not a font');
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') throw new Error('font collections are not supported here');
  const t = tables(buf);
  for (const need of ['head', 'hhea', 'hmtx', 'maxp', 'cmap']) if (!t[need]) throw new Error(`missing ${need} table`);
  // A variable font would be read at its default instance for every weight, silently breaking layout.
  if (t.fvar) throw new Error('variable font (fvar): instantiate static weights before adding it to the catalogue');

  const upem = readU16(buf, t.head.off + 18);
  const numGlyphs = readU16(buf, t.maxp.off + 4);
  const nH = readU16(buf, t.hhea.off + 34);
  let asc = readI16(buf, t.hhea.off + 4), desc = readI16(buf, t.hhea.off + 6);
  let cap = Math.round(upem * 0.7), xh = Math.round(upem * 0.52);
  const h = t.hmtx.off;
  const adv = (gid) => readU16(buf, h + Math.min(gid, nH - 1) * 4);

  if (t['OS/2']) {
    const o = t['OS/2'].off, ver = readU16(buf, o);
    const typoAsc = readI16(buf, o + 68), typoDesc = readI16(buf, o + 70);
    if (typoAsc) asc = typoAsc;
    if (typoDesc) desc = typoDesc;
    if (ver >= 2) {
      const cx = readI16(buf, o + 86), cc = readI16(buf, o + 88);
      if (cx > 0) xh = cx;
      if (cc > 0) cap = cc;
    }
  }
  const cmap = parseCmap(buf, t.cmap.off);
  const widths = [];
  for (const [from, to] of RANGES) {
    for (let c = from; c <= to; c++) {
      const gid = cmap.get(c);
      widths.push(gid === undefined ? 0 : adv(gid));
    }
  }
  const letters = [];
  for (let c = 97; c <= 122; c++) if (cmap.has(c)) letters.push(adv(cmap.get(c)));
  const avg = letters.length ? Math.round(letters.reduce((a, b) => a + b, 0) / letters.length) : Math.round(upem / 2);

  const b64 = Buffer.from(new Uint16Array(widths).buffer).toString('base64');
  return {
    upem, asc: Math.abs(asc), desc: -Math.abs(desc), cap, xh, avg, weight, italic,
    glyphs: cmap.size, w: b64,
  };
}

function familyName(buf) {
  const t = tables(buf);
  if (!t.name) return null;
  const n = t.name.off;
  const count = readU16(buf, n + 2), strOff = readU16(buf, n + 4) + n;
  const names = [];
  for (let i = 0; i < count; i++) {
    const r = n + 6 + i * 12;
    const platform = readU16(buf, r), nameId = readU16(buf, r + 6), len = readU16(buf, r + 8), off = readU16(buf, r + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    const raw = buf.subarray(strOff + off, strOff + off + len);
    const text = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    names.push({ id: nameId, text });
  }
  return (names.find((x) => x.id === 16) ?? names.find((x) => x.id === 1))?.text ?? null;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const STYLE_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

// --- font renaming -------------------------------------------------------------------------------
// Google's static instances of some families are named per weight ("Poppins SemiBold"). Browsers do not
// care (our @font-face rules define the family) but resvg and fontdb select faces by the name table, so
// a request for Poppins 600 would miss. Rewrite family/subfamily records and rebuild the sfnt directory.

const sum32 = (b) => {
  let s = 0;
  const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
  for (let i = 0; i < padded.length; i += 4) s = (s + padded.readUInt32BE(i)) >>> 0;
  return s;
};

function rewriteNameTable(data, family, subfamily) {
  const count = readU16(data, 2), strOff = readU16(data, 4);
  const records = [];
  const strings = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = readU16(data, r), encoding = readU16(data, r + 2), language = readU16(data, r + 4);
    const nameId = readU16(data, r + 6), len = readU16(data, r + 8), off = readU16(data, r + 10);
    let bytes = data.subarray(strOff + off, strOff + off + len);
    const wide = platform === 3 || platform === 0;
    if (nameId === 1 || nameId === 16) bytes = wide ? Buffer.from(family, 'utf16le').swap16() : Buffer.from(family, 'latin1');
    else if (nameId === 2 || nameId === 17) bytes = wide ? Buffer.from(subfamily, 'utf16le').swap16() : Buffer.from(subfamily, 'latin1');
    records.push({ platform, encoding, language, nameId, index: strings.length });
    strings.push(bytes);
  }
  const header = Buffer.alloc(6 + count * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(count, 2);
  header.writeUInt16BE(6 + count * 12, 4);
  let offset = 0;
  records.forEach((r, i) => {
    const o = 6 + i * 12;
    header.writeUInt16BE(r.platform, o);
    header.writeUInt16BE(r.encoding, o + 2);
    header.writeUInt16BE(r.language, o + 4);
    header.writeUInt16BE(r.nameId, o + 6);
    header.writeUInt16BE(strings[r.index].length, o + 8);
    header.writeUInt16BE(offset, o + 10);
    offset += strings[r.index].length;
  });
  return Buffer.concat([header, ...strings]);
}

/** Returns a copy of the font whose name table declares `family` plus a subfamily, with rebuilt offsets. */
export function renameFamily(buf, family, subfamily) {
  const dir = tables(buf);
  const entries = Object.entries(dir).map(([tag, x]) => ({ tag, data: Buffer.from(buf.subarray(x.off, x.off + x.len)) }));
  const nameEntry = entries.find((e) => e.tag === 'name');
  if (!nameEntry) return buf;
  nameEntry.data = rewriteNameTable(nameEntry.data, family, subfamily);
  const head = entries.find((e) => e.tag === 'head');
  if (head) head.data.writeUInt32BE(0, 8); // checkSumAdjustment, recomputed by the consumer when needed
  entries.sort((a, b) => (a.tag < b.tag ? -1 : 1));

  const n = entries.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(n * 16 - pow * 16, 10);
  let offset = 12 + n * 16;
  const bodies = [];
  entries.forEach((e, i) => {
    const o = 12 + i * 16;
    header.write(e.tag, o, 4, 'latin1');
    header.writeUInt32BE(sum32(e.data), o + 4);
    header.writeUInt32BE(offset, o + 8);
    header.writeUInt32BE(e.data.length, o + 12);
    const pad = (4 - (e.data.length % 4)) % 4;
    const body = Buffer.concat([e.data, Buffer.alloc(pad)]);
    bodies.push(body);
    offset += body.length;
  });
  return Buffer.concat([header, ...bodies]);
}

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

/** Google's stylesheet for one family, as a map "weight/style" -> ttf URL. */
async function faceUrls(family, weights, italics) {
  const all = [...new Set([...weights.map((w) => `0,${w}`), ...italics.map((w) => `1,${w}`)])].sort();
  const q = `family=${encodeURIComponent(family)}:ital,wght@${all.join(';')}`;
  const css = (await get(`https://fonts.googleapis.com/css2?${q}`)).toString('utf8');
  const out = new Map();
  for (const block of css.split('@font-face').slice(1)) {
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal';
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400);
    const url = /url\((https:[^)]+)\)/.exec(block)?.[1];
    if (url) out.set(`${weight}/${style}`, url);
  }
  return out;
}

async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/**
 * Ensures every declared face is on disk, then rewrites font-data.ts.
 * `download: false` only reads whatever is already present (used by tests and offline builds).
 */
export async function syncFonts({ download = true, write = true, quiet = false } = {}) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const log = (...a) => { if (!quiet) console.log(...a); };
  const faces = {};
  let fetched = 0, missing = 0;
  const lock = {};

  for (const fam of catalog.families) {
    const slug = fam.slug ?? slugify(fam.name);
    const dir = path.join(fontsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const wanted = [];
    for (const w of fam.weights) wanted.push({ weight: w, italic: false, file: `${w}.ttf` });
    for (const w of fam.italicWeights ?? []) wanted.push({ weight: w, italic: true, file: `${w}-italic.ttf` });

    let urls = null;
    for (const f of wanted) {
      const file = path.join(dir, f.file);
      if (!fs.existsSync(file) && download) {
        if (!urls) {
          try { urls = await faceUrls(fam.name, fam.weights, fam.italicWeights ?? []); }
          catch (e) { log(`  ! ${fam.name}: font list unavailable (${e.message})`); urls = new Map(); }
        }
        const url = urls.get(`${f.weight}/${f.italic ? 'italic' : 'normal'}`);
        if (url) {
          try {
            fs.writeFileSync(file, await get(url));
            fetched++;
          } catch (e) { log(`  ! ${fam.name} ${f.weight}${f.italic ? ' italic' : ''}: ${e.message}`); }
        }
      }
      if (!fs.existsSync(file)) { missing++; continue; }
      let buf = fs.readFileSync(file);
      // Some Google static instances are named per weight ("Poppins SemiBold"). Normalize so that a
      // request for family "Poppins" + weight 600 resolves to this face in resvg's fontdb.
      const realFamily = familyName(buf);
      if (realFamily && realFamily !== fam.name) {
        buf = renameFamily(buf, fam.name, `${STYLE_NAMES[f.weight] ?? String(f.weight)}${f.italic ? ' Italic' : ''}`);
        fs.writeFileSync(file, buf);
      }
      const m = parseFont(buf, f.weight, f.italic);
      faces[`${fam.name}/${f.weight}/${f.italic ? 'italic' : 'normal'}`] = { ...m, file: `${slug}/${f.file}`, family: fam.name };
      lock[`${slug}/${f.file}`] = sha(buf);
    }
  }

  const metrics = {
    lock,
    version: 1,
    note: 'Generated by scripts/fonts.mjs from the font files themselves. Ranges are the stored advance-width windows.',
    ranges: RANGES,
    faces,
  };
  if (write) fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  if (write) fs.writeFileSync(metricsPath, `// Generated by scripts/fonts.mjs — do not edit. Advance widths and vertical metrics read from the font
// binaries in src/web/fonts/, for every face the build can render.
export interface FaceData {
  family: string;
  /** path under /fonts/ */
  file: string;
  weight: number;
  italic: boolean;
  /** font units per em */
  upem: number;
  /** ascender in font units (positive) */
  asc: number;
  /** descender in font units (negative) */
  desc: number;
  cap: number;
  xh: number;
  avg: number;
  glyphs: number;
  /** base64 of the little-endian uint16 advance widths for RANGES, in font units */
  w: string;
}

export const RANGES: [number, number][] = ${JSON.stringify(metrics.ranges)};

export const FACES: Record<string, FaceData> = ${JSON.stringify(faces, null, 0)};
`);
  const count = Object.keys(faces).length;
  log(`fonts: ${count} faces ready (${fetched} downloaded${missing ? `, ${missing} unavailable` : ''})${write ? ` → ${path.relative(root, metricsPath)}` : ''}`);
  if (missing && !download) log('fonts: some declared faces are not on disk; run `pnpm fonts` with network access to fetch them');
  return metrics;
}

/**
 * Font files whose bytes changed since `pnpm fonts` last wrote the committed metrics. A drifted file means
 * the bundle would measure with one set of widths and the renderer draw with another.
 */
export function fontDrift(metrics) {
  const committed = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {};
  const live = metrics.lock ?? {};
  const problems = [];
  for (const [file, h] of Object.entries(live)) if (committed[file] !== h) problems.push(file);
  for (const file of Object.keys(committed)) if (!(file in live)) problems.push(file);
  return problems;
}

/**
 * @font-face rules for every available face. `versions` maps a font path to a short content hash, so a
 * stylesheet and the binaries it names are always the same pair: the CSS is versioned like every other
 * asset, and each font URL changes whenever its bytes do.
 */
export function fontCss(metrics, versions = {}) {
  const rules = [];
  for (const [key, f] of Object.entries(metrics.faces)) {
    const family = key.split('/')[0];
    const v = versions[f.file] ? `?v=${versions[f.file]}` : '';
    rules.push(`@font-face{font-family:"${family}";src:url("/fonts/${f.file}${v}") format("truetype");font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:block}`);
  }
  return `/* generated by scripts/fonts.mjs — one face per entry in font-data.ts */\n${rules.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const offline = process.argv.includes('--offline');
  const check = process.argv.includes('--check');
  const metrics = await syncFonts({ download: !offline && !check, write: !check });
  if (check) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const wanted = [];
    for (const fam of catalog.families) {
      for (const w of fam.weights) wanted.push(`${fam.name}/${w}/normal`);
      for (const w of fam.italicWeights ?? []) wanted.push(`${fam.name}/${w}/italic`);
    }
    const missing = wanted.filter((k) => !metrics.faces[k]);
    if (missing.length) {
      console.error(`fonts: ${missing.length} declared face(s) missing — run \`pnpm fonts\`\n  ${missing.slice(0, 12).join('\n  ')}`);
      process.exit(1);
    }
    const drift = fontDrift(metrics);
    if (drift.length) {
      console.error(`fonts: ${drift.length} file(s) changed since the metrics were written — run \`pnpm fonts\`\n  ${drift.slice(0, 12).join('\n  ')}`);
      process.exit(1);
    }
    const present = Object.keys(metrics.faces).length;
    console.log(`fonts: ok — ${present} faces on disk, ${wanted.length} declared`);
  }
}
