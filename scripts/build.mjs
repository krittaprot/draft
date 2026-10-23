// Bundles the server (dist/server.js) and the browser editor (dist/web/). Run from anywhere.
import { build } from 'esbuild';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncFonts, fontCss, fontDrift } from './fonts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Fonts first: the bundle reads the generated metrics, and every declared face must be on disk. The build
// verifies and never writes: `pnpm fonts` is the only thing allowed to regenerate src/shared/font-data.ts,
// so a network blip during a release cannot silently ship a smaller catalogue.
const offline = process.env.DRAFT_FONTS_OFFLINE === '1';
const fontMetrics = await syncFonts({ download: !offline, write: false, quiet: true });
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/font-catalog.json'), 'utf8'));
const declared = [];
for (const fam of catalog.families) {
  for (const w of fam.weights) declared.push(`${fam.name}/${w}/normal`);
  for (const w of fam.italicWeights ?? []) declared.push(`${fam.name}/${w}/italic`);
}
const missingFaces = declared.filter((k) => !fontMetrics.faces[k]);
if (missingFaces.length) {
  const list = missingFaces.slice(0, 8).join(', ') + (missingFaces.length > 8 ? `, … (${missingFaces.length} total)` : '');
  const msg = `fonts: ${missingFaces.length} declared face(s) are not on disk: ${list}. Run \`pnpm fonts\` with network access.`;
  if (offline) console.warn(`${msg} Offline build: those families will be missing from the editor.`);
  else throw new Error(msg);
}
// The committed metrics are what the bundle measures with; the binaries are what the renderer draws with.
// If a file changed since `pnpm fonts` wrote them, refuse to build a mismatched pair.
const drifted = fontDrift(fontMetrics);
if (drifted.length) {
  throw new Error(`fonts: ${drifted.length} font file(s) changed since the last \`pnpm fonts\`: ${drifted.slice(0, 5).join(', ')}`
    + `${drifted.length > 5 ? ', …' : ''}. Run \`pnpm fonts\` so src/shared/font-data.ts matches the binaries.`);
}
const fontVersions = fontMetrics.lock;
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'web'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/server/main.ts')],
  outfile: path.join(dist, 'server.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['@resvg/resvg-js'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
await build({
  entryPoints: [path.join(root, 'src/web/app.ts')],
  outfile: path.join(dist, 'web/app.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, sourcemap: false,
  logLevel: 'warning',
});
// copy the static web files (pages, styles, service worker, fonts, icons, screenshots); app.ts is bundled above
fs.cpSync(path.join(root, 'src/web'), path.join(dist, 'web'), { recursive: true, filter: (f) => !f.endsWith('.ts') });
// One @font-face per face that actually made it into the build, so the editor paints exactly what the
// server measures with. Generated rather than hand-written: the catalogue is the source of truth.
fs.writeFileSync(path.join(dist, 'web/fonts.css'), fontCss(fontMetrics, fontVersions));
// Version the scripts, styles and images: pages reference /app.js?v=<hash>, so a release can never mix a new page with a
// browser's or CDN's cached old script (Cloudflare can override no-cache with a long browser TTL on .js/.css).
const web = path.join(dist, 'web');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(web, f))).digest('hex').slice(0, 10);
// tokens.css first: landing.css imports it, so its hash must be in landing.css before landing.css is hashed
const versioned = {};
for (const f of ['tokens.css', 'landing.css', 'style.css', 'fonts.css', 'app.js', 'pwa.js']) {
  if (f === 'landing.css') {
    const css = path.join(web, f);
    fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace("url('/tokens.css')", `url('/tokens.css?v=${versioned['tokens.css']}')`));
  }
  versioned[f] = hash(f);
}
// icons and screenshots too: a new icon or capture must never be hidden behind a cached old one
for (const dir of ['icons', 'shots']) for (const f of fs.readdirSync(path.join(web, dir))) if (f.endsWith('.png')) versioned[`${dir}/${f}`] = hash(`${dir}/${f}`);
for (const page of ['index.html', 'landing.html', 'offline.html', 'sw.js', 'manifest.webmanifest']) {
  const file = path.join(web, page);
  let text = fs.readFileSync(file, 'utf8');
  for (const [f, v] of Object.entries(versioned)) text = text.replaceAll(`'/${f}'`, `'/${f}?v=${v}'`).replaceAll(`"/${f}"`, `"/${f}?v=${v}"`);
  // a new shell means a new cache name, so the service worker drops the old one
  if (page === 'sw.js') text = text.replace("const CACHE = 'tandem-shell-v1';", `const CACHE = 'tandem-shell-${versioned['app.js']}${versioned['style.css']}';`);
  fs.writeFileSync(file, text);
}
console.log('built dist/server.js and dist/web/ (assets', Object.entries(versioned).filter(([f]) => !f.includes('/')).map(([f, v]) => `${f}?v=${v}`).join(', ') + `, plus ${Object.keys(versioned).filter((f) => f.includes('/')).length} images)`);
