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

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const STATIC: Record<string, string> = { '/app.js': 'text/javascript', '/style.css': 'text/css', '/icon.svg': 'image/svg+xml' };
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

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

const LOGIN_PAGE = (error = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Easel · Sign in</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"></head>
<body class="login"><form method="post" action="/login"><img src="/icon.svg" width="48" height="48" alt=""><h1>Easel</h1><p>Paste an access token. Run <code>easel token create &lt;name&gt;</code> on the host to make one.</p>
${error ? `<p class="error">${error}</p>` : ''}<input name="token" type="password" placeholder="easel_…" autocomplete="current-password" autofocus required><button>Sign in</button></form></body></html>`;

export function createHttpServer(engine: Engine, opts: { trustProxy: boolean }) {
  const { store, auth } = engine;
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
  const secure = (req: http.IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || engine.publicUrl.startsWith('https:');
  const setSession = (req: http.IncomingMessage, res: http.ServerResponse, p: Principal) => {
    res.setHeader('set-cookie', `easel_session=${auth.session(p)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure(req) ? '; Secure' : ''}`);
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
    const p = auth.verifySession(cookies(req).easel_session);
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
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="easel"' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing or invalid bearer token. Create one with: easel token create <name>' }, id: null }));
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

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const { p, viaCookie } = principal(req);
    const method = req.method ?? 'GET';
    // cookie-authenticated writes must come from the editor itself (custom header forces a CORS preflight)
    if (viaCookie && method !== 'GET' && req.headers['x-easel'] !== '1') throw new HttpError(403, 'missing X-Easel header');
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
      if (pth === '/healthz') return send(res, 200, { ok: true, name: 'easel', version: VERSION });
      if (pth === '/mcp' || pth === '/mcp/') return await handleMcp(req, res);
      if (pth.startsWith('/api/')) return await handleApi(req, res, url);

      if (pth === '/login') {
        if (req.method === 'POST') {
          const form = new URLSearchParams((await readBody(req)).toString('utf8'));
          const p = auth.verify(form.get('token') ?? '', clientIp(req));
          if (!p) return send(res, 401, LOGIN_PAGE(auth.blocked(clientIp(req)) ? 'Too many attempts. Try again in 10 minutes.' : 'That token is not valid.'), 'text/html');
          setSession(req, res, p);
          res.writeHead(303, { location: '/' }).end();
          return;
        }
        return send(res, 200, LOGIN_PAGE(), 'text/html');
      }
      if (pth === '/auth') {
        // used by the Mac app to sign in with the local owner token
        const p = auth.verify(url.searchParams.get('token') ?? '', clientIp(req));
        if (!p) { res.writeHead(303, { location: '/login' }).end(); return; }
        setSession(req, res, p);
        res.writeHead(303, { location: '/' + (url.searchParams.get('hash') ? '#' + url.searchParams.get('hash') : '') }).end();
        return;
      }
      if (pth === '/logout') {
        res.writeHead(303, { location: '/login', 'set-cookie': 'easel_session=; Path=/; Max-Age=0' }).end();
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

      if (STATIC[pth]) {
        res.writeHead(200, { 'content-type': STATIC[pth], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(WEB_DIR, pth.slice(1))));
      }
      if (pth === '/' || pth === '/index.html') {
        if (!auth.verifySession(cookies(req).easel_session)) { res.writeHead(303, { location: '/login' }).end(); return; }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
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
