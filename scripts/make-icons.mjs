// Builds the web app icons from mac/icon-source.png (1024px, rounded tile on transparency):
//   icon-192/512.png        the tile as-is (browsers, macOS Dock)
//   apple-touch-icon.png    opaque and edge-to-edge (iOS draws its own rounded corners; transparency turns black)
//   maskable-512.png        opaque, artwork inside the 80% safe zone (Android adaptive icons)
// Run from anywhere: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'mac/icon-source.png'));
const out = path.join(root, 'src/web/icons');
fs.mkdirSync(out, { recursive: true });
const PAPER = '#0d1838'; // the tile's navy, behind the maskable icon's safe-zone padding

/** Bounding box of the opaque tile, from the PNG's alpha channel (8-bit RGBA, non-interlaced). */
function tileBox(buf) {
  let p = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]; }
    if (t === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  if (type !== 6) throw new Error('expected an RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, img = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = img.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  // scan the middle row and column so the soft drop shadow under the tile is ignored
  const alpha = (x, y) => img[(y * w + x) * 4 + 3];
  const mid = h >> 1, cx = w >> 1;
  let x0 = 0; while (alpha(x0, mid) < 250) x0++;
  let x1 = w - 1; while (alpha(x1, mid) < 250) x1--;
  let y0 = 0; while (alpha(cx, y0) < 250) y0++;
  let y1 = h - 1; while (alpha(cx, y1) < 250) y1--;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, size: w };
}

const b = tileBox(src);
const href = `data:image/png;base64,${src.toString('base64')}`;
const render = (svg, size, file) => fs.writeFileSync(path.join(out, file), new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());

// the tile as drawn, transparent around it
const plain = `<svg xmlns="http://www.w3.org/2000/svg" width="${b.size}" height="${b.size}"><image href="${href}" width="${b.size}" height="${b.size}"/></svg>`;
render(plain, 192, 'icon-192.png');
render(plain, 512, 'icon-512.png');

// edge-to-edge: crop slightly inside the tile so its rounded corners and rim fall outside the square
const inset = Math.round(b.w * 0.06);
const cx = b.x + inset, cy = b.y + inset, cs = Math.min(b.w, b.h) - inset * 2;
const full = `<svg xmlns="http://www.w3.org/2000/svg" width="${cs}" height="${cs}" viewBox="${cx} ${cy} ${cs} ${cs}"><rect x="${cx}" y="${cy}" width="${cs}" height="${cs}" fill="${PAPER}"/><image href="${href}" width="${b.size}" height="${b.size}"/></svg>`;
render(full, 180, 'apple-touch-icon.png');

// maskable: same artwork, scaled into the central 80% on paper
const pad = cs * 0.125;
const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${cs + pad * 2}" height="${cs + pad * 2}" viewBox="${cx - pad} ${cy - pad} ${cs + pad * 2} ${cs + pad * 2}"><rect x="${cx - pad}" y="${cy - pad}" width="${cs + pad * 2}" height="${cs + pad * 2}" fill="${PAPER}"/><image href="${href}" width="${b.size}" height="${b.size}"/></svg>`;
render(mask, 512, 'maskable-512.png');
console.log(`tile ${b.w}x${b.h} at ${b.x},${b.y}; wrote icons to src/web/icons`);
