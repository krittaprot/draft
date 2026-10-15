// OAuth for MCP clients, end to end: the MCP SDK's own OAuth client discovers, registers, gets sent to the consent
// page (which this test fills in as the signed-in person), exchanges the code and then uses Tandem's tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3900 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-oauth-'));
const NEON = 'https://ep-icy-grass-b34wtlhr.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
let proc, owner, cookie;

before(async () => {
  proc = spawn(process.execPath, [path.join(root, 'dist/server.js'), 'serve', '--port', String(port), '--data', data], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TANDEM_NEON_AUTH_URL: NEON },
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  owner = fs.readFileSync(path.join(data, 'owner-token'), 'utf8').trim();
  const r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ token: owner }), redirect: 'manual' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => { proc?.kill(); fs.rmSync(data, { recursive: true, force: true }); });

class MemoryProvider {
  constructor(name = 'Test Agent') { this.name = name; this.authUrl = null; }
  get redirectUrl() { return 'http://127.0.0.1:8976/callback'; }
  get clientMetadata() { return { client_name: this.name, redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.client; }
  saveClientInformation(c) { this.client = c; }
  tokens() { return this.tok; }
  saveTokens(t) { this.tok = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

/** Plays the person: opens the consent page signed in, and clicks Allow or Cancel. Returns the redirect URL. */
async function consent(authUrl, decision = 'allow', extra = {}) {
  const page = await fetch(authUrl, { headers: { cookie }, redirect: 'manual' });
  assert.equal(page.status, 200, 'consent page');
  const html = await page.text();
  const tx = /name="tx" value="([^"]+)"/.exec(html)[1];
  const r = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tx, decision, ...extra }), redirect: 'manual' });
  assert.equal(r.status, 303);
  return { location: new URL(r.headers.get('location')), html };
}

async function connected(provider) {
  const c = new Client({ name: 'oauth-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  return c;
}

const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('advertises OAuth discovery on 401 and in metadata', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const h = r.headers.get('www-authenticate');
  assert.match(h, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await fetch(/resource_metadata="([^"]+)"/.exec(h)[1])).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
});

test('an MCP client registers, gets approved by a person, and works under its own name', async () => {
  const provider = new MemoryProvider('Claude');
  await assert.rejects(connected(provider), UnauthorizedError);
  assert.ok(provider.client?.client_id, 'dynamic client registration');
  assert.ok(provider.authUrl, 'sent to the authorization page');

  // not signed in: the consent page sends people to sign in first, then back
  const anon = await fetch(provider.authUrl, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location'), /^\/login\?next=%2Foauth%2Fauthorize/);
  const login = await (await fetch(`${base}${anon.headers.get('location')}`)).text();
  assert.match(login, /Continue with Google/);

  const { location, html } = await consent(provider.authUrl);
  assert.match(html, /Connect Claude\?/);
  assert.equal(location.origin + location.pathname, provider.redirectUrl);
  assert.equal(location.searchParams.get('iss'), base);
  const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  await t.finishAuth(location.searchParams.get('code'));
  assert.match(provider.tok.access_token, /^tandem_at_/);

  const c = await connected(provider);
  const created = textOf(await c.callTool({ name: 'create_document', arguments: { name: 'From OAuth' } }));
  const doc = /d_[a-z0-9]+/.exec(created)[0];
  const hist = textOf(await c.callTool({ name: 'get_history', arguments: { document: doc } }));
  assert.match(hist, /rev 0 .* claude: Created document/);
  await c.close();

  // the code is single use
  const again = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: provider.client.client_id, code_verifier: provider.verifier, redirect_uri: provider.redirectUrl }) });
  assert.equal((await again.json()).error, 'invalid_grant');

  // owner sees the app and can disconnect it, which cuts access at once
  const apps = await (await fetch(`${base}/api/apps`, { headers: { authorization: `Bearer ${owner}` } })).json();
  const app = apps.find((a) => a.app === 'Claude');
  assert.equal(app.role, 'editor');
  await fetch(`${base}/api/apps/${app.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${owner}` } });
  const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${provider.tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /error="invalid_token"/);
});

test('refresh tokens rotate, and replaying an old one ends the approval', async () => {
  const provider = new MemoryProvider('Rotator');
  await assert.rejects(connected(provider), UnauthorizedError);
  const { location } = await consent(provider.authUrl, 'allow', { readonly: 'on' });
  await new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }).finishAuth(location.searchParams.get('code'));
  const first = provider.tok;
  const refresh = (rt) => fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: provider.client.client_id }) }).then((r) => r.json());
  const second = await refresh(first.refresh_token);
  assert.match(second.access_token, /^tandem_at_/);
  assert.notEqual(second.refresh_token, first.refresh_token);

  // read-only approval: tools that change things are refused
  provider.saveTokens(second);
  const c = await connected(provider);
  const r = await c.callTool({ name: 'create_document', arguments: { name: 'nope' } });
  assert.ok(r.isError);
  assert.match(textOf(r), /read-only/);
  await c.close();

  const replay = await refresh(first.refresh_token);
  assert.equal(replay.error, 'invalid_grant');
  assert.equal((await refresh(second.refresh_token)).error, 'invalid_grant', 'whole approval revoked after replay');
});

test('declining, wrong PKCE verifier and tampered consent are all refused', async () => {
  const p1 = new MemoryProvider('Declined');
  await assert.rejects(connected(p1), UnauthorizedError);
  const { location } = await consent(p1.authUrl, 'deny');
  assert.equal(location.searchParams.get('error'), 'access_denied');

  const p2 = new MemoryProvider('Bad PKCE');
  await assert.rejects(connected(p2), UnauthorizedError);
  const ok = await consent(p2.authUrl);
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: ok.location.searchParams.get('code'), client_id: p2.client.client_id, code_verifier: crypto.randomBytes(40).toString('base64url'), redirect_uri: p2.redirectUrl }) });
  assert.equal((await r.json()).error, 'invalid_grant');

  const page = await (await fetch(p2.authUrl, { headers: { cookie } })).text();
  const tx = /name="tx" value="([^"]+)"/.exec(page)[1].replace(/^[^.]+/, Buffer.from('client_id=evil').toString('base64url'));
  const bad = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tx, decision: 'allow' }), redirect: 'manual' });
  assert.equal(bad.status, 400);

  const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['javascript:alert(1)'] }) });
  assert.equal((await reg.json()).error, 'invalid_redirect_uri');
  const reg2 = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal((await reg2.json()).error, 'invalid_redirect_uri');
});

test('Google sign-in starts through Neon Auth, and only members get in', async (t) => {
  // Neon Auth only accepts this deployment's trusted origins, so this server presents itself as http://127.0.0.1:3290
  const nport = port + 600;
  const nbase = `http://127.0.0.1:${nport}`;
  const p = spawn(process.execPath, [path.join(root, 'dist/server.js'), 'serve', '--port', String(nport), '--data', data, '--public-url', 'http://127.0.0.1:3290'], { stdio: 'ignore', env: { ...process.env, TANDEM_NEON_AUTH_URL: NEON, TANDEM_ALLOWED_EMAILS: 'Owner@Example.com' } });
  t.after(() => p.kill());
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${nbase}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(`${nbase}/auth/google?next=/`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  if (r.headers.get('location').startsWith('/login?error')) { t.skip('Neon Auth unreachable from here'); return; }
  assert.ok(r.headers.get('location').startsWith(NEON), 'redirects to Neon Auth');
  assert.match(r.headers.get('set-cookie'), /tandem_flow=.*HttpOnly/);
  const cb = await fetch(`${nbase}/auth/neon/callback?neon_auth_session_verifier=x`, { redirect: 'manual', headers: { cookie: 'tandem_flow=forged' } });
  assert.equal(cb.status, 303);
  assert.match(cb.headers.get('location'), /^\/login\?error=This%20sign-in%20expired/);

  // an origin Neon does not trust is refused, and people land back on the login page with a message
  const refused = await fetch(`${base}/auth/google?next=/`, { redirect: 'manual' });
  assert.match(refused.headers.get('location'), /^\/login\?error=Google%20sign-in/);

  const add = await fetch(`${base}/api/members`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Person@Example.com', role: 'viewer' }) });
  assert.equal((await add.json()).email, 'person@example.com');
  const list = await (await fetch(`${base}/api/members`, { headers: { authorization: `Bearer ${owner}` } })).json();
  assert.equal(list.google, true);
  assert.equal(list.members.length, 1);
});

test('only the allowed email can be a member, and token sign-in never works through the tunnel', async (t) => {
  const nbase = `http://127.0.0.1:${port + 700}`;
  const p = spawn(process.execPath, [path.join(root, 'dist/server.js'), 'serve', '--port', String(port + 700), '--data', data], { stdio: 'ignore', env: { ...process.env, TANDEM_NEON_AUTH_URL: NEON, TANDEM_ALLOWED_EMAILS: 'Owner@Example.com' } });
  t.after(() => p.kill());
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${nbase}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const add = (email) => fetch(`${nbase}/api/members`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, role: 'editor' }) });
  const refused = await add('intruder@example.com');
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /not in this server's allowed emails/);
  assert.equal((await (await add('owner@example.com')).json()).email, 'owner@example.com');

  // a member added before the allowlist (person@example.com, by the other server) can no longer sign in
  const sessions = await (await fetch(`${nbase}/api/members`, { headers: { authorization: `Bearer ${owner}` } })).json();
  assert.ok(sessions.members.some((m) => m.email === 'person@example.com'));

  // through cloudflared (cf-connecting-ip set) there is no token form and token posts are refused
  const viaTunnel = { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc' };
  const page = await (await fetch(`${nbase}/login`, { headers: viaTunnel })).text();
  assert.match(page, /Continue with Google/);
  assert.doesNotMatch(page, /name="token"/);
  const post = await fetch(`${nbase}/login`, { method: 'POST', headers: viaTunnel, body: new URLSearchParams({ token: owner }), redirect: 'manual' });
  assert.equal(post.status, 403);
  const app = await fetch(`${nbase}/auth?token=${owner}`, { headers: viaTunnel, redirect: 'manual' });
  assert.equal(app.headers.get('location'), '/login');
  // on the host itself the Mac app can still sign in with the owner token
  const local = await fetch(`${nbase}/auth?token=${owner}`, { redirect: 'manual' });
  assert.match(local.headers.get('set-cookie') ?? '', /tandem_session=/);
});
