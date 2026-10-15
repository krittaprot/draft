// Turns flattened icon artwork (a rounded tile on a light background, any 8-bit RGB/RGBA PNG) into
// mac/icon-source.png: the tile alone on transparency, 1024px, sized to the macOS icon grid with a soft shadow.
// Then run scripts/make-icons.mjs for the web icons and scripts/build-app.sh for the Mac app.
// Usage: node scripts/icon-from-art.mjs <artwork.png>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/icon-from-art.mjs <artwork.png>'); process.exit(1); }
const src = fs.readFileSync(file);

function decode(buf) {
  let p = 8, w = 0, h = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    if (t === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[type];
  if (!bpp || depth !== 8 || interlace) throw new Error('expected a non-interlaced 8-bit RGB or RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, img = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = img.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return { w, h, px: (x, y) => { const o = (y * w + x) * bpp; return [img[o], img[o + 1], img[o + 2]]; } };
}

const { w, h, px } = decode(src);
// the tile is whatever differs strongly from the background; its soft glow differs only a little
const bg = px(4, 4);
const inTile = (x, y) => { const [r, g, b] = px(x, y); return Math.hypot(r - bg[0], g - bg[1], b - bg[2]) > 110; };
const mx = w >> 1, my = h >> 1;
let x0 = 0; while (!inTile(x0, my)) x0++;
let x1 = w - 1; while (!inTile(x1, my)) x1--;
let y0 = 0; while (!inTile(mx, y0)) y0++;
let y1 = h - 1; while (!inTile(mx, y1)) y1--;
// corner radius from how far the rounded corner sits in along the diagonal: r = sqrt2 * t / (sqrt2 - 1)
let t = 0; while (!inTile(x0 + t, y0 + t)) t++;
const r = Math.round((Math.SQRT2 * t) / (Math.SQRT2 - 1));
const tw = x1 - x0 + 1, th = y1 - y0 + 1, inset = 3;

// 824px tile on a 1024px canvas, like macOS app icons, nudged up to leave room for the shadow
// Normalize small width/height differences in generated artwork to a square Dock tile.
const size = 1024, dw = 824, dh = 824, sx = dw / tw, sy = dh / th;
const dx = (size - dw) / 2, dy = (size - dh) / 2 - 10;
const href = `data:image/png;base64,${src.toString('base64')}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <clipPath id="tile"><rect x="${x0 + inset}" y="${y0 + inset}" width="${tw - inset * 2}" height="${th - inset * 2}" rx="${r - inset}"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0b1530" flood-opacity="0.32"/></filter>
  </defs>
  <g filter="url(#shadow)"><g transform="translate(${dx - x0 * sx} ${dy - y0 * sy}) scale(${sx} ${sy})">
    <image href="${href}" width="${w}" height="${h}" clip-path="url(#tile)"/>
  </g></g>
</svg>`;
const out = path.join(root, 'mac/icon-source.png');
fs.writeFileSync(out, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
console.log(`tile ${tw}x${th} at ${x0},${y0}, corner radius ${r}; wrote ${path.relative(root, out)}`);
