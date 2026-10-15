// Who may use Tandem. Three kinds of principal, each with a name that becomes the author of their revisions:
//   - access tokens (agents, scripts, the owner): named, only SHA-256 hashes stored;
//   - members (people signing in with Google through Neon Auth), allowed by email;
//   - OAuth apps approved by a person (see oauth.ts).
// Roles: owner (can manage tokens, members and apps), editor, viewer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Role = 'owner' | 'editor' | 'viewer';
export interface TokenRecord { name: string; hash: string; role: Role; created: string; lastUsed?: string }
export interface Member { email: string; name: string; role: Role; added: string; lastSeen?: string }
export interface Principal { name: string; role: Role; email?: string }
interface AuthFile { secret: string; tokens: TokenRecord[]; members?: Member[] }

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class Auth {
  private file: string;
  private data!: AuthFile;
  private mtime = 0;
  private failures = new Map<string, { count: number; until: number }>();
  /** Set by the server when OAuth is enabled; checks tandem_at_ access tokens. */
  oauthVerify?: (token: string) => Principal | null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'auth.json');
    if (fs.existsSync(this.file)) this.load();
    else {
      this.data = { secret: crypto.randomBytes(32).toString('hex'), tokens: [] };
      this.save();
    }
  }

  private load() {
    this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  /** Picks up tokens created or revoked by the CLI while the server runs. */
  private refresh() {
    try { if (fs.statSync(this.file).mtimeMs !== this.mtime) this.load(); } catch { /* keep the in-memory copy */ }
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  /** On first run, creates the owner token and writes it next to auth.json for the local app and CLI. */
  ensureOwner(): string | null {
    this.refresh();
    if (this.data.tokens.some((t) => t.role === 'owner')) return null;
    const token = this.create('owner', 'owner');
    fs.writeFileSync(path.join(path.dirname(this.file), 'owner-token'), token + '\n', { mode: 0o600 });
    return token;
  }

  list(): Omit<TokenRecord, 'hash'>[] {
    this.refresh();
    return this.data.tokens.map(({ hash: _h, ...t }) => t);
  }

  create(name: string, role: Role): string {
    this.refresh();
    if (!NAME_RE.test(name)) throw new Error('token name must be 1-40 lowercase letters, digits, ".", "_" or "-"');
    if (this.data.tokens.some((t) => t.name === name)) throw new Error(`a token named "${name}" already exists`);
    const token = `tandem_${crypto.randomBytes(24).toString('base64url')}`;
    this.data.tokens.push({ name, hash: sha(token), role, created: new Date().toISOString() });
    this.save();
    return token;
  }

  revoke(name: string) {
    this.refresh();
    const before = this.data.tokens.length;
    this.data.tokens = this.data.tokens.filter((t) => t.name !== name);
    if (this.data.tokens.length === before) throw new Error(`no token named "${name}"`);
    this.save();
  }

  members(): Member[] {
    this.refresh();
    return [...(this.data.members ?? [])];
  }

  addMember(email: string, role: Role, name?: string): Member {
    this.refresh();
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new Error(`not an email address: ${email}`);
    const list = (this.data.members ??= []);
    const existing = list.find((m) => m.email === e);
    const m: Member = { email: e, role, name: (name?.trim() || existing?.name || e.split('@')[0]).slice(0, 40), added: existing?.added ?? new Date().toISOString(), lastSeen: existing?.lastSeen };
    this.data.members = [...list.filter((x) => x.email !== e), m];
    this.save();
    return m;
  }

  removeMember(email: string) {
    this.refresh();
    const e = email.trim().toLowerCase();
    const before = this.data.members?.length ?? 0;
    this.data.members = (this.data.members ?? []).filter((m) => m.email !== e);
    if (this.data.members.length === before) throw new Error(`no member with email ${e}`);
    this.save();
  }

  /** The principal for a person who signed in with this (verified) email, or null if they are not a member. */
  memberLogin(email: string): Principal | null {
    this.refresh();
    const m = this.data.members?.find((x) => x.email === email.toLowerCase());
    if (!m) return null;
    m.lastSeen = new Date().toISOString();
    this.save();
    return { name: m.name, role: m.role, email: m.email };
  }

  /** Throttles guessing: 10 failures from one client blocks it for 10 minutes. */
  blocked(client: string): boolean {
    const f = this.failures.get(client);
    return !!f && f.count >= 10 && f.until > Date.now();
  }

  verify(token: string | undefined, client: string): Principal | null {
    if (!token || this.blocked(client)) return null;
    if (token.startsWith('tandem_at_')) {
      const p = this.oauthVerify?.(token) ?? null;
      if (!p) this.fail(client);
      return p;
    }
    this.refresh();
    const h = Buffer.from(sha(token), 'hex');
    const rec = this.data.tokens.find((t) => crypto.timingSafeEqual(Buffer.from(t.hash, 'hex'), h));
    if (!rec) { this.fail(client); return null; }
    this.failures.delete(client);
    const today = new Date().toISOString().slice(0, 10);
    if (rec.lastUsed?.slice(0, 10) !== today) { rec.lastUsed = new Date().toISOString(); this.save(); }
    return { name: rec.name, role: rec.role };
  }

  private fail(client: string) {
    const f = this.failures.get(client) ?? { count: 0, until: 0 };
    f.count = f.until < Date.now() && f.count >= 10 ? 1 : f.count + 1;
    f.until = Date.now() + 10 * 60_000;
    this.failures.set(client, f);
  }

  private hmac(s: string): string {
    return crypto.createHmac('sha256', this.data.secret).update(s).digest('base64url');
  }

  /** Browser session cookie value: subject.expiry.signature (30 days). Subject is t:<token name> or m:<email>. */
  session(p: Principal): string {
    const subject = Buffer.from(p.email ? `m:${p.email}` : `t:${p.name}`).toString('base64url');
    const payload = `${subject}.${Date.now() + 30 * 86400_000}`;
    return `${payload}.${this.hmac('session:' + payload)}`;
  }

  verifySession(cookie: string | undefined): Principal | null {
    if (!cookie) return null;
    const parts = cookie.split('.');
    if (parts.length !== 3) return null;
    const [subject, exp, sig] = parts;
    const want = this.hmac(`session:${subject}.${exp}`);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    if (Number(exp) < Date.now()) return null;
    // revoking a token or removing a member also ends their browser sessions
    this.refresh();
    const s = Buffer.from(subject, 'base64url').toString();
    if (s.startsWith('t:')) {
      const rec = this.data.tokens.find((t) => t.name === s.slice(2));
      return rec ? { name: rec.name, role: rec.role } : null;
    }
    if (s.startsWith('m:')) {
      const m = this.data.members?.find((x) => x.email === s.slice(2));
      return m ? { name: m.name, role: m.role, email: m.email } : null;
    }
    return null;
  }

  /** HMAC for short-lived signed values such as consent forms. */
  sign(purpose: string, value: string): string {
    return this.hmac(`${purpose}:${value}`);
  }

  verifySigned(purpose: string, value: string, sig: string): boolean {
    const want = this.sign(purpose, value);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }

  /** Signature for shareable screenshot links, so a PNG can be opened without logging in. */
  signLink(pathAndQuery: string): string {
    return this.hmac('link:' + pathAndQuery);
  }

  verifyLink(pathAndQuery: string, sig: string): boolean {
    const want = this.signLink(pathAndQuery);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
}
