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

test('agent designs a screen, sees it, and the history records it', async () => {
  const c = await connect(owner);
  const tools = (await c.listTools()).tools.map((t) => t.name);
  for (const t of ['create_document', 'create_nodes', 'update_nodes', 'screenshot', 'list_comments', 'get_history', 'export']) assert.ok(tools.includes(t), t);
  assert.match(c.getInstructions() ?? '', /shared design canvas/);

  const created = textOf(await call(c, 'create_document', { name: 'Landing' }));
  const doc = /d_[a-z0-9]+/.exec(created)[0];

  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>';
  const feature = (id, title) => ({
    type: 'frame', id, layout: 'column', gap: 8, padding: 24, width: 'fill', fill: '#ffffff', radius: 16,
    shadows: [{ x: 0, y: 8, blur: 24, color: 'rgba(15,23,42,0.08)' }],
    children: [
      { type: 'svg', svg: icon, width: 28, height: 28, color: '#2563eb' },
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
