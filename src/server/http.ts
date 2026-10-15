// HTTP server: MCP endpoint (/mcp), editor API (/api/*), live updates (SSE), login, signed screenshot links.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { newId } from '../shared/model.ts';
import { buildMcpServer, VERSION } from './mcp.ts';
import { OpError, type Op } from './ops.ts';
import type { Engine } from './engine.ts';
import type { Principal, Role } from './auth.ts';
import type { ChangeEvent, Comment } from './store.ts';
import { OAuth, OAuthError, appName as appNameFor } from './oauth.ts';
import type { NeonLogin } from './neon.ts';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', woff2: 'font/woff2',
  webmanifest: 'application/manifest+json', html: 'text/html; charset=utf-8',
};
// public files of the web build: top-level assets plus fonts/, icons/ and shots/ (no other folders, no traversal)
const PUBLIC_FILE = /^\/(?:(?:fonts|icons|shots)\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(js|css|png|woff2|webmanifest)$/;
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const MAX_BODY = 20 * 1024 * 1024;

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}) {
  const data = Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(data);
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PAGE = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><link rel="icon" href="/icons/icon-192.png"><link rel="stylesheet" href="/style.css"></head><body class="login">${body}</body></html>`;

const GOOGLE_ICON = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z"/><path fill="#FBBC05" d="M10.6 28.6A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

const LOGIN_PAGE = (opts: { error?: string; next?: string; google?: boolean; tokens?: boolean } = {}) => PAGE('Draft · Sign in', `<form method="post" action="/login"><img src="/icons/icon-192.png" width="56" height="56" alt=""><h1>Draft</h1>
${opts.error ? `<p class="error">${escHtml(opts.error)}</p>` : ''}
${opts.google ? `<a class="google" href="/auth/google?next=${encodeURIComponent(opts.next ?? '/')}">${GOOGLE_ICON}<span>Continue with Google</span></a>` : ''}
${opts.tokens ? `${opts.google ? '<div class="or"><span>or use an access token</span></div>' : '<p>Paste an access token. Run <code>tandem token create &lt;name&gt;</code> on the host to make one.</p>'}
<input type="hidden" name="next" value="${escHtml(opts.next ?? '/')}"><input name="token" type="password" placeholder="tandem_…" autocomplete="current-password" ${opts.google ? '' : 'autofocus'} required><button>Sign in</button>` : ''}
${!opts.tokens && !opts.google ? '<p>Sign-in is turned off on this server.</p>' : ''}</form>`);

/** Only same-site paths may be used as a post-login destination. */
function safeNext(n: string | null | undefined): string {
  return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-max-age': '86400' };

export function createHttpServer(engine: Engine, opts: { trustProxy: boolean; neon?: NeonLogin; tokenLogin?: 'on' | 'local' | 'off' }) {
  const { store, auth } = engine;
  const oauth = new OAuth(store.dir, engine.publicUrl);
  auth.oauthVerify = (t) => oauth.verifyAccess(t);
  const metaUrl = `${engine.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const sse = new Set<http.ServerResponse>();
  store.on('change', (e: ChangeEvent) => {
    const msg = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of sse) res.write(msg);
  });
  setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 25_000).unref();

  const allowedOrigins = new Set([new URL(engine.publicUrl).origin]);

  const clientIp = (req: http.IncomingMessage) => {
    const sock = req.socket.remoteAddress ?? '';
    const local = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    // cloudflared connects from localhost and passes the real client address along
    if (opts.trustProxy && local) return String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? sock).split(',')[0].trim();
    return sock;
  };
  /** A request made on this machine itself, not relayed by cloudflared or another proxy. */
  const directLocal = (req: http.IncomingMessage) => {
    const sock = req.socket.remoteAddress ?? '';
    const loop = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    return loop && !req.headers['cf-connecting-ip'] && !req.headers['cf-ray'] && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
  };
  const tokenLoginOk = (req: http.IncomingMessage) => (opts.tokenLogin ?? 'on') === 'on' || (opts.tokenLogin === 'local' && directLocal(req));
  // Secure cookies only when this request really came over https (cloudflared sets x-forwarded-proto)
  const secure = (req: http.IncomingMessage) => req.headers['x-forwarded-proto'] === 'https';
  const setSession = (req: http.IncomingMessage, res: http.ServerResponse, p: Principal) => {
    res.setHeader('set-cookie', `tandem_session=${auth.session(p)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure(req) ? '; Secure' : ''}`);
  };

  const bearer = (req: http.IncomingMessage) => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
  };

  /** Browser requests authenticate with the session cookie; scripts may use a bearer token. */
  const principal = (req: http.IncomingMessage): { p: Principal; viaCookie: boolean } => {
    const tok = bearer(req);
    if (tok) {
      const p = auth.verify(tok, clientIp(req));
      if (!p) throw new HttpError(401, 'invalid token');
      return { p, viaCookie: false };
    }
    const p = auth.verifySession(cookies(req).tandem_session);
    if (!p) throw new HttpError(401, 'sign in required');
    return { p, viaCookie: true };
  };

  const need = (p: Principal, role: Role) => {
    const rank = { viewer: 0, editor: 1, owner: 2 };
    if (rank[p.role] < rank[role]) throw new HttpError(403, `requires ${role} access`);
  };

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new HttpError(403, 'origin not allowed');
    const tok = bearer(req);
    const p = tok ? auth.verify(tok, clientIp(req)) : null;
    if (!p) {
      // points OAuth-capable clients at discovery (MCP authorization spec); token users see the hint
      const challenge = `Bearer resource_metadata="${metaUrl}", scope="tandem"${tok ? ', error="invalid_token"' : ''}`;
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': challenge, ...CORS, 'access-control-expose-headers': 'www-authenticate' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing or invalid bearer token. Sign in with OAuth, or create a token with: tandem token create <name>' }, id: null }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readJson(req);
    const server = buildMcpServer(engine, p);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleOAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const pth = url.pathname;
    const fail = (e: unknown, cors = true) => {
      const err = e instanceof OAuthError ? e : new OAuthError('server_error', 'unexpected error', 500);
      if (!(e instanceof OAuthError)) console.error(e);
      return send(res, err.status, { error: err.code, error_description: err.message }, 'application/json', cors ? CORS : {});
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

    if (pth === '/oauth/register' && req.method === 'POST') {
      try { return send(res, 201, oauth.register(await readJson(req), clientIp(req)), 'application/json', CORS); } catch (e) { return fail(e); }
    }
    if (pth === '/oauth/token' && req.method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      const form = String(req.headers['content-type'] ?? '').includes('json') ? new URLSearchParams(JSON.parse(raw || '{}')) : new URLSearchParams(raw);
      try { return send(res, 200, oauth.token(form), 'application/json', { ...CORS, pragma: 'no-cache' }); } catch (e) { return fail(e); }
    }
    if (pth === '/oauth/revoke' && req.method === 'POST') {
      oauth.revokeToken(new URLSearchParams((await readBody(req)).toString('utf8')).get('token') ?? '');
      return send(res, 200, {}, 'application/json', CORS);
    }
    if (pth === '/oauth/authorize') {
      const page = (title: string, body: string, status = 200) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
        res.end(PAGE(title, body));
      };
      const errorPage = (msg: string) => page('Draft · Connect', `<form><img src="/icons/icon-192.png" width="56" height="56" alt=""><h1>Can't connect this app</h1><p class="error">${escHtml(msg)}</p></form>`, 400);
      const redirect = (to: string) => { res.writeHead(303, { location: to }).end(); };

      const isPost = req.method === 'POST';
      const form = isPost ? new URLSearchParams((await readBody(req)).toString('utf8')) : null;
      let qs = url.search.slice(1);
      const who = auth.verifySession(cookies(req).tandem_session);
      if (isPost) {
        // the consent form carries the original request, signed and bound to the person who saw it
        const [encoded, exp, sig] = (form!.get('tx') ?? '').split('.');
        qs = Buffer.from(encoded ?? '', 'base64url').toString();
        if (!who || !sig || Number(exp) < Date.now() || !auth.verifySigned('consent', `${who.name}|${who.email ?? ''}|${qs}|${exp}`, sig)) {
          return errorPage('This approval page expired. Go back to the app and connect again.');
        }
      }
      let areq;
      try { areq = oauth.parseAuthorize(new URLSearchParams(qs)); } catch (e) {
        const r = (e as { redirect?: { redirectUri: string; state?: string } }).redirect;
        if (e instanceof OAuthError && r) {
          try { return redirect(oauth.redirectWith(r.redirectUri, { error: e.code, error_description: e.message, state: r.state })); } catch { /* fall through */ }
        }
        return errorPage(e instanceof Error ? e.message : String(e));
      }
      if (!who) return redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
      if (isPost) {
        if (form!.get('decision') !== 'allow') return redirect(oauth.redirectWith(areq.redirectUri, { error: 'access_denied', error_description: 'The person declined.', state: areq.state }));
        return redirect(oauth.approve(areq, who, form!.get('readonly') === 'on'));
      }
      const exp = String(Date.now() + 10 * 60_000);
      const tx = `${Buffer.from(qs).toString('base64url')}.${exp}.${auth.sign('consent', `${who.name}|${who.email ?? ''}|${qs}|${exp}`)}`;
      let host = areq.redirectUri;
      try { host = new URL(areq.redirectUri).host || areq.redirectUri; } catch { /* keep */ }
      const viewerOnly = who.role === 'viewer';
      return page('Draft · Connect', `<form method="post" action="/oauth/authorize" class="consent"><img src="/icons/icon-192.png" width="56" height="56" alt="">
<h1>Connect ${escHtml(areq.client.client_name)}?</h1>
<p><b>${escHtml(areq.client.client_name)}</b> wants to use your Draft designs. Its changes will show up as <b>${escHtml(appNameFor(areq.client.client_name))}</b> in the history.</p>
<p class="meta">After you approve, you go back to <b>${escHtml(host)}</b>. You can disconnect it any time under Connect agent.</p>
<label class="check"><input type="checkbox" name="readonly" ${viewerOnly ? 'checked disabled' : ''}> View only (it can look and take screenshots, but not edit)</label>
<p class="meta">Signed in as ${escHtml(who.email ?? who.name)}</p>
<input type="hidden" name="tx" value="${escHtml(tx)}">
<div class="row"><button name="decision" value="deny" class="secondary">Cancel</button><button name="decision" value="allow">Allow</button></div></form>`);
    }
    return fail(new OAuthError('not_found', 'not found', 404));
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const { p, viaCookie } = principal(req);
    const method = req.method ?? 'GET';
    // cookie-authenticated writes must come from the editor itself (custom header forces a CORS preflight)
    if (viaCookie && method !== 'GET' && req.headers['x-tandem'] !== '1') throw new HttpError(403, 'missing X-Tandem header');
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const q = url.searchParams;
    const json = (b: unknown, s = 200) => send(res, s, b);

    if (parts[0] === 'me') return json({ name: p.name, role: p.role, version: VERSION, publicUrl: engine.publicUrl });

    if (parts[0] === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }

    if (parts[0] === 'members') {
      need(p, 'owner');
      if (method === 'GET') return json({ members: auth.members(), google: !!opts.neon });
      if (method === 'POST') {
        const b = await readJson(req);
        const role = (['editor', 'viewer', 'owner'] as Role[]).includes(b.role as Role) ? (b.role as Role) : 'editor';
        try { return json(auth.addMember(String(b.email ?? ''), role, b.name ? String(b.name) : undefined)); } catch (e) { throw new HttpError(400, (e as Error).message); }
      }
      if (method === 'DELETE' && parts[1]) { auth.removeMember(decodeURIComponent(parts[1])); return json({ ok: true }); }
    }

    if (parts[0] === 'apps') {
      need(p, 'owner');
      if (method === 'GET') return json(oauth.listGrants());
      if (method === 'DELETE' && parts[1]) { oauth.revokeGrant(parts[1]); return json({ ok: true }); }
    }

    if (parts[0] === 'tokens') {
      need(p, 'owner');
      if (method === 'GET') return json(auth.list());
      if (method === 'POST') {
        const b = await readJson(req);
        const role = (['editor', 'viewer', 'owner'] as Role[]).includes(b.role as Role) ? (b.role as Role) : 'editor';
        return json({ token: auth.create(String(b.name ?? ''), role) });
      }
      if (method === 'DELETE' && parts[1]) { auth.revoke(parts[1]); return json({ ok: true }); }
    }

    if (parts[0] === 'assets' && method === 'POST') {
      need(p, 'editor');
      const buf = await readBody(req);
      return json({ id: store.putAsset(buf, String(req.headers['content-type'] ?? '').split(';')[0]) });
    }

    if (parts[0] === 'docs') {
      if (parts.length === 1) {
        if (method === 'GET') return json(store.listDocs());
        if (method === 'POST') { need(p, 'editor'); const b = await readJson(req); return json(store.createDoc(String(b.name ?? 'Untitled'), p.name)); }
      }
      const id = parts[1];
      if (!store.exists(id)) throw new HttpError(404, 'document not found');
      const sub = parts[2];
      const rev = q.has('rev') ? Number(q.get('rev')) : undefined;

      if (!sub) {
        if (method === 'GET') return json(engine.getDoc(id, rev));
        if (method === 'DELETE') { need(p, 'editor'); store.deleteDoc(id); return json({ ok: true }); }
      }
      if (sub === 'ops' && method === 'POST') {
        need(p, 'editor');
        const b = await readJson(req);
        const r = await engine.apply(id, b.ops as Op[], p.name, String(b.message ?? 'Edit'));
        return json(r);
      }
      if (sub === 'history') return json(store.history(id, Number(q.get('limit') ?? 100), q.has('before') ? Number(q.get('before')) : undefined));
      if (sub === 'restore' && method === 'POST') {
        need(p, 'editor');
        const b = await readJson(req);
        return json(store.restore(id, Number(b.rev), p.name));
      }
      if (sub === 'thumb.png') {
        // small preview of the first page for the home screen; 204 when the page is still empty
        const doc = engine.getDoc(id);
        try {
          const shot = engine.renderPNG(doc, { pageId: doc.pages[0].id, maxSide: 640, padding: 32 });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' });
          return res.end(shot.png);
        } catch (e) {
          if (e instanceof OpError) { res.writeHead(204).end(); return; }
          throw e;
        }
      }
      if (sub === 'render.png') {
        const shot = engine.renderPNG(engine.getDoc(id, rev), { nodeId: q.get('node') ?? undefined, pageId: q.get('page') ?? undefined, scale: q.has('scale') ? Number(q.get('scale')) : 2 });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', ...(q.has('download') ? { 'content-disposition': `attachment; filename="${(q.get('node') ?? 'page').replace(/[^\w-]/g, '')}.png"` } : {}) });
        return res.end(shot.png);
      }
      if (sub === 'export') {
        const doc = engine.getDoc(id, rev);
        const node = q.get('node') ?? '';
        if (q.get('format') === 'svg') return send(res, 200, engine.renderSVG(doc, { nodeId: node }).svg, 'text/plain; charset=utf-8');
        return send(res, 200, engine.exportHTML(doc, node), 'text/plain; charset=utf-8');
      }
      if (sub === 'share') {
        const doc = engine.getDoc(id);
        const node = q.get('node');
        return json({ url: engine.screenshotLink(id, doc.rev, node ?? `page:${q.get('page') ?? doc.pages[0].id}`) });
      }
      if (sub === 'comments') {
        const list = store.comments(id);
        if (method === 'GET' && !parts[3]) return json(list);
        need(p, 'editor');
        const b = await readJson(req);
        if (method === 'POST' && !parts[3]) {
          const c: Comment = {
            id: newId('c'), pageId: String(b.pageId), nodeId: b.nodeId ? String(b.nodeId) : undefined,
            x: Number(b.x) || 0, y: Number(b.y) || 0, author: p.name, text: String(b.text ?? '').slice(0, 5000),
            time: new Date().toISOString(), resolved: false, replies: [],
          };
          if (!c.text) throw new HttpError(400, 'comment text required');
          store.saveComments(id, [...list, c]);
          return json(c);
        }
        const c = list.find((x) => x.id === parts[3]);
        if (!c) throw new HttpError(404, 'comment not found');
        if (method === 'DELETE') { store.saveComments(id, list.filter((x) => x !== c)); return json({ ok: true }); }
        if (method === 'POST') {
          if (typeof b.reply === 'string' && b.reply.trim()) c.replies.push({ id: newId('r'), author: p.name, text: b.reply.slice(0, 5000), time: new Date().toISOString() });
          if (typeof b.resolved === 'boolean') c.resolved = b.resolved;
          store.saveComments(id, list);
          return json(c);
        }
      }
    }
    throw new HttpError(404, 'not found');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const pth = url.pathname;
      if (pth === '/healthz') return send(res, 200, { ok: true, name: 'tandem', version: VERSION });
      if (pth === '/mcp' || pth === '/mcp/') return await handleMcp(req, res);
      if (pth.startsWith('/api/')) return await handleApi(req, res, url);

      if (opts.neon && req.method === 'GET' && url.searchParams.has('neon_auth_session_verifier') && pth !== '/auth/neon/callback') {
        console.log(`[auth] verifier arrived at ${pth}; forwarding to the callback`);
        res.writeHead(303, { location: `/auth/neon/callback${url.search}` }).end();
        return;
      }

      if (pth === '/login') {
        const google = !!opts.neon;
        const tokens = tokenLoginOk(req);
        if (req.method === 'POST') {
          if (!tokens) return send(res, 403, LOGIN_PAGE({ error: 'Signing in with a token is only allowed on the host itself. Use Google.', google }), 'text/html');
          const form = new URLSearchParams((await readBody(req)).toString('utf8'));
          const next = safeNext(form.get('next'));
          const tok = form.get('token') ?? '';
          const p = tok.startsWith('tandem_at_') ? null : auth.verify(tok, clientIp(req));
          if (!p) return send(res, 401, LOGIN_PAGE({ error: auth.blocked(clientIp(req)) ? 'Too many attempts. Try again in 10 minutes.' : 'That token is not valid.', next, google, tokens }), 'text/html');
          setSession(req, res, p);
          res.writeHead(303, { location: next }).end();
          return;
        }
        return send(res, 200, LOGIN_PAGE({ next: safeNext(url.searchParams.get('next')), google, tokens, error: url.searchParams.get('error') ?? undefined }), 'text/html');
      }

      if (pth === '/auth/google' && opts.neon) {
        const next = safeNext(url.searchParams.get('next'));
        let flowId: string, to: string;
        try { ({ flowId, url: to } = await opts.neon.start(next)); } catch (e) {
          console.error(e);
          res.writeHead(303, { location: `/login?error=${encodeURIComponent("Google sign-in isn't available right now. Use an access token, or try again later.")}&next=${encodeURIComponent(next)}` }).end();
          return;
        }
        console.log(`[auth] google sign-in started (next ${next})`);
        res.writeHead(303, { location: to, 'set-cookie': `tandem_flow=${flowId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure(req) ? '; Secure' : ''}` }).end();
        return;
      }
      if (pth === '/auth/neon/callback' && opts.neon) {
        const clear = 'tandem_flow=; Path=/; Max-Age=0';
        console.log(`[auth] google callback: flow cookie ${cookies(req).tandem_flow ? 'present' : 'missing'}, verifier ${url.searchParams.has('neon_auth_session_verifier') ? 'present' : 'missing'}${url.searchParams.get('error') ? `, error ${url.searchParams.get('error')}` : ''}`);
        const back = (msg: string, next = '/') => res.writeHead(303, { location: `/login?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`, 'set-cookie': clear }).end();
        let result;
        try { result = await opts.neon.finish(cookies(req).tandem_flow, url.searchParams.get('neon_auth_session_verifier')); } catch (e) { console.log(`[auth] google callback failed: ${(e as Error).message}`); back((e as Error).message); return; }
        const p = auth.memberLogin(result.user.email);
        console.log(`[auth] google sign-in ${p ? 'accepted' : 'refused'} for ${result.user.email}`);
        if (!p) { back(`${result.user.email} can't sign in to this Draft.`, result.next); return; }
        res.setHeader('set-cookie', [clear]);
        setSession(req, res, p);
        res.writeHead(303, { location: result.next }).end();
        return;
      }

      // ---------- OAuth for MCP clients ----------
      if (pth.startsWith('/.well-known/oauth-protected-resource')) return send(res, 200, oauth.protectedResourceMetadata(), 'application/json', CORS);
      if (pth.startsWith('/.well-known/oauth-authorization-server') || pth === '/.well-known/openid-configuration') return send(res, 200, oauth.authorizationServerMetadata(), 'application/json', CORS);
      if (pth.startsWith('/oauth/')) return await handleOAuth(req, res, url);

      if (pth === '/auth') {
        // used by the Mac app to sign in with the local owner token
        if (!tokenLoginOk(req)) { res.writeHead(303, { location: '/login' }).end(); return; }
        const p = auth.verify(url.searchParams.get('token') ?? '', clientIp(req));
        if (!p) { res.writeHead(303, { location: '/login' }).end(); return; }
        setSession(req, res, p);
        res.writeHead(303, { location: '/' + (url.searchParams.get('hash') ? '#' + url.searchParams.get('hash') : '') }).end();
        return;
      }
      if (pth === '/logout') {
        res.writeHead(303, { location: '/login', 'set-cookie': 'tandem_session=; Path=/; Max-Age=0' }).end();
        return;
      }

      // signed, login-free PNG links: /r/<doc>/<rev>/<node or page:id>.png?exp=…&sig=…
      const m = /^\/r\/(d_[a-z0-9]+)\/(\d+)\/(.+)\.png$/.exec(pth);
      if (m) {
        const exp = Number(url.searchParams.get('exp'));
        const signed = `${pth}?exp=${url.searchParams.get('exp')}`;
        if (!exp || exp * 1000 < Date.now() || !auth.verifyLink(signed, url.searchParams.get('sig') ?? '')) throw new HttpError(403, 'link expired or invalid');
        const target = decodeURIComponent(m[3]);
        const doc = engine.getDoc(m[1], Number(m[2]));
        const shot = engine.renderPNG(doc, target.startsWith('page:') ? { pageId: target.slice(5) } : { nodeId: target, padding: 0, scale: 2 });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
        return res.end(shot.png);
      }

      if (pth.startsWith('/assets/')) {
        principal(req);
        const a = store.getAsset(pth.slice(8));
        if (!a) throw new HttpError(404, 'asset not found');
        res.writeHead(200, { 'content-type': a.mime, 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
        return res.end(a.buf);
      }

      const pub = PUBLIC_FILE.exec(pth);
      if (pub && fs.existsSync(path.join(WEB_DIR, pth.slice(1)))) {
        // ?v=<hash> URLs never change content, so they can be cached for good; everything else must revalidate,
        // and the CDN must not hold a stale copy (CDN-Cache-Control applies to Cloudflare only)
        const fixed = url.searchParams.has('v');
        const longLived = /^\/(fonts|icons|shots)\//.test(pth);
        res.writeHead(200, {
          'content-type': TYPES[pub[1]], 'x-content-type-options': 'nosniff',
          // fonts never change; unversioned icons and screenshots (server pages, old links) may, so the CDN must not keep them
          'cache-control': fixed ? 'public, max-age=31536000, immutable' : pth.startsWith('/fonts/') ? 'public, max-age=86400' : longLived ? 'public, max-age=3600' : 'no-cache',
          ...(fixed || pth.startsWith('/fonts/') ? {} : { 'cdn-cache-control': 'no-store' }),
        });
        return res.end(fs.readFileSync(path.join(WEB_DIR, pth.slice(1))));
      }
      if (pth === '/offline.html') {
        res.writeHead(200, { 'content-type': TYPES.html, 'cache-control': 'no-cache', 'content-security-policy': PAGE_CSP });
        return res.end(fs.readFileSync(path.join(WEB_DIR, 'offline.html')));
      }
      if (pth === '/' || pth === '/index.html') {
        // signed out: the public homepage; signed in: the app
        if (!auth.verifySession(cookies(req).tandem_session)) {
          res.writeHead(200, { 'content-type': TYPES.html, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': PAGE_CSP, 'referrer-policy': 'same-origin' });
          return res.end(fs.readFileSync(path.join(WEB_DIR, 'landing.html'), 'utf8').replaceAll('{{PUBLIC_URL}}', escHtml(engine.publicUrl)));
        }
        res.writeHead(200, {
          'content-type': TYPES.html, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
          'referrer-policy': 'same-origin',
        });
        return res.end(fs.readFileSync(path.join(WEB_DIR, 'index.html')));
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const status = e instanceof HttpError ? e.status : e instanceof OpError ? 400 : /not found/.test(String((e as Error)?.message)) ? 404 : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
