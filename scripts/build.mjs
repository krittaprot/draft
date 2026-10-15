// Bundles the server (dist/server.js) and the browser editor (dist/web/). Run from anywhere.
import { build } from 'esbuild';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
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
// Version the scripts and styles: pages reference /app.js?v=<hash>, so a release can never mix a new page with a
// browser's or CDN's cached old script (Cloudflare can override no-cache with a long browser TTL on .js/.css).
const web = path.join(dist, 'web');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(web, f))).digest('hex').slice(0, 10);
// tokens.css first: landing.css imports it, so its hash must be in landing.css before landing.css is hashed
const versioned = {};
for (const f of ['tokens.css', 'landing.css', 'style.css', 'app.js', 'pwa.js']) {
  if (f === 'landing.css') {
    const css = path.join(web, f);
    fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace("url('/tokens.css')", `url('/tokens.css?v=${versioned['tokens.css']}')`));
  }
  versioned[f] = hash(f);
}
for (const page of ['index.html', 'landing.html', 'offline.html', 'sw.js']) {
  const file = path.join(web, page);
  let text = fs.readFileSync(file, 'utf8');
  for (const [f, v] of Object.entries(versioned)) text = text.replaceAll(`'/${f}'`, `'/${f}?v=${v}'`).replaceAll(`"/${f}"`, `"/${f}?v=${v}"`);
  // a new shell means a new cache name, so the service worker drops the old one
  if (page === 'sw.js') text = text.replace("const CACHE = 'tandem-shell-v1';", `const CACHE = 'tandem-shell-${versioned['app.js']}${versioned['style.css']}';`);
  fs.writeFileSync(file, text);
}
console.log('built dist/server.js and dist/web/ (assets', Object.entries(versioned).map(([f, v]) => `${f}?v=${v}`).join(', ') + ')');
