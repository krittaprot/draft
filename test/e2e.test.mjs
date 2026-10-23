// End-to-end: starts a throwaway server, drives it through real MCP clients (HTTP and the stdio bridge)
// and the editor API, then stops it. Set TANDEM_TEST_OUT=<dir> to keep the rendered PNGs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'dist/server.js');
const port = 3391 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
const out = process.env.TANDEM_TEST_OUT;
let proc;
let owner;

const connect = async (token) => {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${textOf(r)}`);
  return r;
};

before(async () => {
  proc = spawn(process.execPath, [server, 'serve', '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  owner = fs.readFileSync(path.join(data, 'owner-token'), 'utf8').trim();
  assert.match(owner, /^draft_/);
});

after(() => {
  proc?.kill();
  fs.rmSync(data, { recursive: true, force: true });
});

test('rejects missing and wrong tokens', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  await assert.rejects(connect('tandem_wrong'));
  assert.equal((await fetch(`${base}/api/docs`)).status, 401);
});

test('CLI discovers tools, draws from JSON and stdin, and enforces permissions', async () => {
  const run = (args, token = owner, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin/draft.js'), ...args, '--url', base], {
      env: { ...process.env, DRAFT_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => stdout += s);
    child.stderr.on('data', (s) => stderr += s);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  const tools = await run(['tools']);
  assert.equal(tools.code, 0, tools.stderr);
  assert.ok(JSON.parse(tools.stdout).tools.some((t) => t.name === 'create_nodes'));
  const created = await run(['call', 'create_document', '{"name":"CLI board"}']);
  assert.equal(created.code, 0, created.stderr);
  const doc = /d_[a-z0-9]+/.exec(textOf(JSON.parse(created.stdout)))[0];
  const drawn = await run(['call', 'create_nodes', '--file', '-'], owner, JSON.stringify({
    document: doc, nodes: [{ type: 'frame', id: 'cli-frame', width: 100, height: 100, fill: '#123456' }],
  }));
  assert.equal(drawn.code, 0, drawn.stderr);
  const c = await connect(owner);
  const detail = await call(c, 'get_node', { document: doc, id: 'cli-frame' });
  assert.match(textOf(detail), /#123456/);
  const bad = await run(['call', 'create_nodes', '{"document":"missing","nodes":[]}']);
  assert.notEqual(bad.code, 0);
  const invalid = await run(['call', 'create_document', '[]']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /JSON object/);
  const denied = await run(['tools'], 'invalid-key');
  assert.notEqual(denied.code, 0);
  await c.close();
});

test('agent designs a screen, sees it, and the history records it', async () => {
  const c = await connect(owner);
  const tools = (await c.listTools()).tools.map((t) => t.name);
  const info = c.getServerVersion();
  assert.equal(info.title, 'Draft');
  assert.equal(info.websiteUrl, base);
  assert.equal(info.icons[0].src, `${base}/icons/icon-512.png`);
  const icon = await fetch(info.icons[0].src);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/png/);
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 200);
  for (const t of ['create_document', 'create_nodes', 'update_nodes', 'screenshot', 'list_comments', 'get_history', 'export']) assert.ok(tools.includes(t), t);
  assert.match(c.getInstructions() ?? '', /shared design canvas/);

  const created = textOf(await call(c, 'create_document', { name: 'Landing' }));
  const doc = /d_[a-z0-9]+/.exec(created)[0];

  const iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>';
  const feature = (id, title) => ({
    type: 'frame', id, layout: 'column', gap: 8, padding: 24, width: 'fill', fill: '#ffffff', radius: 16,
    shadows: [{ x: 0, y: 8, blur: 24, color: 'rgba(15,23,42,0.08)' }],
    children: [
      { type: 'svg', svg: iconSvg, width: 28, height: 28, color: '#2563eb' },
      { type: 'text', text: title, fontSize: 20, fontWeight: 700, color: '#0f172a' },
      { type: 'text', text: 'Agents and people edit the same canvas, with every change recorded and reviewable.', fontSize: 15, color: '#475569', width: 'fill', lineHeight: 1.5 },
    ],
  });
  const r = await call(c, 'create_nodes', {
    document: doc,
    message: 'First pass at the landing page',
    nodes: [{
      type: 'frame', id: 'home', name: 'Home', width: 1200, layout: 'column', gap: 48, padding: [72, 80], fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#eff6ff' }, { offset: 1, color: '#ffffff' }] },
      children: [
        { type: 'frame', id: 'nav', layout: 'row', width: 'fill', justify: 'space-between', align: 'center', fill: null, children: [
          { type: 'text', text: 'Tandem', fontSize: 22, fontWeight: 800, color: '#2563eb' },
          { type: 'frame', layout: 'row', gap: 12, align: 'center', fill: null, children: [
            { type: 'text', text: 'Docs', fontSize: 15, color: '#334155' },
            { type: 'frame', id: 'cta', layout: 'row', padding: [10, 18], radius: 999, fill: '#2563eb', children: [{ type: 'text', text: 'Get started', fontSize: 15, fontWeight: 600, color: '#ffffff' }] },
          ] },
        ] },
        { type: 'text', id: 'title', text: 'A design canvas your agents can actually use', fontSize: 56, fontWeight: 800, color: '#0f172a', width: 760, lineHeight: 1.1 },
        { type: 'frame', layout: 'row', gap: 24, width: 'fill', fill: null, children: [feature('f1', 'Shared canvas'), feature('f2', 'Live review'), feature('f3', 'Any agent')] },
        { type: 'image', id: 'hero-img', width: 'fill', height: 200, radius: 16, src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
      ],
    }],
  });
  assert.match(textOf(r), /created \d+ nodes/);

  const shot = await call(c, 'screenshot', { document: doc, node: 'home' });
  const img = shot.content.find((x) => x.type === 'image');
  assert.ok(img && img.mimeType === 'image/png');
  const png = Buffer.from(img.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  if (out) fs.writeFileSync(path.join(out, 'home.png'), png);
  const link = /Share link \(PNG\): (\S+)/.exec(textOf(shot))[1];
  const linked = await fetch(link.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(linked.status, 200);
  assert.equal(linked.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(link.replace(/^https?:\/\/[^/]+/, base).replace(/sig=.*/, 'sig=nope'))).status, 403);

  // layout: the three cards share the row equally
  const f1 = JSON.parse(textOf(await call(c, 'get_node', { document: doc, id: 'f1' })));
  const f3 = JSON.parse(textOf(await call(c, 'get_node', { document: doc, id: 'f3' })));
  assert.equal(f1.box.w, f3.box.w);
  assert.equal(f1.box.w, Math.round((1200 - 160 - 48) / 3));

  const upd = await call(c, 'update_nodes', { document: doc, updates: [{ id: 'title', props: { text: 'Design with agents, review like a team', color: '#1e3a8a' } }], message: 'Sharper headline', preview: true });
  assert.ok(upd.content.some((x) => x.type === 'image'));
  if (out) fs.writeFileSync(path.join(out, 'home-v2.png'), Buffer.from(upd.content.find((x) => x.type === 'image').data, 'base64'));

  const bad = await c.callTool({ name: 'update_nodes', arguments: { document: doc, updates: [{ id: 'title', props: { colour: 'red' } }] } });
  assert.ok(bad.isError);
  assert.match(textOf(bad), /Unrecognized key/);

  const hist = textOf(await call(c, 'get_history', { document: doc }));
  assert.match(hist, /rev 2 .* owner: Sharper headline/);
  assert.match(hist, /rev 1 .* owner: First pass/);

  const html = textOf(await call(c, 'export', { document: doc, node: 'home', format: 'html' }));
  assert.match(html, /display:flex/);
  assert.match(html, /Design with agents/);

  const outline = textOf(await call(c, 'get_document', { document: doc }));
  assert.match(outline, /frame id=home "Home" 1200x\d+ at 0,0 layout=column/);

  await call(c, 'restore_revision', { document: doc, revision: 1 });
  assert.match(textOf(await call(c, 'get_node', { document: doc, id: 'title' })), /A design canvas your agents/);
  await c.close();
});

test('people review through comments; agents read and answer them', async () => {
  const login = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ token: owner }), redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const h = { cookie, 'x-tandem': '1', 'content-type': 'application/json' };
  const docs = await (await fetch(`${base}/api/docs`, { headers: h })).json();
  const doc = docs[0];
  // cookie writes without the editor header are refused (CSRF guard)
  assert.equal((await fetch(`${base}/api/docs/${doc.id}/comments`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const cm = await (await fetch(`${base}/api/docs/${doc.id}/comments`, { method: 'POST', headers: h, body: JSON.stringify({ pageId: doc.pages[0].id, nodeId: 'cta', x: 0, y: 0, text: 'Make the button green' }) })).json();

  const c = await connect(owner);
  assert.match(textOf(await call(c, 'list_comments', { document: doc.id })), /on cta — owner: Make the button green/);
  await call(c, 'update_nodes', { document: doc.id, updates: [{ id: 'cta', props: { fill: '#16a34a' } }], message: 'Green CTA per review' });
  await call(c, 'reply_comment', { document: doc.id, comment: cm.id, text: 'Done: the CTA is green now.', resolve: true });
  assert.equal(textOf(await call(c, 'list_comments', { document: doc.id })), 'No open comments.');
  await c.close();

  // the editor's own render endpoint works with the cookie
  const png = await fetch(`${base}/api/docs/${doc.id}/render.png?node=home`, { headers: { cookie } });
  assert.equal(png.status, 200);
  if (out) fs.writeFileSync(path.join(out, 'home-v3.png'), Buffer.from(await png.arrayBuffer()));
});

test('viewer tokens are read-only', async () => {
  const res = await fetch(`${base}/api/tokens`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'reviewer', role: 'viewer' }) });
  const { token } = await res.json();
  const c = await connect(token);
  const docs = textOf(await call(c, 'list_documents', {}));
  const doc = /d_[a-z0-9]+/.exec(docs)[0];
  const r = await c.callTool({ name: 'create_nodes', arguments: { document: doc, nodes: [{ type: 'rect' }] } });
  assert.ok(r.isError);
  assert.match(textOf(r), /read-only/);
  await c.close();
});

test('stdio bridge exposes the same tools (for clients without HTTP MCP)', async () => {
  const t = new StdioClientTransport({ command: process.execPath, args: [server, 'stdio', '--url', base, '--token', owner] });
  const c = new Client({ name: 'bridge-test', version: '1' });
  await c.connect(t);
  const tools = (await c.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes('screenshot'));
  const docs = textOf(await call(c, 'list_documents', {}));
  assert.match(docs, /Landing/);
  await c.close();
});

test('signed-out visitors get the homepage; the app is installable', async () => {
  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Your agents design\./);
  assert.match(html, new RegExp(`${base.replace(/[.:/]/g, '\\$&')}/mcp`), 'connector URL uses this server');
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  for (const p of ['/sw.js', '/pwa.js', '/icons/apple-touch-icon.png', '/fonts/Geist-Variable.woff2', '/landing.css', '/tokens.css', '/offline.html']) {
    assert.equal((await fetch(`${base}${p}`)).status, 200, p);
  }
  for (const p of ['/../auth.json', '/fonts/../../auth.json', '/icons/..%2F..%2Fauth.json', '/app.ts']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
});

test('bundled fonts are served and listed for agents', async () => {
  const css = await fetch(`${base}/fonts.css`);
  assert.equal(css.status, 200);
  const rules = await css.text();
  assert.match(rules, /@font-face\{font-family:"Inter"/);
  assert.match(rules, /font-weight:700/);
  const file = /url\("(\/fonts\/inter\/700\.ttf\?v=[0-9a-f]{12})"\)/.exec(rules)?.[1];
  assert.ok(file, 'fonts.css points at a versioned Inter face');
  const ttf = await fetch(`${base}${file}`);
  assert.equal(ttf.status, 200);
  assert.equal(ttf.headers.get('content-type'), 'font/ttf');
  assert.match(ttf.headers.get('cache-control'), /immutable/, 'a versioned font URL is immutable');
  assert.ok((await ttf.arrayBuffer()).byteLength > 10_000, 'a real font binary, not an HTML error page');
  assert.equal((await fetch(`${base}/fonts/inter/does-not-exist.ttf`)).status, 404);

  const c = await connect(owner);
  const list = textOf(await call(c, 'list_fonts', {}));
  for (const family of ['Inter', 'Geist Mono', 'Playfair Display', 'JetBrains Mono']) assert.ok(list.includes(family), family);
  await c.close();
});

test('home screen thumbnails: a picture for designs, nothing for empty ones', async () => {
  const h = { authorization: `Bearer ${owner}`, 'content-type': 'application/json' };
  const empty = await (await fetch(`${base}/api/docs`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Blank' }) })).json();
  assert.equal((await fetch(`${base}/api/docs/${empty.id}/thumb.png`, { headers: h })).status, 204);
  const docs = await (await fetch(`${base}/api/docs`, { headers: h })).json();
  const full = docs.find((d) => d.name === 'Landing');
  const r = await fetch(`${base}/api/docs/${full.id}/thumb.png`, { headers: h });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/docs/${full.id}/thumb.png`)).status, 401, 'needs sign-in');
});

test('pages load versioned scripts and images, so a release never shows a cached old one', async () => {
  const login = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ token: owner }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  const js = /src="(\/app\.js\?v=[0-9a-f]{10})"/.exec(html)?.[1];
  assert.ok(js, 'editor page references a versioned app.js');
  const fixed = await fetch(`${base}${js}`);
  assert.match(fixed.headers.get('cache-control'), /immutable/);
  const plain = await fetch(`${base}/app.js`);
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  assert.equal(plain.headers.get('cdn-cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/sw.js`)).headers.get('cdn-cache-control'), 'no-store');
  // icons and screenshots too: a new icon must never hide behind a cached old one
  assert.match(html, /href="\/icons\/icon-192\.png\?v=[0-9a-f]{10}"/);
  const landing = await (await fetch(`${base}/`)).text();
  assert.match(landing, /src="\/shots\/review\.png\?v=[0-9a-f]{10}"/);
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.ok(manifest.icons.every((i) => /\?v=[0-9a-f]{10}$/.test(i.src)), 'manifest icons are versioned');
  const icon = await fetch(`${base}/icons/icon-192.png`);
  assert.equal(icon.headers.get('cdn-cache-control'), 'no-store', 'the CDN never keeps an unversioned icon');
});

test('text is measured with each family\'s real metrics, and missing fonts are reported', async () => {
  const c = await connect(owner);
  const doc = /d_[a-z0-9]+/.exec(textOf(await call(c, 'create_document', { name: 'Metrics' })))[0];
  const res = await call(c, 'create_nodes', {
    document: doc,
    nodes: [
      { type: 'text', id: 'light', text: 'Hamburgefonstiv', fontFamily: 'inter', fontWeight: 400, fontSize: 100 },
      { type: 'text', id: 'bold', text: 'Hamburgefonstiv', fontFamily: 'Inter', fontWeight: 800, fontSize: 100 },
      { type: 'text', id: 'mono', text: 'Hamburgefonstiv', fontFamily: 'JetBrains Mono', fontWeight: 400, fontSize: 100 },
    ],
  });
  const width = async (id) => JSON.parse(textOf(await call(c, 'get_node', { document: doc, id }))).box.w;
  const light = await width('light'), bold = await width('bold'), mono = await width('mono');
  assert.ok(bold > light, `weight 800 must be wider than 400 (${bold} vs ${light})`);
  assert.notEqual(mono, light, 'different families must not share Helvetica metrics');
  const node = JSON.parse(textOf(await call(c, 'get_node', { document: doc, id: 'light' }))).node;
  assert.equal(node.fontFamily, 'Inter', 'family names are normalized to the catalogue spelling');
  assert.ok(!textOf(res).includes('unknown font'));

  const warn = await call(c, 'create_nodes', { document: doc, nodes: [{ type: 'text', text: 'Hi', fontFamily: 'Comic Sans MS', fontSize: 14 }] });
  assert.match(textOf(warn), /unknown font: Comic Sans MS/);
  await c.close();
});

test('weight matching follows CSS, and italics without a face are reported', async () => {
  const c = await connect(owner);
  const doc = /d_[a-z0-9]+/.exec(textOf(await call(c, 'create_document', { name: 'Weights' })))[0];
  const node = (id, weight, italic = false) => ({ type: 'text', id, text: 'Hamburgefonstiv', fontFamily: 'Lato', fontWeight: weight, italic, fontSize: 100 });
  await call(c, 'create_nodes', { document: doc, nodes: [node('l300', 300), node('l400', 400), node('l350', 350), node('l450', 450), node('l700', 700), node('l800', 800), node('l900', 900)] });
  const width = async (id) => JSON.parse(textOf(await call(c, 'get_node', { document: doc, id }))).box.w;
  assert.equal(await width('l350'), await width('l300'), '350 resolves to 300 (lighter side first), not 400');
  assert.equal(await width('l450'), await width('l400'), '450 resolves to 400 (lighter side first), not 700');
  assert.notEqual(await width('l300'), await width('l400'));
  assert.equal(await width('l800'), await width('l900'), '800 resolves up to 900, not down to 700');
  assert.notEqual(await width('l800'), await width('l700'));

  const mono = await call(c, 'create_nodes', { document: doc, nodes: [{ type: 'text', text: 'Slanted?', fontFamily: 'Manrope', italic: true, fontSize: 20 }] });
  assert.match(textOf(mono), /no italic face for Manrope/);
  await c.close();
});

test('variables, components, states and bulk edits compose the way the docs say', async () => {
  const c = await connect(owner);
  const doc = /d_[a-z0-9]+/.exec(textOf(await call(c, 'create_document', { name: 'System' })))[0];
  await call(c, 'manage_variables', { document: doc, set: { paper: '#faf6ef', ink: '#1d1a15' } });

  await call(c, 'create_nodes', {
    document: doc,
    nodes: [{
      type: 'frame', id: 'btn', component: true, width: 'hug', height: 'hug', layout: 'row', padding: [8, 12], gap: 6, fill: 'var:ink',
      children: [{ type: 'text', id: 'btn-label', text: 'Save', fontSize: 14, color: '#ffffff' }],
      states: { hover: { 'btn-label': { color: 'var:paper' }, '@root': { fill: '#2a261f' } } },
    }],
  });
  await call(c, 'create_nodes', {
    document: doc,
    nodes: [
      { type: 'instance', id: 'b1', component: 'btn', overrides: { 'btn-label': { text: 'Publish' } } },
      { type: 'instance', id: 'b2', component: 'btn', state: 'hover' },
    ],
  });

  const svg = async (node) => textOf(await call(c, 'export', { document: doc, node, format: 'svg' }));
  assert.match(await svg('b1'), /Publish/, 'override replaces the component text');
  assert.match(await svg('b2'), /#faf6ef/, 'hover state uses the paper token');

  // an instance can switch state without touching the definition
  await call(c, 'update_nodes', { document: doc, updates: [{ id: 'b1', props: { state: 'hover' } }] });
  assert.match(await svg('b1'), /#2a261f/, 'instance picked the hover patch');
  await call(c, 'update_nodes', { document: doc, updates: [{ id: 'b1', props: { state: 'default' } }] });

  // editing the definition reaches every instance
  await call(c, 'update_nodes', { document: doc, updates: [{ id: 'btn-label', props: { text: 'Save changes' } }] });
  assert.match(await svg('b2'), /Save changes/);

  // tokens propagate without touching nodes
  await call(c, 'manage_variables', { document: doc, set: { paper: '#f2ece1' } });
  assert.match(await svg('b2'), /#f2ece1/);
  const tokens = textOf(await call(c, 'export_tokens', { document: doc }));
  assert.match(tokens, /--paper: #f2ece1;/);
  assert.match(tokens, /"\$value": "#f2ece1"/);

  // predicate edits and queries
  const found = textOf(await call(c, 'find_nodes', { document: doc, where: { type: 'text', text: { contains: 'changes' } } }));
  assert.match(found, /btn-label/);
  const bulk = textOf(await call(c, 'update_nodes', { document: doc, where: { fontSize: 14 }, props: { fontSize: 16 } }));
  assert.match(bulk, /updated 1 node/, 'one definition node matched');

  // several predicate edits land in one revision
  await call(c, 'manage_variables', { document: doc, set: { ink: '#1d1a15', paper: '#faf6ef' } });
  await call(c, 'create_nodes', { document: doc, nodes: [
    { type: 'rect', id: 'swatch-a', x: 700, y: 0, width: 40, height: 40, fill: '#1d1a15' },
    { type: 'rect', id: 'swatch-b', x: 750, y: 0, width: 40, height: 40, fill: '#faf6ef' },
  ] });
  const revA = Number(/rev (\d+)/.exec(textOf(await call(c, 'get_document', { document: doc })))[1]);
  const ruled = textOf(await call(c, 'update_nodes', { document: doc, rules: [
    { where: { fill: '#1d1a15' }, props: { fill: 'var:ink' } },
    { where: { fill: '#faf6ef' }, props: { fill: 'var:paper' } },
  ] }));
  const revB = Number(/rev (\d+)/.exec(textOf(await call(c, 'get_document', { document: doc })))[1]);
  assert.equal(revB, revA + 1, 'all rules share one revision');
  assert.match(ruled, /updated 2 nodes \(2 rules\)/);
  const stored = JSON.parse(textOf(await call(c, 'get_node', { document: doc, id: 'swatch-a' })));
  assert.equal(stored.node.fill, 'var:ink');
  assert.equal(stored.computed.fill, '#1d1a15');

  // a token in use cannot be deleted by accident
  await assert.rejects(
    () => call(c, 'manage_variables', { document: doc, unset: ['ink'] }),
    /referenced by \d+ node/,
    'unsetting a live token is refused',
  );
  await call(c, 'manage_variables', { document: doc, unset: ['ink'], force: true });
  const orphans = textOf(await call(c, 'find_nodes', { document: doc, where: { fill: 'var:ink' } }));
  assert.match(orphans, /swatch-a/, 'the reference survives as a literal when forced');

  // dry runs report problems and never write
  const revBefore = Number(/rev (\d+)/.exec(textOf(await call(c, 'get_document', { document: doc })))[1]);
  const dry = textOf(await call(c, 'create_nodes', { document: doc, dry_run: true, nodes: [{ type: 'text', text: 'x', strokeWidth: null }] }));
  assert.match(dry, /would fail/);
  assert.match(dry, /strokeWidth/);
  const revAfter = Number(/rev (\d+)/.exec(textOf(await call(c, 'get_document', { document: doc })))[1]);
  assert.equal(revAfter, revBefore, 'a dry run does not create a revision');

  // contrast is checked against the real backdrop
  await call(c, 'create_nodes', { document: doc, nodes: [{
    type: 'frame', id: 'card', width: 240, height: 'hug', layout: 'column', padding: 12, fill: '#f1ede6',
    children: [{ type: 'text', id: 'muted', text: 'Low contrast sample', fontSize: 12, color: '#cfc9bd' }],
  }] });
  const audit = textOf(await call(c, 'audit_contrast', { document: doc }));
  assert.match(audit, /muted/);
  assert.match(audit, /1\.4\d:1/);
  assert.match(audit, /needs 4\.5:1/);

  // a gradient backdrop is judged by its worst stop, not mistaken for the page background
  await call(c, 'create_nodes', { document: doc, nodes: [
    { type: 'frame', id: 'lock', width: 300, height: 200, fill: [{ type: 'radial', stops: [{ offset: 0, color: '#1d3a7a' }, { offset: 1, color: '#0a1630' }] }],
      children: [{ type: 'text', id: 'hello', text: 'Welcome back', fontSize: 20, color: '#ffffff' }] },
    { type: 'frame', id: 'paper-white', width: 200, height: 80, fill: '#ffffff',
      children: [{ type: 'text', id: 'ghost', text: 'Invisible', fontSize: 12, color: '#ffffff' }] },
  ] });
  const audit2 = textOf(await call(c, 'audit_contrast', { document: doc }));
  assert.doesNotMatch(audit2, /hello/, 'white on a navy gradient passes');
  assert.match(audit2, /ghost .*1\.00:1/, 'white on white is still a failure');
  assert.match(audit2, /on 1 of 1 page/, 'failures are grouped by page');
  assert.match(audit2, /page "Page 1" id=p_/, 'each group names its page');

  // translucent text is judged as painted, not as its nominal colour
  await call(c, 'create_nodes', { document: doc, nodes: [{ type: 'text', id: 'faded', text: 'Faded label', fontSize: 13, color: 'rgba(0,0,0,0.35)' }] });
  const audit3 = textOf(await call(c, 'audit_contrast', { document: doc }));
  assert.match(audit3, /faded .*needs 4\.5:1/, 'a 35% black label on white is a failure');

  // a sibling painted underneath the text is part of the backdrop
  await call(c, 'create_nodes', { document: doc, nodes: [
    { type: 'rect', id: 'behind-card', x: 600, y: 600, width: 220, height: 90, fill: '#f1ede6' },
    { type: 'text', id: 'over-card', x: 616, y: 620, text: 'Sits on the card', fontSize: 12, color: '#cfc9bd' },
  ] });
  const audit5 = textOf(await call(c, 'audit_contrast', { document: doc }));
  assert.match(audit5, /over-card .*#f1ede6/, 'the sibling card, not the page, is the backdrop');
  assert.match(audit5, /over-card .*1\.4\d:1/);

  // an icon behind text makes the backdrop unknowable, which is reported rather than guessed
  await call(c, 'create_nodes', { document: doc, nodes: [
    { type: 'svg', id: 'gauge', x: 600, y: 760, width: 40, height: 40, color: '#1d1a15', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3"/></svg>' },
    { type: 'text', id: 'over-gauge', x: 606, y: 770, text: '42%', fontSize: 12, color: '#cfc9bd' },
  ] });
  const audit6 = textOf(await call(c, 'audit_contrast', { document: doc }));
  assert.doesNotMatch(audit6, /over-gauge/, 'no ratio is invented for text over an icon');
  assert.match(audit6, /sits on an image|sit on an image/);

  // a disabled control is exempt from 1.4.3, and says so in the audit and the export
  await call(c, 'create_nodes', { document: doc, nodes: [{ type: 'frame', id: 'inactive-tab', disabled: true, role: 'tab', label: 'Items', width: 'hug', layout: 'row', gap: 4,
    children: [{ type: 'text', text: 'Items', fontSize: 12, color: '#dad4c7' }] }] });
  const audit4 = textOf(await call(c, 'audit_contrast', { document: doc }));
  assert.doesNotMatch(audit4, /"Items"/, 'disabled text is not reported as a failure');
  assert.match(audit4, /exempt from 1\.4\.3/);
  const html = textOf(await call(c, 'export', { document: doc, node: 'inactive-tab', format: 'html' }));
  assert.match(html, /aria-disabled="true"/);

  // truncation ends the visible text with an ellipsis
  await call(c, 'create_nodes', { document: doc, nodes: [{ type: 'text', id: 'tip', text: 'A tooltip that is far too long for the space it was given', width: 90, wrap: 'truncate', fontSize: 13 }] });
  assert.match(await svg('tip'), /…/);
  await c.close();
});
