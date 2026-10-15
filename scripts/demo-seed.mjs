// Seeds a throwaway Tandem server with the demo used for the landing-page screenshots:
// "claude-code" designs a wallet app, the owner leaves a review comment, "codex" revises it and replies.
// Usage: node scripts/demo-seed.mjs <base-url> <data-dir>   (the server must be running on that data dir)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, data] = process.argv.slice(2);
if (!base || !data) { console.error('usage: node scripts/demo-seed.mjs <base-url> <data-dir>'); process.exit(1); }
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/server.js');
const token = (name) => execFileSync(process.execPath, [server, 'token', 'create', name, '--data', data]).toString().trim();
const owner = fs.readFileSync(path.join(data, 'owner-token'), 'utf8').trim();
const agent = async (name) => {
  const c = new Client({ name, version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token(name)}` } } }));
  return c;
};
const call = async (c, tool, args) => {
  const r = await c.callTool({ name: tool, arguments: args });
  if (r.isError) throw new Error(`${tool}: ${r.content[0].text}`);
  return r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
};

const claude = await agent('claude-code');
const doc = /d_[a-z0-9]+/.exec(await call(claude, 'create_document', { name: 'Wallet app' }))[0];
const row = (label, value, positive) => ({
  type: 'frame', layout: 'row', width: 'fill', justify: 'space-between', align: 'center', padding: [14, 16], fill: '#ffffff', radius: 12,
  children: [
    { type: 'text', text: label, fontSize: 15, color: '#334155' },
    { type: 'text', text: value, fontSize: 15, fontWeight: 600, color: positive ? '#0F6E56' : '#0f172a' },
  ],
});
await call(claude, 'create_nodes', {
  document: doc, message: 'Wallet home screen, first pass',
  nodes: [
    {
      type: 'frame', id: 'home', name: 'Wallet · Home', width: 390, height: 844, layout: 'column', gap: 16, padding: [56, 20], fill: '#f1f5f4',
      children: [
        { type: 'text', text: 'Good morning, Ploy', fontSize: 15, color: '#64748b' },
        {
          type: 'frame', id: 'balance', layout: 'column', gap: 6, padding: 24, width: 'fill', radius: 20,
          fill: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#0F6E56' }, { offset: 1, color: '#1D9E75' }] },
          shadows: [{ x: 0, y: 12, blur: 32, color: 'rgba(15,110,86,0.30)' }],
          children: [
            { type: 'text', text: 'Total balance', fontSize: 14, color: 'rgba(255,255,255,0.8)' },
            { type: 'text', id: 'amount', text: '฿ 48,250.00', fontSize: 36, fontWeight: 800, color: '#ffffff' },
            { type: 'text', text: '+2.4% this month', fontSize: 13, color: '#c7f0df' },
          ],
        },
        { type: 'text', text: 'Recent', fontSize: 17, fontWeight: 700, color: '#0f172a' },
        row('Coffee · Café Amazon', '−฿ 65'), row('Salary', '+฿ 52,000', true), row('Grab ride', '−฿ 142'), row('Rent', '−฿ 12,000'),
      ],
    },
    {
      type: 'frame', id: 'notes', name: 'Notes', x: 470, y: 0, width: 300, layout: 'column', padding: 20, gap: 8, fill: '#fef9c3', radius: 12,
      children: [
        { type: 'text', text: 'Design notes', fontWeight: 700, fontSize: 16, color: '#422006' },
        { type: 'text', text: 'Balance card uses the brand teal. Amounts use Thai baht with locale grouping.', width: 'fill', fontSize: 14, color: '#713f12', lineHeight: 1.45 },
      ],
    },
  ],
});
await claude.close();

const comment = await (await fetch(`${base}/api/docs/${doc}/comments`, {
  method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
  body: JSON.stringify({ pageId: (await (await fetch(`${base}/api/docs/${doc}`, { headers: { authorization: `Bearer ${owner}` } })).json()).pages[0].id, nodeId: 'balance', x: 300, y: 130, text: 'Add quick actions under the balance: send, receive, top up, scan.' }),
})).json();

const codex = await agent('codex');
await call(codex, 'create_nodes', {
  document: doc, parent: 'home', index: 2, message: 'Added quick actions row',
  nodes: [{
    type: 'frame', id: 'actions', layout: 'row', gap: 10, width: 'fill', fill: null,
    children: ['Send', 'Receive', 'Top up', 'Scan'].map((l) => ({
      type: 'frame', layout: 'column', align: 'center', gap: 6, padding: [12, 0], width: 'fill', fill: '#ffffff', radius: 14,
      children: [{ type: 'ellipse', width: 32, height: 32, fill: '#d6efe6' }, { type: 'text', text: l, fontSize: 12, fontWeight: 600, color: '#334155' }],
    })),
  }],
});
await call(codex, 'reply_comment', { document: doc, comment: comment.id, text: 'Added a four-button row under the balance card. Icons are placeholders for now.' });
await codex.close();
console.log(doc);
