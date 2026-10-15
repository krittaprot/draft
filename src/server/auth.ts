// Access tokens. Every agent or person gets a named token; the name becomes the author of the
// revisions they make. Only SHA-256 hashes are stored. Roles: owner (can manage tokens), editor, viewer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Role = 'owner' | 'editor' | 'viewer';
export interface TokenRecord { name: string; hash: string; role: Role; created: string; lastUsed?: string }
export interface Principal { name: string; role: Role }
interface AuthFile { secret: string; tokens: TokenRecord[] }

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class Auth {
  private file: string;
  private data!: AuthFile;
  private mtime = 0;
  private failures = new Map<string, { count: number; until: number }>();

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
    const token = `easel_${crypto.randomBytes(24).toString('base64url')}`;
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

  /** Throttles guessing: 10 failures from one client blocks it for 10 minutes. */
  blocked(client: string): boolean {
    const f = this.failures.get(client);
    return !!f && f.count >= 10 && f.until > Date.now();
  }

  verify(token: string | undefined, client: string): Principal | null {
    if (!token || this.blocked(client)) return null;
    this.refresh();
    const h = Buffer.from(sha(token), 'hex');
    const rec = this.data.tokens.find((t) => crypto.timingSafeEqual(Buffer.from(t.hash, 'hex'), h));
    if (!rec) {
      const f = this.failures.get(client) ?? { count: 0, until: 0 };
      f.count = f.until < Date.now() && f.count >= 10 ? 1 : f.count + 1;
      f.until = Date.now() + 10 * 60_000;
      this.failures.set(client, f);
      return null;
    }
    this.failures.delete(client);
    const today = new Date().toISOString().slice(0, 10);
    if (rec.lastUsed?.slice(0, 10) !== today) { rec.lastUsed = new Date().toISOString(); this.save(); }
    return { name: rec.name, role: rec.role };
  }

  private hmac(s: string): string {
    return crypto.createHmac('sha256', this.data.secret).update(s).digest('base64url');
  }

  /** Browser session cookie value: name.expiry.signature (30 days). */
  session(p: Principal): string {
    const payload = `${p.name}.${Date.now() + 30 * 86400_000}`;
    return `${payload}.${this.hmac('session:' + payload)}`;
  }

  verifySession(cookie: string | undefined): Principal | null {
    if (!cookie) return null;
    const parts = cookie.split('.');
    if (parts.length !== 3) return null;
    const [name, exp, sig] = parts;
    const want = this.hmac(`session:${name}.${exp}`);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    if (Number(exp) < Date.now()) return null;
    // a revoked token also ends its browser sessions
    this.refresh();
    const rec = this.data.tokens.find((t) => t.name === name);
    return rec ? { name: rec.name, role: rec.role } : null;
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
