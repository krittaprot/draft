// Google sign-in through Neon Auth (Better Auth), done entirely server-side:
//   1. start(): ask Neon Auth for a Google sign-in URL. Its short-lived challenge cookies stay on this server,
//      keyed by a random flow id that the browser keeps in its own cookie (no third-party cookies involved).
//   2. Google -> Neon Auth -> /auth/neon/callback?neon_auth_session_verifier=…
//   3. finish(): trade the verifier (plus the stored challenge cookies) at get-session for the signed-in user.
// Tandem then checks the email against its member list and starts its own session.
import crypto from 'node:crypto';

const FLOW_TTL = 10 * 60_000;
const MAX_FLOWS = 500;

export interface NeonUser { email: string; name: string; emailVerified: boolean }

export class NeonLogin {
  private flows = new Map<string, { cookies: string; next: string; exp: number }>();
  constructor(public baseUrl: string, private publicUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async start(next: string, provider = 'google'): Promise<{ flowId: string; url: string }> {
    const flowId = crypto.randomBytes(24).toString('base64url');
    const res = await fetch(`${this.baseUrl}/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.publicUrl },
      body: JSON.stringify({ provider, callbackURL: `${this.publicUrl}/auth/neon/callback` }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    if (!res.ok || !body?.url) throw new Error(`Neon Auth refused to start sign-in (HTTP ${res.status})`);
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    for (const [k, f] of this.flows) if (f.exp < Date.now()) this.flows.delete(k);
    if (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    this.flows.set(flowId, { cookies, next, exp: Date.now() + FLOW_TTL });
    return { flowId, url: body.url };
  }

  async finish(flowId: string | undefined, verifier: string | null): Promise<{ user: NeonUser; next: string }> {
    const flow = flowId ? this.flows.get(flowId) : undefined;
    if (flowId) this.flows.delete(flowId);
    if (!flow || flow.exp < Date.now()) throw new Error('This sign-in expired. Start again.');
    if (!verifier) throw new Error('Sign-in was cancelled.');
    const res = await fetch(`${this.baseUrl}/get-session?neon_auth_session_verifier=${encodeURIComponent(verifier)}`, {
      headers: { cookie: flow.cookies, origin: this.publicUrl },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { user?: { email?: unknown; name?: unknown; emailVerified?: unknown } } | null;
    const u = body?.user;
    if (!res.ok || !u || typeof u.email !== 'string' || !u.email) throw new Error('Neon Auth did not confirm the sign-in.');
    if (u.emailVerified !== true) throw new Error('That account’s email address is not verified.');
    return { user: { email: u.email.toLowerCase(), name: typeof u.name === 'string' ? u.name : '', emailVerified: u.emailVerified === true }, next: flow.next };
  }
}
