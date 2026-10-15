// tandem CLI: serve the canvas, manage tokens, connect agents, and bridge stdio-only MCP clients.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { Auth, type Role } from './auth.ts';
import { Engine } from './engine.ts';
import { createHttpServer } from './http.ts';
import { NeonLogin } from './neon.ts';
import { VERSION } from './mcp.ts';

const HELP = `tandem ${VERSION} — an open design canvas for AI agents

Usage:
  tandem serve [--port 3290] [--host 127.0.0.1] [--data DIR] [--public-url URL]
  tandem token create <name> [--role editor|viewer|owner]
  tandem token list
  tandem token revoke <name>
  tandem member add <email> [--role editor|viewer|owner] [--name NAME]
  tandem member list
  tandem member remove <email>
  tandem connect <claude|codex|opencode> [--url URL] [--token TOKEN]
  tandem stdio [--url URL]          MCP over stdio, forwarding to a running Tandem server
  tandem info

Environment: TANDEM_PORT, TANDEM_HOST, TANDEM_DATA, TANDEM_PUBLIC_URL, TANDEM_TOKEN,
TANDEM_NEON_AUTH_URL (enables "Continue with Google" for members, via Neon Auth),
TANDEM_ALLOWED_EMAILS (comma list; no other email can ever sign in),
TANDEM_TOKEN_LOGIN = on | local | off (browser sign-in with an access token; default "local"
when Google sign-in is on, i.e. only on the host itself, never through the tunnel).
Data defaults to ~/.local/share/tandem/data.`;

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    } else pos.push(a);
  }
  return { pos, flags };
}

const { pos, flags } = args(process.argv.slice(2));
const dataDir = path.resolve(flags.data ?? process.env.TANDEM_DATA ?? path.join(os.homedir(), '.local/share/tandem/data'));
const port = Number(flags.port ?? process.env.TANDEM_PORT ?? 3290);
const host = flags.host ?? process.env.TANDEM_HOST ?? '127.0.0.1';
const localUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
const publicUrl = (flags['public-url'] ?? process.env.TANDEM_PUBLIC_URL ?? localUrl).replace(/\/+$/, '');
const allowedEmails = (flags['allowed-emails'] ?? process.env.TANDEM_ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const credFile = path.join(os.homedir(), '.config/tandem/credentials.json');

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function have(cmd: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function saveCredential(url: string, token: string) {
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  const all = fs.existsSync(credFile) ? JSON.parse(fs.readFileSync(credFile, 'utf8')) : {};
  all[url] = token;
  fs.writeFileSync(credFile, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function loadCredential(url: string): string | undefined {
  if (process.env.TANDEM_TOKEN) return process.env.TANDEM_TOKEN;
  if (fs.existsSync(credFile)) return JSON.parse(fs.readFileSync(credFile, 'utf8'))[url];
  return undefined;
}

async function serve() {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const auth = new Auth(dataDir);
  if (allowedEmails.length) auth.allowedEmails = new Set(allowedEmails);
  const owner = auth.ensureOwner();
  const engine = new Engine(store, auth, publicUrl);
  const neonUrl = flags['neon-auth-url'] ?? (process.env.TANDEM_NEON_AUTH_URL || undefined);
  const neon = neonUrl ? new NeonLogin(neonUrl, publicUrl) : undefined;
  const tokenLogin = (flags['token-login'] ?? (process.env.TANDEM_TOKEN_LOGIN || undefined) ?? (neon ? 'local' : 'on')) as 'on' | 'local' | 'off';
  const server = createHttpServer(engine, { trustProxy: true, neon, tokenLogin });
  server.listen(port, host, () => {
    console.log(`Tandem ${VERSION} listening on ${localUrl} (public URL ${publicUrl}), data in ${dataDir}`);
    if (neon) console.log(`Google sign-in via Neon Auth is on; ${auth.members().length} member(s)${allowedEmails.length ? `, limited to ${allowedEmails.join(', ')}` : ''}; browser sign-in with tokens: ${tokenLogin}`);
    if (owner) console.log(`Created the owner token; it is in ${path.join(dataDir, 'owner-token')} (readable only by you).`);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function token() {
  const auth = new Auth((fs.mkdirSync(dataDir, { recursive: true }), dataDir));
  const [, sub, name] = pos;
  if (sub === 'create') {
    if (!name) die('usage: tandem token create <name> [--role editor|viewer|owner]');
    const role = (flags.role ?? 'editor') as Role;
    if (!['editor', 'viewer', 'owner'].includes(role)) die('role must be editor, viewer or owner');
    console.log(auth.create(name, role));
  } else if (sub === 'list') {
    for (const t of auth.list()) console.log(`${t.name.padEnd(24)} ${t.role.padEnd(7)} created ${t.created.slice(0, 10)}${t.lastUsed ? `, last used ${t.lastUsed.slice(0, 10)}` : ''}`);
  } else if (sub === 'revoke') {
    if (!name) die('usage: tandem token revoke <name>');
    auth.revoke(name);
    console.log(`revoked ${name}`);
  } else die(HELP);
}

/** Registers Tandem with an agent CLI, creating a token named after the client. */
function connect() {
  const client = pos[1];
  const url = (flags.url ?? publicUrl).replace(/\/+$/, '');
  let tok = flags.token;
  if (!tok) {
    if (!fs.existsSync(path.join(dataDir, 'auth.json'))) die(`No Tandem server data in ${dataDir}. Run this on the Tandem host, or pass --token (create one there with: tandem token create <name>).`);
    const auth = new Auth(dataDir);
    const base = { claude: 'claude-code', codex: 'codex', opencode: 'opencode' }[client as 'claude'] ?? client;
    let name = base;
    for (let i = 2; auth.list().some((t) => t.name === name); i++) name = `${base}-${i}`;
    tok = auth.create(name, 'editor');
    console.log(`Created token "${name}" (revisions by this agent show that name).`);
  }
  const mcpUrl = `${url}/mcp`;
  const self = fileURLToPath(import.meta.url);
  let cmd: string[];
  if (client === 'claude') {
    cmd = ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'tandem', mcpUrl, '--header', `Authorization: Bearer ${tok}`];
  } else if (client === 'codex') {
    // Codex reads HTTP bearer tokens only from environment variables, so it talks to Tandem through the stdio bridge
    saveCredential(url, tok);
    cmd = ['codex', 'mcp', 'add', 'tandem', '--', process.execPath, self, 'stdio', '--url', url];
  } else if (client === 'opencode') {
    cmd = ['opencode', 'mcp', 'add', '--global', 'tandem', '--url', mcpUrl, '--header', `Authorization=Bearer ${tok}`];
  } else die('usage: tandem connect <claude|codex|opencode> [--url URL] [--token TOKEN]');

  if (!have(cmd[0])) {
    console.log(`${cmd[0]} is not on PATH. Run this where it is installed:\n  ${cmd.map((c) => (/[\s"]/.test(c) ? JSON.stringify(c) : c)).join(' ')}`);
    return;
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  if (r.status !== 0) die(`${cmd[0]} exited with ${r.status}`);
  console.log(`Tandem is connected to ${client}. Restart any open ${client} session to load it.`);
}

async function stdio() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const url = (flags.url ?? publicUrl).replace(/\/+$/, '');
  const tok = flags.token ?? loadCredential(url);
  if (!tok) die(`No token for ${url}. Set TANDEM_TOKEN or run: tandem connect codex --url ${url} --token <token>`);
  const client = new Client({ name: 'tandem-stdio-bridge', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  const server = new Server({ name: 'tandem', version: VERSION }, { capabilities: { tools: {} }, instructions: client.getInstructions() });
  server.setRequestHandler(ListToolsRequestSchema, (r) => client.listTools(r.params));
  server.setRequestHandler(CallToolRequestSchema, (r) => client.callTool(r.params) as never);
  await server.connect(new StdioServerTransport());
}

function member() {
  const auth = new Auth((fs.mkdirSync(dataDir, { recursive: true }), dataDir));
  if (allowedEmails.length) auth.allowedEmails = new Set(allowedEmails);
  const [, sub, email] = pos;
  if (sub === 'add') {
    if (!email) die('usage: tandem member add <email> [--role editor|viewer|owner] [--name NAME]');
    const role = (flags.role ?? 'editor') as Role;
    if (!['editor', 'viewer', 'owner'].includes(role)) die('role must be editor, viewer or owner');
    const m = auth.addMember(email, role, flags.name);
    console.log(`${m.email} can now sign in with Google as ${m.role} (shown as "${m.name}")`);
  } else if (sub === 'list') {
    for (const m of auth.members()) console.log(`${m.email.padEnd(32)} ${m.role.padEnd(7)} ${m.name}${m.lastSeen ? `, last seen ${m.lastSeen.slice(0, 10)}` : ''}`);
  } else if (sub === 'remove') {
    if (!email) die('usage: tandem member remove <email>');
    auth.removeMember(email);
    console.log(`removed ${email}`);
  } else die(HELP);
}

function info() {
  console.log(`version     ${VERSION}\ndata        ${dataDir}\nlocal URL   ${localUrl}\npublic URL  ${publicUrl}\nowner token ${path.join(dataDir, 'owner-token')}`);
}

try {
  switch (pos[0]) {
    case 'serve': await serve(); break;
    case 'token': token(); break;
    case 'member': member(); break;
    case 'connect': connect(); break;
    case 'stdio': await stdio(); break;
    case 'info': info(); break;
    case 'version': console.log(VERSION); break;
    default: console.log(HELP);
  }
} catch (e) {
  die((e as Error).message);
}
