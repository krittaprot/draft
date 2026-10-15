// Bundles the server (dist/server.js) and the browser editor (dist/web/). Run from anywhere.
import { build } from 'esbuild';
import fs from 'node:fs';
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
for (const f of ['index.html', 'style.css', 'icon.svg']) fs.copyFileSync(path.join(root, 'src/web', f), path.join(dist, 'web', f));
console.log('built dist/server.js and dist/web/');
