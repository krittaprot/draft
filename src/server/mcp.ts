// MCP tools that let any agent (Claude Code, Codex, opencode, …) use Tandem as its design canvas.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MODEL_GUIDE, newId } from '../shared/model.ts';
import type { Engine } from './engine.ts';
import type { Principal } from './auth.ts';
import type { Op } from './ops.ts';
import type { Comment } from './store.ts';

export const VERSION = '0.1.0';

const INSTRUCTIONS = `Draft is a shared design canvas. You create and edit designs with these tools; people watch live and edit in the browser editor, and leave comments for you.

Workflow:
1. list_documents, or create_document for new work. Each document has pages; top-level frames on a page are screens/artboards.
2. Build with create_nodes: send a whole nested tree (frame → children) in one call. Prefer auto-layout frames (layout "row"/"column" with gap/padding) over hand-placed x/y; they adapt when content changes.
3. Look at your work with screenshot after every meaningful change. Check spacing, alignment, overflow and contrast, then fix with update_nodes.
4. To show the person your work, include the screenshot's "share link" in your reply (a PNG anyone with the link can open) and the editor link.
5. Before revising an existing design, call list_comments: people pin feedback to nodes. Reply with reply_comment and resolve_comment once addressed.
6. Every change becomes a revision with your name; write a short message describing it. get_history and restore_revision undo mistakes.

${MODEL_GUIDE}`;

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (e: unknown): CallToolResult => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });

const docArg = z.string().describe('document id (d_…), from list_documents or create_document');
const messageArg = z.string().max(300).optional().describe('short description of this change, shown in the revision history');
const previewArg = z.boolean().optional().describe('return a screenshot of the affected top-level frame after the change (default false)');

export function buildMcpServer(engine: Engine, who: Principal): McpServer {
  const server = new McpServer({ name: 'tandem', version: VERSION }, { instructions: INSTRUCTIONS });
  const canWrite = who.role !== 'viewer';
  const store = engine.store;

  const guard = (fn: () => Promise<CallToolResult> | CallToolResult) => async (): Promise<CallToolResult> => {
    try { return await fn(); } catch (e) { return fail(e); }
  };
  const writer = <A>(fn: (a: A) => Promise<CallToolResult> | CallToolResult) => async (a: A): Promise<CallToolResult> => {
    if (!canWrite) return fail(`token "${who.name}" is read-only (viewer)`);
    try { return await fn(a); } catch (e) { return fail(e); }
  };
  const reader = <A>(fn: (a: A) => Promise<CallToolResult> | CallToolResult) => async (a: A): Promise<CallToolResult> => {
    try { return await fn(a); } catch (e) { return fail(e); }
  };

  /** Screenshot of the top-level frame containing the first changed node, appended to a result. */
  const withPreview = (res: CallToolResult, docId: string, ids: string[]): CallToolResult => {
    const doc = store.getDoc(docId);
    for (const id of ids) {
      try {
        const d = engine.nodeDetail(doc, id);
        let rootId = id;
        // walk up to the top-level frame
        for (let p = d.parent; p !== d.page;) { rootId = p; p = engine.nodeDetail(doc, p).parent; }
        const shot = engine.renderPNG(doc, { nodeId: rootId, maxSide: 1200 });
        res.content.push({ type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' });
        res.content.push({ type: 'text', text: `Preview of ${rootId} (rev ${doc.rev}). Share link: ${engine.screenshotLink(docId, doc.rev, rootId)}` });
        return res;
      } catch { /* deleted node: try the next one */ }
    }
    return res;
  };

  server.registerTool('design_guide', {
    title: 'Design guide', description: 'Explains the Draft node model and the recommended workflow. Read once before designing.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, guard(() => text(INSTRUCTIONS)));

  server.registerTool('list_documents', {
    title: 'List documents', description: 'Lists documents with their pages and top-level frames.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, guard(() => {
    const docs = store.listDocs();
    if (!docs.length) return text('No documents yet. Use create_document.');
    return text(docs.map((d) => `${d.id} "${d.name}" rev ${d.rev}, updated ${d.updated}\n` + d.pages.map((p) => `  page ${p.id} "${p.name}": ${p.frames.map((f) => `${f.id}${f.name ? ` "${f.name}"` : ''}`).join(', ') || '(empty)'}`).join('\n')).join('\n'));
  }));

  server.registerTool('create_document', {
    title: 'Create document', description: 'Creates a new document with one empty page. Returns its id and first page id.',
    inputSchema: { name: z.string().max(200).describe('document name') },
  }, writer(({ name }: { name: string }) => {
    const doc = store.createDoc(name, who.name);
    return text(`Created document ${doc.id} "${doc.name}" with page ${doc.pages[0].id}.\nEditor: ${engine.editorLink(doc.id)}`);
  }));

  server.registerTool('get_document', {
    title: 'Get document outline', description: 'Returns the layer tree as compact text: type, id, name, computed size and position, layout and key styles. Use get_node for every property of one node.',
    inputSchema: {
      document: docArg,
      page: z.string().optional().describe('only this page id'),
      node: z.string().optional().describe('only the subtree under this node id'),
      depth: z.number().int().min(1).max(50).optional().describe('levels to expand (default 4)'),
    }, annotations: { readOnlyHint: true },
  }, reader(({ document, page, node, depth }: { document: string; page?: string; node?: string; depth?: number }) => {
    const doc = store.getDoc(document);
    return text(`document ${doc.id} "${doc.name}" rev ${doc.rev}\n` + engine.outline(doc, { pageId: page, nodeId: node, depth }));
  }));

  server.registerTool('get_node', {
    title: 'Get node', description: 'Returns all properties of a node (children summarised by id) plus its computed absolute box.',
    inputSchema: { document: docArg, id: z.string().describe('node id'), include_children: z.boolean().optional().describe('include the full child tree as JSON (default false)') },
    annotations: { readOnlyHint: true },
  }, reader(({ document, id, include_children }: { document: string; id: string; include_children?: boolean }) => {
    const d = engine.nodeDetail(store.getDoc(document), id);
    const node = include_children ? d.node : { ...d.node, children: d.node.children?.map((c) => `${c.type}:${c.id}`) };
    return text(JSON.stringify({ ...d, node }, null, 1));
  }));

  const nodesDesc = 'Node specs. Each is {type, id?, name?, ...props, children?: [...]} — children only on frames, nested to any depth. See design_guide for every property.';

  server.registerTool('create_nodes', {
    title: 'Create nodes',
    description: 'Adds one or more node trees to a page or frame in a single revision. Build a whole screen at once: e.g. {type:"frame", id:"home", name:"Home", width:1440, height:"hug", layout:"column", padding:64, gap:32, fill:"#ffffff", children:[{type:"text", text:"Hello", fontSize:48, fontWeight:700}]}.',
    inputSchema: {
      document: docArg,
      parent: z.string().optional().describe('page id or frame id to add into (default: first page)'),
      index: z.number().int().min(0).optional().describe('position among the parent\'s children (default: end, i.e. on top)'),
      nodes: z.array(z.record(z.string(), z.any())).min(1).max(200).describe(nodesDesc),
      message: messageArg, preview: previewArg,
    },
  }, writer(async (a: { document: string; parent?: string; index?: number; nodes: Record<string, unknown>[]; message?: string; preview?: boolean }) => {
    const ops: Op[] = a.nodes.map((node, i) => ({ op: 'create', parent: a.parent, index: a.index === undefined ? undefined : a.index + i, node }));
    const r = await engine.apply(a.document, ops, who.name, a.message ?? `Added ${a.nodes.length} node${a.nodes.length > 1 ? 's' : ''}`);
    const res = text(`rev ${r.rev}: created ${r.created.length} nodes: ${r.created.join(', ')}\n\n` + engine.outline(store.getDoc(a.document), { nodeId: r.created[0], depth: 3 }));
    return a.preview ? withPreview(res, a.document, r.created) : res;
  }));

  server.registerTool('update_nodes', {
    title: 'Update nodes', description: 'Changes properties of one or more nodes in a single revision. Pass only the properties to change; list property names in unset to reset them to defaults.',
    inputSchema: {
      document: docArg,
      updates: z.array(z.object({
        id: z.string(),
        props: z.record(z.string(), z.any()).optional().describe('properties to set'),
        unset: z.array(z.string()).optional().describe('properties to remove'),
      })).min(1).max(500),
      message: messageArg, preview: previewArg,
    },
  }, writer(async (a: { document: string; updates: { id: string; props?: Record<string, unknown>; unset?: string[] }[]; message?: string; preview?: boolean }) => {
    const ops: Op[] = a.updates.map((u) => ({ op: 'update', id: u.id, props: u.props, unset: u.unset }));
    const r = await engine.apply(a.document, ops, who.name, a.message ?? `Updated ${a.updates.length} node${a.updates.length > 1 ? 's' : ''}`);
    const res = text(`rev ${r.rev}: updated ${a.updates.map((u) => u.id).join(', ')}`);
    return a.preview ? withPreview(res, a.document, a.updates.map((u) => u.id)) : res;
  }));

  server.registerTool('delete_nodes', {
    title: 'Delete nodes', description: 'Deletes nodes (and their children). Revisions keep them recoverable.',
    inputSchema: { document: docArg, ids: z.array(z.string()).min(1).max(500), message: messageArg },
    annotations: { destructiveHint: true },
  }, writer(async (a: { document: string; ids: string[]; message?: string }) => {
    const r = await engine.apply(a.document, a.ids.map((id) => ({ op: 'delete', id })), who.name, a.message ?? `Deleted ${a.ids.join(', ')}`);
    return text(`rev ${r.rev}: deleted ${a.ids.join(', ')}`);
  }));

  server.registerTool('move_nodes', {
    title: 'Move nodes', description: 'Moves nodes into another frame or page, or reorders them. index sets the position among the new parent\'s children (0 = bottom/first).',
    inputSchema: { document: docArg, ids: z.array(z.string()).min(1).max(200), parent: z.string().describe('target page id or frame id'), index: z.number().int().min(0).optional(), message: messageArg },
  }, writer(async (a: { document: string; ids: string[]; parent: string; index?: number; message?: string }) => {
    const ops: Op[] = a.ids.map((id, i) => ({ op: 'move', id, parent: a.parent, index: a.index === undefined ? undefined : a.index + i }));
    const r = await engine.apply(a.document, ops, who.name, a.message ?? `Moved ${a.ids.join(', ')}`);
    return text(`rev ${r.rev}: moved ${a.ids.join(', ')} into ${a.parent}`);
  }));

  server.registerTool('duplicate_node', {
    title: 'Duplicate node', description: 'Copies a node with all its children (new ids). Top-level frames are placed to the right of the page; others are offset by dx/dy (default 20) unless inside auto-layout. Useful for variants: duplicate, then update_nodes.',
    inputSchema: { document: docArg, id: z.string(), dx: z.number().optional(), dy: z.number().optional(), message: messageArg },
  }, writer(async (a: { document: string; id: string; dx?: number; dy?: number; message?: string }) => {
    const r = await engine.apply(a.document, [{ op: 'duplicate', id: a.id, dx: a.dx, dy: a.dy }], who.name, a.message ?? `Duplicated ${a.id}`);
    return text(`rev ${r.rev}: copy of ${a.id} is ${r.created[0]}\n\n` + engine.outline(store.getDoc(a.document), { nodeId: r.created[0], depth: 2 }));
  }));

  server.registerTool('manage_pages', {
    title: 'Manage pages', description: 'Adds, renames, recolours or deletes pages, or renames the document.',
    inputSchema: {
      document: docArg,
      action: z.enum(['add', 'update', 'delete', 'rename_document']),
      page: z.string().optional().describe('page id (update/delete), or the new page id for add'),
      name: z.string().max(200).optional(),
      background: z.string().optional().describe('page canvas colour'),
    },
  }, writer(async (a: { document: string; action: string; page?: string; name?: string; background?: string }) => {
    const op: Op = a.action === 'add' ? { op: 'create_page', id: a.page, name: a.name ?? 'Page', background: a.background }
      : a.action === 'update' ? { op: 'update_page', id: a.page!, name: a.name, background: a.background }
      : a.action === 'delete' ? { op: 'delete_page', id: a.page! }
      : { op: 'rename_doc', name: a.name ?? '' };
    const r = await engine.apply(a.document, [op], who.name, `${a.action} page`);
    return text(`rev ${r.rev}: done${r.created.length ? `, new page ${r.created[0]}` : ''}`);
  }));

  server.registerTool('screenshot', {
    title: 'Screenshot',
    description: 'Renders a frame, any node, or a whole page to PNG so you can see your design, plus a share link (PNG, no login, 30 days) and an editor link to give the person you are working with. Call after meaningful changes and inspect the result critically.',
    inputSchema: {
      document: docArg,
      node: z.string().optional().describe('node id to capture (usually a top-level frame); default: the whole page'),
      page: z.string().optional().describe('page id when capturing a whole page (default: first page)'),
      max_side: z.number().int().min(100).max(4000).optional().describe('longest side in pixels (default 1600, capped at 2x scale)'),
      scale: z.number().min(0.05).max(4).optional().describe('exact scale instead of max_side'),
      revision: z.number().int().min(0).optional().describe('capture an earlier revision, e.g. to compare before/after'),
    }, annotations: { readOnlyHint: true },
  }, reader((a: { document: string; node?: string; page?: string; max_side?: number; scale?: number; revision?: number }) => {
    const doc = engine.getDoc(a.document, a.revision);
    const shot = engine.renderPNG(doc, { nodeId: a.node, pageId: a.page, maxSide: a.max_side, scale: a.scale });
    const target = a.node ?? `page:${engine.page(doc, a.page).id}`;
    return {
      content: [
        { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${a.node ?? 'page'} at rev ${doc.rev}: ${Math.round(shot.box.w)}x${Math.round(shot.box.h)} design px, image ${shot.width}x${shot.height}.\nShare link (PNG): ${engine.screenshotLink(doc.id, doc.rev, target)}\nEditor: ${engine.editorLink(doc.id, a.node)}` },
      ],
    };
  }));

  server.registerTool('export', {
    title: 'Export', description: 'Exports a node as SVG markup or as standalone HTML/CSS (auto-layout becomes flexbox), e.g. to implement the design in code.',
    inputSchema: { document: docArg, node: z.string(), format: z.enum(['html', 'svg']) },
    annotations: { readOnlyHint: true },
  }, reader((a: { document: string; node: string; format: 'html' | 'svg' }) => {
    const doc = store.getDoc(a.document);
    return text(a.format === 'html' ? engine.exportHTML(doc, a.node) : engine.renderSVG(doc, { nodeId: a.node }).svg);
  }));

  server.registerTool('upload_image', {
    title: 'Upload image', description: 'Stores an image and returns an asset id to use as an image node\'s src. Give a public https URL, or base64 data (optionally a data: URL). Image nodes also accept https URLs directly.',
    inputSchema: { url: z.string().optional(), data: z.string().optional().describe('base64 or data: URL'), mime_type: z.string().optional() },
  }, writer(async (a: { url?: string; data?: string; mime_type?: string }) => {
    if (!a.url && !a.data) throw new Error('give url or data');
    const id = a.url ? await engine.fetchImage(a.url) : engine.putImageData(a.data!, a.mime_type);
    return text(`asset id: ${id}`);
  }));

  server.registerTool('list_comments', {
    title: 'List comments', description: 'Lists review comments people pinned to the design, with the node each is attached to. Check before revising a design.',
    inputSchema: { document: docArg, include_resolved: z.boolean().optional() }, annotations: { readOnlyHint: true },
  }, reader((a: { document: string; include_resolved?: boolean }) => {
    const list = store.comments(a.document).filter((c) => a.include_resolved || !c.resolved);
    if (!list.length) return text('No open comments.');
    return text(list.map((c) => `${c.id}${c.resolved ? ' (resolved)' : ''} on ${c.nodeId ?? `page ${c.pageId} at ${Math.round(c.x)},${Math.round(c.y)}`} — ${c.author}: ${c.text}` + c.replies.map((r) => `\n    ↳ ${r.author}: ${r.text}`).join('')).join('\n'));
  }));

  server.registerTool('add_comment', {
    title: 'Add comment', description: 'Pins a comment to a node, e.g. to ask the person a question or flag an open decision.',
    inputSchema: { document: docArg, node: z.string(), text: z.string().min(1).max(5000) },
  }, writer((a: { document: string; node: string; text: string }) => {
    const doc = store.getDoc(a.document);
    const d = engine.nodeDetail(doc, a.node);
    const c: Comment = { id: newId('c'), pageId: d.page, nodeId: a.node, x: d.box.x + d.box.w, y: d.box.y, author: who.name, text: a.text, time: new Date().toISOString(), resolved: false, replies: [] };
    store.saveComments(a.document, [...store.comments(a.document), c]);
    return text(`comment ${c.id} added`);
  }));

  server.registerTool('reply_comment', {
    title: 'Reply to comment', description: 'Replies to a comment thread, e.g. to say what you changed.',
    inputSchema: { document: docArg, comment: z.string(), text: z.string().min(1).max(5000), resolve: z.boolean().optional().describe('also mark it resolved') },
  }, writer((a: { document: string; comment: string; text: string; resolve?: boolean }) => {
    const list = store.comments(a.document);
    const c = list.find((x) => x.id === a.comment);
    if (!c) throw new Error(`comment ${a.comment} not found`);
    c.replies.push({ id: newId('r'), author: who.name, text: a.text, time: new Date().toISOString() });
    if (a.resolve) c.resolved = true;
    store.saveComments(a.document, list);
    return text(`replied${a.resolve ? ' and resolved' : ''}`);
  }));

  server.registerTool('resolve_comment', {
    title: 'Resolve comment', description: 'Marks a comment thread as resolved (or reopens it).',
    inputSchema: { document: docArg, comment: z.string(), resolved: z.boolean().optional() },
  }, writer((a: { document: string; comment: string; resolved?: boolean }) => {
    const list = store.comments(a.document);
    const c = list.find((x) => x.id === a.comment);
    if (!c) throw new Error(`comment ${a.comment} not found`);
    c.resolved = a.resolved ?? true;
    store.saveComments(a.document, list);
    return text(c.resolved ? 'resolved' : 'reopened');
  }));

  server.registerTool('get_history', {
    title: 'Revision history', description: 'Lists recent revisions: number, author, time, message and changed node ids.',
    inputSchema: { document: docArg, limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true },
  }, reader((a: { document: string; limit?: number }) => {
    return text(store.history(a.document, a.limit ?? 20).map((r) => `rev ${r.rev} ${r.time} ${r.author}: ${r.message}${r.changed.length ? ` [${r.changed.slice(0, 12).join(', ')}${r.changed.length > 12 ? ', …' : ''}]` : ''}`).join('\n'));
  }));

  server.registerTool('restore_revision', {
    title: 'Restore revision', description: 'Restores the document to an earlier revision (recorded as a new revision, so it can be undone too).',
    inputSchema: { document: docArg, revision: z.number().int().min(0) }, annotations: { destructiveHint: true },
  }, writer((a: { document: string; revision: number }) => {
    const r = store.restore(a.document, a.revision, who.name);
    return text(`restored revision ${a.revision} as rev ${r.rev}`);
  }));

  return server;
}
