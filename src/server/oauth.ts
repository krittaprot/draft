// OAuth 2.1 authorization server for the MCP endpoint, per the MCP authorization spec: protected-resource and
// authorization-server metadata, dynamic client registration (public clients), authorization code with PKCE (S256),
// and rotating refresh tokens. A person signed in to Tandem approves each app on a consent page; the approval
// ("grant") becomes a principal named after the app, so its revisions carry that name. Only hashes are stored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Principal, Role } from './auth.ts';

export class OAuthError extends Error {
  constructor(public code: string, msg: string, public status = 400) { super(msg); }
}

export interface OAuthClient {
  client_id: string; client_name: string; redirect_uris: string[]; client_uri?: string;
  created: string; ip?: string;
}
interface StoredToken { hash: string; kind: 'access' | 'refresh' | 'used'; exp: number }
export interface Grant {
  id: string; clientId: string; name: string; role: Role; approvedBy: string; resource: string;
  created: string; lastUsed?: string; tokens: StoredToken[];
}
interface Code { clientId: string; redirectUri: string; challenge: string; resource: string; grantId: string; exp: number }
interface OAuthFile { clients: Record<string, OAuthClient>; grants: Record<string, Grant> }

export interface AuthorizeRequest {
  client: OAuthClient; redirectUri: string; challenge: string; state?: string; scope: string; resource: string;
}

const ACCESS_TTL = 3600;
const REFRESH_TTL = 60 * 86400;
const MAX_CLIENTS = 1000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class OAuth {
  private file: string;
  private data: OAuthFile;
  private codes = new Map<string, Code>();
  private registrations = new Map<string, number[]>();
  /** Fast path for access-token checks: token hash -> grant id. */
  private access = new Map<string, string>();

  constructor(dataDir: string, public issuer: string) {
    this.file = path.join(dataDir, 'oauth.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { clients: {}, grants: {} };
    for (const g of Object.values(this.data.grants)) for (const t of g.tokens) if (t.kind === 'access') this.access.set(t.hash, g.id);
  }

  private save() {
    const now = Date.now() / 1000;
    for (const g of Object.values(this.data.grants)) g.tokens = g.tokens.filter((t) => t.exp > now);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get resource(): string { return `${this.issuer}/mcp`; }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['tandem'],
      resource_name: 'Draft',
      resource_documentation: `${this.issuer}/`,
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['tandem'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ---------- registration ----------

  register(body: Record<string, unknown>, ip: string): Record<string, unknown> {
    const hits = (this.registrations.get(ip) ?? []).filter((t) => t > Date.now() - 3600_000);
    if (hits.length >= 20) throw new OAuthError('too_many_requests', 'too many registrations from this address; try again later', 429);
    if (Object.keys(this.data.clients).length >= MAX_CLIENTS) this.pruneClients();
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1-10 URIs');
    for (const u of uris) if (typeof u !== 'string' || !validRedirect(u)) throw new OAuthError('invalid_redirect_uri', `redirect URI not allowed: ${String(u)}`);
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new OAuthError('invalid_client_metadata', 'only public clients are supported (token_endpoint_auth_method "none"); PKCE protects the exchange');
    const grants = (body.grant_types as string[] | undefined) ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw new OAuthError('invalid_client_metadata', 'unsupported grant_types');
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'MCP client';
    const client: OAuthClient = {
      client_id: `tc_${rand(18)}`, client_name: name, redirect_uris: uris as string[],
      client_uri: typeof body.client_uri === 'string' && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 300) : undefined,
      created: new Date().toISOString(), ip,
    };
    this.data.clients[client.client_id] = client;
    hits.push(Date.now());
    this.registrations.set(ip, hits);
    this.save();
    return {
      client_id: client.client_id, client_id_issued_at: Math.floor(Date.parse(client.created) / 1000),
      client_name: client.client_name, redirect_uris: client.redirect_uris, client_uri: client.client_uri,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'tandem',
    };
  }

  /** Drops the oldest clients that never got a grant, to cap storage. */
  private pruneClients() {
    const used = new Set(Object.values(this.data.grants).map((g) => g.clientId));
    const idle = Object.values(this.data.clients).filter((c) => !used.has(c.client_id)).sort((a, b) => a.created.localeCompare(b.created));
    for (const c of idle.slice(0, Math.max(1, idle.length / 2))) delete this.data.clients[c.client_id];
  }

  // ---------- authorization ----------

  /**
   * Validates an authorization request. Errors about the client or redirect URI must be shown to the person
   * (never redirected); the "redirectable" flag marks the rest, which go back to the client.
   */
  parseAuthorize(q: URLSearchParams): AuthorizeRequest {
    const client = this.data.clients[q.get('client_id') ?? ''];
    if (!client) throw new OAuthError('invalid_client', 'Unknown app. Ask it to connect again.');
    const asked = q.get('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
    const redirectUri = client.redirect_uris.find((r) => sameRedirect(r, asked));
    if (!redirectUri) throw new OAuthError('invalid_request', 'This redirect address is not registered for the app.');
    const state = q.get('state') ?? undefined;
    const fail = (code: string, msg: string) => { throw Object.assign(new OAuthError(code, msg), { redirect: { redirectUri: asked, state } }); };
    if (q.get('response_type') !== 'code') fail('unsupported_response_type', 'response_type must be code');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
    const resource = q.get('resource') ?? this.resource;
    if (!this.isOurResource(resource)) fail('invalid_target', `resource must be ${this.resource}`);
    return { client, redirectUri: asked, challenge, state, scope: 'tandem', resource: this.resource };
  }

  isOurResource(r: string): boolean {
    const norm = (s: string) => s.replace(/\/+$/, '');
    return [this.resource, this.issuer].includes(norm(r));
  }

  /** Records the person's approval and returns the redirect back to the app, with a one-time code. */
  approve(req: AuthorizeRequest, approver: Principal, readOnly: boolean): string {
    const role: Role = readOnly || approver.role === 'viewer' ? 'viewer' : 'editor';
    const grant: Grant = {
      id: `g_${rand(9)}`, clientId: req.client.client_id, name: appName(req.client.client_name),
      role, approvedBy: approver.name, resource: req.resource, created: new Date().toISOString(), tokens: [],
    };
    this.data.grants[grant.id] = grant;
    this.save();
    const code = rand(32);
    this.codes.set(sha(code), { clientId: req.client.client_id, redirectUri: req.redirectUri, challenge: req.challenge, resource: req.resource, grantId: grant.id, exp: Date.now() + 10 * 60_000 });
    return this.redirectWith(req.redirectUri, { code, state: req.state });
  }

  redirectWith(uri: string, params: Record<string, string | undefined>): string {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set('iss', this.issuer);
    return u.toString();
  }

  // ---------- tokens ----------

  token(form: URLSearchParams): Record<string, unknown> {
    const type = form.get('grant_type');
    if (type === 'authorization_code') return this.exchangeCode(form);
    if (type === 'refresh_token') return this.refresh(form);
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  private exchangeCode(form: URLSearchParams) {
    const key = sha(form.get('code') ?? '');
    const code = this.codes.get(key);
    this.codes.delete(key); // single use, even when the exchange fails
    if (!code || code.exp < Date.now()) throw new OAuthError('invalid_grant', 'authorization code is invalid or expired');
    if (form.get('client_id') !== code.clientId) throw new OAuthError('invalid_grant', 'code was issued to another client');
    if ((form.get('redirect_uri') ?? code.redirectUri) !== code.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
    const verifier = form.get('code_verifier') ?? '';
    const expect = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || expect !== code.challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    const r = form.get('resource');
    if (r && !this.isOurResource(r)) throw new OAuthError('invalid_target', `resource must be ${this.resource}`);
    const grant = this.data.grants[code.grantId];
    if (!grant) throw new OAuthError('invalid_grant', 'approval was revoked');
    return this.issue(grant);
  }

  private refresh(form: URLSearchParams) {
    const h = sha(form.get('refresh_token') ?? '');
    const now = Date.now() / 1000;
    for (const grant of Object.values(this.data.grants)) {
      const t = grant.tokens.find((x) => x.hash === h && (x.kind === 'refresh' || x.kind === 'used'));
      if (!t) continue;
      if (t.kind === 'used') {
        // a rotated refresh token came back: someone may have copied it, so end this approval
        this.revokeGrant(grant.id);
        throw new OAuthError('invalid_grant', 'refresh token was already used; the app must be approved again');
      }
      if (t.exp < now) throw new OAuthError('invalid_grant', 'refresh token expired');
      if (form.get('client_id') && form.get('client_id') !== grant.clientId) throw new OAuthError('invalid_grant', 'refresh token belongs to another client');
      t.kind = 'used';
      return this.issue(grant);
    }
    throw new OAuthError('invalid_grant', 'refresh token is invalid');
  }

  private issue(grant: Grant) {
    const access = `tandem_at_${rand(32)}`;
    const refresh = `tandem_rt_${rand(32)}`;
    const now = Math.floor(Date.now() / 1000);
    grant.tokens.push({ hash: sha(access), kind: 'access', exp: now + ACCESS_TTL }, { hash: sha(refresh), kind: 'refresh', exp: now + REFRESH_TTL });
    grant.lastUsed = new Date().toISOString();
    this.access.set(sha(access), grant.id);
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'tandem' };
  }

  /** RFC 7009: revoking either token ends the whole approval. Unknown tokens are not an error. */
  revokeToken(token: string) {
    const h = sha(token);
    const g = Object.values(this.data.grants).find((x) => x.tokens.some((t) => t.hash === h));
    if (g) this.revokeGrant(g.id);
  }

  verifyAccess(token: string): Principal | null {
    const h = sha(token);
    const id = this.access.get(h);
    const g = id ? this.data.grants[id] : undefined;
    const t = g?.tokens.find((x) => x.hash === h && x.kind === 'access');
    if (!g || !t || t.exp < Date.now() / 1000) { if (id && !t) this.access.delete(h); return null; }
    return { name: g.name, role: g.role };
  }

  listGrants() {
    return Object.values(this.data.grants).map((g) => ({
      id: g.id, name: g.name, app: this.data.clients[g.clientId]?.client_name ?? g.name, role: g.role,
      approvedBy: g.approvedBy, created: g.created, lastUsed: g.lastUsed,
      redirect: hostOf(this.data.clients[g.clientId]?.redirect_uris[0]),
    }));
  }

  revokeGrant(id: string) {
    const g = this.data.grants[id];
    if (!g) throw new OAuthError('not_found', 'no such connected app', 404);
    for (const t of g.tokens) this.access.delete(t.hash);
    for (const [k, c] of this.codes) if (c.grantId === id) this.codes.delete(k);
    delete this.data.grants[id];
    this.save();
  }
}

function validRedirect(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) || url.hostname === '::1';
  // native apps may use a private-use scheme like com.example.app:/callback
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(url.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
function sameRedirect(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const a = new URL(registered), b = new URL(asked);
    return a.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

function hostOf(u?: string): string {
  try { return u ? new URL(u).host || u : ''; } catch { return ''; }
}

/** "Claude" -> "claude", "ChatGPT Connector" -> "chatgpt-connector": the author name on revisions. */
export function appName(clientName: string): string {
  const s = clientName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || 'oauth-app';
}
