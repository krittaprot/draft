// Shared server logic behind both the MCP tools and the editor's HTTP API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Resvg } from '@resvg/resvg-js';
import { DEFAULT_FONT, indexDoc, walk, type Box, type TandemDoc, type TandemNode, type Page } from '../shared/model.ts';
import { renderPage } from '../shared/render.ts';
import { layoutPage, padding as padOf, type Boxes } from '../shared/layout.ts';
import { measureText, textStyle } from '../shared/text.ts';
import { cssFamily, isKnownFamily, italicWeights, normalizeFamily } from '../shared/fonts.ts';
import { resolvePage } from '../shared/resolve.ts';
import { composite, flattenOver, parseColor, contrastRatio, luminance } from '../shared/color.ts';
import { compilePredicate, type Predicate } from '../shared/predicate.ts';
import { variablesSchema } from '../shared/schema.ts';
import { applyOps, OpError, type Op } from './ops.ts';
import { isAssetId, type Store } from './store.ts';
import type { Auth } from './auth.ts';

const SYSTEM_FONTS = [
  '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/HelveticaNeue.ttc', '/System/Library/Fonts/SFNS.ttf',
  '/System/Library/Fonts/SFNSItalic.ttf', '/System/Library/Fonts/SFNSMono.ttf', '/System/Library/Fonts/SFNSRounded.ttf',
  '/System/Library/Fonts/Avenir Next.ttc', '/System/Library/Fonts/Avenir.ttc', '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/Times.ttc', '/System/Library/Fonts/Courier.ttc', '/System/Library/Fonts/NewYork.ttf',
  '/System/Library/Fonts/Optima.ttc', '/System/Library/Fonts/Palatino.ttc', '/System/Library/Fonts/ThonburiUI.ttc',
  '/System/Library/Fonts/Supplemental/Thonburi.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Georgia.ttf',
  '/System/Library/Fonts/Supplemental/Georgia Bold.ttf', '/System/Library/Fonts/Supplemental/Verdana.ttf',
  '/System/Library/Fonts/Supplemental/Verdana Bold.ttf', '/System/Library/Fonts/Supplemental/Trebuchet MS.ttf',
  '/System/Library/Fonts/Supplemental/Courier New.ttf', '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/AppleSDGothicNeo.ttc',
  // common Linux locations, for running on a non-Mac host
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

/** The bundled families (dist/web/fonts/<slug>/*.ttf) — the same files the browser loads via /fonts.css. */
function bundledFonts(): string[] {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'fonts');
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, entry.name))) {
      if (/\.(ttf|otf)$/i.test(f)) out.push(path.join(dir, entry.name, f));
    }
  }
  return out;
}

export class Engine {
  private fonts: string[];
  private defaultFamily: string;
  constructor(public store: Store, public auth: Auth, public publicUrl: string) {
    this.fonts = [...SYSTEM_FONTS.filter((f) => fs.existsSync(f)), ...bundledFonts(), ...store.fontFiles()];
    this.defaultFamily = fs.existsSync('/System/Library/Fonts/HelveticaNeue.ttc') ? 'Helvetica Neue' : 'Inter';
  }

  getDoc(id: string, rev?: number): TandemDoc {
    return rev === undefined ? this.store.getDoc(id) : this.store.getRevision(id, rev);
  }

  page(doc: TandemDoc, pageId?: string, nodeId?: string): Page {
    if (nodeId) {
      const w = indexDoc(doc).get(nodeId);
      if (!w) throw new OpError(`node "${nodeId}" not found`);
      return w.page;
    }
    if (!pageId) return doc.pages[0];
    const p = doc.pages.find((x) => x.id === pageId);
    if (!p) throw new OpError(`page "${pageId}" not found`);
    return p;
  }

  async apply(docId: string, ops: Op[], author: string, message: string, opts: { atomic?: boolean } = {}) {
    const prepared = this.normalizeFonts(await this.resolveRemoteImages(ops));
    const cur = this.store.getDoc(docId);
    const r = applyOps(cur, prepared, { atomic: opts.atomic });
    const rev = this.store.commit(r.doc, { author, message, changed: r.changed });
    return {
      rev: rev.rev, created: r.created, changed: r.changed, errors: r.errors,
      fontIssues: fontIssues(r.doc, this.fontTouchedIds(prepared, r.created)),
      warnings: this.warnings(r.doc, this.page(r.doc)),
    };
  }

  /** Ids whose typography actually changed: new nodes, plus updates that set fontFamily or italic. */
  private fontTouchedIds(ops: Op[], created: string[]): Set<string> {
    const ids = new Set(created);
    for (const op of ops) {
      if (op?.op === 'update' && op.props && ('fontFamily' in op.props || 'italic' in op.props)) ids.add(op.id);
    }
    return ids;
  }

  /** Rewrites fontFamily to the catalogue's spelling so "inter" and "Inter Display" both render as Inter. */
  private normalizeFonts(ops: Op[]): Op[] {
    const fix = (props: Record<string, unknown>) => {
      if (typeof props.fontFamily !== 'string') return props;
      return { ...props, fontFamily: normalizeFamily(props.fontFamily) };
    };
    return ops.map((op) => {
      if (op?.op === 'create') return { ...op, node: fixTree(op.node, true) };
      if (op?.op === 'update' && op.props) return { ...op, props: fix(op.props) };
      return op;
    });
  }

  // ---------- images ----------

  /** Replaces https image URLs in create/update ops with stored asset ids. */
  private async resolveRemoteImages(ops: Op[]): Promise<Op[]> {
    const urls = new Set<string>();
    const scan = (spec: unknown) => {
      if (!spec || typeof spec !== 'object') return;
      const o = spec as Record<string, unknown>;
      if (typeof o.src === 'string' && /^https?:\/\//i.test(o.src)) urls.add(o.src);
      if (Array.isArray(o.children)) o.children.forEach(scan);
    };
    for (const op of ops) {
      if (op?.op === 'create') scan(op.node);
      if (op?.op === 'update') scan(op.props);
    }
    if (!urls.size) return ops;
    const map = new Map<string, string>();
    for (const u of urls) map.set(u, await this.fetchImage(u));
    const swap = (spec: unknown): unknown => {
      if (!spec || typeof spec !== 'object') return spec;
      const o = { ...(spec as Record<string, unknown>) };
      if (typeof o.src === 'string' && map.has(o.src)) o.src = map.get(o.src);
      if (Array.isArray(o.children)) o.children = o.children.map(swap);
      return o;
    };
    return ops.map((op) => op?.op === 'create' ? { ...op, node: swap(op.node) as Record<string, unknown> }
      : op?.op === 'update' ? { ...op, props: swap(op.props) as Record<string, unknown> } : op);
  }

  /** Downloads an image from a public address. Private, loopback and tailnet addresses are refused. */
  async fetchImage(url: string, redirects = 3): Promise<string> {
    let u: URL;
    try { u = new URL(url); } catch { throw new OpError(`invalid image URL ${url}`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new OpError('image URLs must be http(s)');
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new OpError(`cannot resolve ${u.hostname}`);
    if (addrs.some((a) => isPrivate(a.address))) throw new OpError(`refusing to fetch images from private address ${u.hostname}`);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Tandem/0.1 (+image fetch)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (!redirects) throw new OpError('too many redirects');
      return this.fetchImage(new URL(res.headers.get('location')!, u).toString(), redirects - 1);
    }
    if (!res.ok) throw new OpError(`image download failed: HTTP ${res.status} for ${url}`);
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > 15 * 1024 * 1024) throw new OpError('image larger than 15 MB');
    const buf = Buffer.from(await res.arrayBuffer());
    return this.store.putAsset(buf, mime || sniff(buf));
  }

  putImageData(data: string, mime?: string): string {
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(data);
    const buf = Buffer.from(m ? m[2] : data, 'base64');
    return this.store.putAsset(buf, m?.[1] ?? mime ?? sniff(buf));
  }

  private inlineAsset = (src: string): string | null => {
    if (src.startsWith('data:image/')) return src;
    if (isAssetId(src)) {
      const a = this.store.getAsset(src);
      return a ? `data:${a.mime};base64,${a.buf.toString('base64')}` : null;
    }
    return null;
  };

  // ---------- rendering ----------

  renderSVG(doc: TandemDoc, opts: { pageId?: string; nodeId?: string; padding?: number; states?: Record<string, string> }) {
    const page = this.page(doc, opts.pageId, opts.nodeId);
    const { page: resolved, issues } = resolvePage(page, doc, { states: opts.states });
    return { ...renderPage(resolved, { assetHref: this.inlineAsset }, opts.nodeId, opts.padding ?? (opts.nodeId ? 0 : 40)), issues };
  }

  renderPNG(doc: TandemDoc, opts: { pageId?: string; nodeId?: string; scale?: number; maxSide?: number; padding?: number; states?: Record<string, string> }) {
    const r = this.renderSVG(doc, opts);
    if (!r.body) throw new OpError('nothing to render: the page is empty');
    const side = Math.max(r.box.w, r.box.h);
    let scale = opts.scale ?? Math.min(2, (opts.maxSide ?? 1600) / side);
    // keep renders under ~40 megapixels
    scale = Math.max(0.05, Math.min(scale, 4, Math.sqrt(40e6 / (r.box.w * r.box.h))));
    const png = new Resvg(r.svg, {
      fitTo: { mode: 'zoom', value: scale },
      font: { loadSystemFonts: false, fontFiles: this.fonts, defaultFontFamily: this.defaultFamily, sansSerifFamily: this.defaultFamily },
      imageRendering: 0,
    }).render().asPng();
    return { png: Buffer.from(png), width: Math.round(r.box.w * scale), height: Math.round(r.box.h * scale), box: r.box, scale, issues: r.issues };
  }

  /** A link that shows this exact revision as a PNG without logging in. Valid for 30 days. */
  screenshotLink(docId: string, rev: number, target: string): string {
    const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
    const p = `/r/${docId}/${rev}/${encodeURIComponent(target)}.png?exp=${exp}`;
    return `${this.publicUrl}${p}&sig=${this.auth.signLink(p)}`;
  }

  editorLink(docId: string, nodeId?: string): string {
    return `${this.publicUrl}/#doc=${docId}${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ''}`;
  }

  // ---------- checks ----------

  /** Dry run: applies ops to a copy and reports what would fail, without committing. */
  validateOps(docId: string, ops: Op[]) {
    const doc = this.store.getDoc(docId);
    const prepared = this.normalizeFonts(ops);
    const r = applyOps(doc, prepared, { atomic: false });
    return {
      ok: (r.errors ?? []).length === 0,
      errors: r.errors ?? [],
      wouldCreate: r.created.length,
      wouldChange: r.changed.length,
      warnings: this.warnings(r.doc, this.page(r.doc)),
    };
  }

  /** Finds nodes by property instead of id, so a small fix does not need a full tree read. */
  find(doc: TandemDoc, where: Predicate, pageId?: string, limit = 50) {
    const { matches, describe } = compilePredicate(where);
    const lines: string[] = [];
    let total = 0;
    for (const page of doc.pages) {
      if (pageId && page.id !== pageId) continue;
      const boxes = layoutPage(resolvePage(page, doc).page);
      walk({ ...doc, pages: [page] }, ({ node }) => {
        if (!matches(node)) return;
        total++;
        const b = boxes.get(node.id);
        const box = b ? `${Math.round(b.w)}x${Math.round(b.h)} at ${Math.round(b.x)},${Math.round(b.y)}` : 'no box';
        const text = node.type === 'text' ? ` "${(node.text ?? '').slice(0, 40).replace(/\n/g, '⏎')}"` : '';
        lines.push(`${node.id} ${node.type}${node.name ? ` "${node.name}"` : ''} ${box}${text}`);
      });
    }
    return { total, describe, lines: lines.slice(0, limit) };
  }

  /**
   * WCAG contrast for every text node against the colour actually behind it. Gradients are evaluated
   * against every stop and reported at their worst; text over an image cannot be judged from geometry,
   * so it is counted as unverified instead of guessed. Results keep their page, so a hit in an archive
   * is not read as a defect in the live design.
   */
  auditContrast(doc: TandemDoc, pageId?: string): { pages: { id: string; name: string; failures: string[] }[]; unverified: number; exempt: number } {
    const pages: { id: string; name: string; failures: string[] }[] = [];
    const idx = indexDoc(doc);
    let unverified = 0;
    let exempt = 0;
    for (const page of doc.pages) {
      if (pageId && page.id !== pageId) continue;
      const failures: string[] = [];
      walk({ ...doc, pages: [page] }, ({ node }) => {
        if (node.type !== 'text' || node.visible === false) return;
        const cfg = varLookup(doc, node.color);
        const ffg = varLookup(doc, node.fill);
        const fgRaw = (typeof cfg === 'string' ? cfg : null) ?? (typeof ffg === 'string' ? ffg : '#111111');
        const fg = parseColor(fgRaw);
        if (!fg) return;
        // WCAG 1.4.3 exempts text in an inactive control, and opacity reduces the contrast actually seen
        let alpha = node.opacity ?? 1;
        let disabled = node.disabled === true;
        for (let p = idx.get(node.id)?.parent; p; p = idx.get(p.id)?.parent) {
          alpha *= p.opacity ?? 1;
          if (p.disabled === true) disabled = true;
        }
        if (disabled) { exempt++; return; }
        if (alpha <= 0.01) return;
        const backdrop = backdropOf(doc, page, node.id);
        if (backdrop.image) { unverified++; return; }
        let worst: { ratio: number; bg: string; rgba: NonNullable<ReturnType<typeof parseColor>>; painted: NonNullable<ReturnType<typeof parseColor>> } | null = null;
        for (const c of backdrop.colors) {
          const b = parseColor(c);
          if (!b) continue;
          const painted = composite({ ...fg, a: fg.a * alpha }, b);
          const r = contrastRatio(painted, b);
          if (!worst || r < worst.ratio) worst = { ratio: r, bg: c, rgba: b, painted };
        }
        if (!worst) return;
        const size = node.fontSize ?? 16;
        const large = size >= 24 || (size >= 18.66 && (node.fontWeight ?? 400) >= 700);
        const need = large ? 3 : 4.5;
        if (worst.ratio + 0.005 >= need) return;
        const hint = suggestToken(doc, worst.painted, worst.rgba, need);
        const where = `${worst.bg}${backdrop.gradient ? ' (gradient stop)' : ''}`;
        failures.push(`${node.id} "${(node.text ?? '').slice(0, 44).replace(/\n/g, '⏎')}" ${fgRaw} on ${where} → ${worst.ratio.toFixed(2)}:1, needs ${need}:1${hint}`);
      });
      pages.push({ id: page.id, name: page.name, failures });
    }
    return { pages, unverified, exempt };
  }

  /** The document's tokens as CSS custom properties, DTCG-shaped JSON and a Tailwind @theme block. */
  exportTokens(doc: TandemDoc) {
    const vars = doc.variables ?? {};
    const entries = Object.entries(vars);
    const css = `:root {\n${entries.map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}`;
    const json = {
      [doc.name]: Object.fromEntries(entries.map(([k, v]) => [k, { $value: v, $type: typeof v === 'number' ? 'number' : 'color' }])),
    };
    const tailwind = `@theme {\n${entries.map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}`;
    return { css, json, tailwind };
  }

  /** Structural problems a screenshot would show but not explain. */
  warnings(doc: TandemDoc, page: Page): string[] {
    const out: string[] = [];
    const { page: resolved, issues } = resolvePage(page, doc, { issues: [] });
    out.push(...issues);
    const boxes = layoutPage(resolved);
    const index = new Map<string, TandemNode>();
    const collect = (list: TandemNode[]) => { for (const n of list) { index.set(n.id, n); if (n.children) collect(n.children); } };
    collect(resolved.children);
    for (const [id, node] of index) {
      const b = boxes.get(id);
      if (!b || node.visible === false) continue;
      if (node.type === 'text') {
        const m = measureText(node, b.w + 1);
        if (m.height > b.h + 1.5) out.push(`text ${id} needs ${Math.ceil(m.height)}px but its box is ${Math.round(b.h)}px high — it will be clipped`);
        continue;
      }
      if (node.type !== 'frame' || node.clip === false) continue;
      for (const k of node.children ?? []) {
        if (k.visible === false) continue;
        const kb = boxes.get(k.id);
        if (!kb) continue;
        const over = Math.max(0, kb.x + kb.w - (b.x + b.w), kb.y + kb.h - (b.y + b.h), b.x - kb.x, b.y - kb.y);
        if (over > 1) { out.push(`frame ${id} clips ${k.id} by ${Math.round(over)}px (content exceeds the frame)`); break; }
      }
    }
    return [...new Set(out)];
  }

  // ---------- reading ----------

  outline(doc: TandemDoc, opts: { pageId?: string; nodeId?: string; depth?: number }): string {
    const depth = opts.depth ?? 4;
    const lines: string[] = [];
    const pages = opts.nodeId ? [this.page(doc, undefined, opts.nodeId)] : opts.pageId ? [this.page(doc, opts.pageId)] : doc.pages;
    for (const page of pages) {
      const boxes = layoutPage(resolvePage(page, doc).page);
      lines.push(`page "${page.name}" id=${page.id}${page.background ? ` background=${page.background}` : ''}`);
      const roots = opts.nodeId ? [indexDoc(doc).get(opts.nodeId)!.node] : page.children;
      const visit = (n: TandemNode, d: number) => {
        lines.push('  '.repeat(d + 1) + describe(n, boxes));
        if (!n.children?.length) return;
        if (d + 1 >= depth) { lines.push('  '.repeat(d + 2) + `… ${countNodes(n.children)} nested nodes (raise depth or call get_node)`); return; }
        n.children.forEach((k) => visit(k, d + 1));
      };
      roots.forEach((n) => visit(n, 0));
      if (!roots.length) lines.push('  (empty)');
    }
    return lines.join('\n');
  }

  nodeDetail(doc: TandemDoc, nodeId: string): { node: TandemNode; box: Box; parent: string; page: string; computed: Record<string, string> } {
    const w = indexDoc(doc).get(nodeId);
    if (!w) throw new OpError(`node "${nodeId}" not found`);
    const box = layoutPage(resolvePage(w.page, doc).page).get(nodeId)!;
    return { node: w.node, box: roundBox(box), parent: w.parent?.id ?? w.page.id, page: w.page.id, computed: computedColors(doc, w.page, w.node) };
  }

  exportHTML(doc: TandemDoc, nodeId: string): string {
    const w = indexDoc(doc).get(nodeId);
    if (!w) throw new OpError(`node "${nodeId}" not found`);
    const boxes = layoutPage(resolvePage(w.page, doc).page);
    const asset = (src: string) => (isAssetId(src) ? `${this.publicUrl}/assets/${src}` : src);
    const body = htmlNode(w.node, boxes, null, asset);
    return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(w.node.name ?? w.node.id)}</title>\n<style>*{box-sizing:border-box;margin:0}body{background:${w.page.background ?? '#f5f5f5'}}</style></head>\n<body>\n${body}\n</body></html>\n`;
  }
}

function countNodes(list: TandemNode[]): number {
  return list.reduce((a, n) => a + 1 + countNodes(n.children ?? []), 0);
}

function fixTree(spec: unknown, isNew = false): Record<string, unknown> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec as Record<string, unknown>;
  const o = { ...(spec as Record<string, unknown>) };
  // New text nodes get the bundled default instead of a macOS-only stack, so the PNG and the canvas
  // agree on every machine. Existing documents keep whatever fontFamily they were saved with.
  if (isNew && o.type === 'text' && o.fontFamily === undefined) o.fontFamily = 'Inter';
  if (typeof o.fontFamily === 'string') o.fontFamily = normalizeFamily(o.fontFamily);
  if (Array.isArray(o.children)) o.children = o.children.map((c) => fixTree(c, isNew));
  return o;
}

/** Font problems the author should hear about: missing families, and italics the family cannot draw. */
function fontIssues(doc: TandemDoc, changed: Set<string>): string[] {
  const missing = new Set<string>();
  const noItalic = new Set<string>();
  const visit = (nodes: TandemNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text' && changed.has(n.id) && n.fontFamily) {
        if (!isKnownFamily(n.fontFamily)) missing.add(n.fontFamily);
        else if (n.italic && italicWeights(n.fontFamily).length === 0) noItalic.add(n.fontFamily);
      }
      if (n.children) visit(n.children);
    }
  };
  for (const page of doc.pages) visit(page.children);
  const out = [...missing].map((f) => `unknown font: ${f} — it falls back to Helvetica and will look different elsewhere`);
  for (const f of noItalic) out.push(`no italic face for ${f} — it renders upright instead of a synthesised slant`);
  return out;
}

const roundBox = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

function describe(n: TandemNode, boxes: Boxes): string {
  const b = roundBox(boxes.get(n.id) ?? { x: 0, y: 0, w: 0, h: 0 });
  let s = `${n.type} id=${n.id}`;
  if (n.name) s += ` "${n.name}"`;
  s += ` ${b.w}x${b.h} at ${b.x},${b.y}`;
  if (n.component === true) s += ' [component]';
  if (n.type === 'instance') s += ` component=${typeof n.component === 'string' ? n.component : '(none)'}${n.state ? ` state=${n.state}` : ''}`;
  if (n.layout && n.layout !== 'none') s += ` layout=${n.layout} gap=${n.gap ?? 0}`;
  if (n.type === 'text') s += ` ${n.fontSize ?? 16}px "${(n.text ?? '').slice(0, 60).replace(/\n/g, '⏎')}${(n.text ?? '').length > 60 ? '…' : ''}"`;
  if (typeof n.fill === 'string') s += ` fill=${n.fill}`;
  if (n.visible === false) s += ' hidden';
  if (n.locked) s += ' locked';
  if (n.note) s += ` note="${n.note.slice(0, 80)}"`;
  return s;
}

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

function sniff(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/<svg/i.test(buf.subarray(0, 1000).toString())) return 'image/svg+xml';
  return 'application/octet-stream';
}

// ---------- HTML export ----------

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function cssFill(f: TandemNode['fill']): string | null {
  if (f === undefined || f === null) return null;
  const list = Array.isArray(f) ? f : [f];
  const layers = list.map((x) => typeof x === 'string' ? `linear-gradient(${x},${x})`
    : x.type === 'radial' ? `radial-gradient(${x.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(',')})`
    : `linear-gradient(${x.angle ?? 180}deg,${x.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(',')})`);
  if (list.length === 1 && typeof list[0] === 'string') return `background:${list[0]}`;
  return `background:${layers.reverse().join(',')}`;
}

function htmlNode(n: TandemNode, boxes: Boxes, parent: TandemNode | null, asset: (s: string) => string): string {
  if (n.visible === false) return '';
  const b = boxes.get(n.id)!;
  const pb = parent ? boxes.get(parent.id)! : null;
  const css: string[] = [];
  const inFlow = parent && (parent.layout === 'row' || parent.layout === 'column') && n.position !== 'absolute';
  if (!parent) css.push('position:relative', 'margin:0 auto');
  else if (!inFlow) css.push('position:absolute', `left:${Math.round(b.x - pb!.x)}px`, `top:${Math.round(b.y - pb!.y)}px`);
  const row = parent?.layout === 'row';
  const main = row ? 'width' : 'height';
  const sizeCss = (axis: 'width' | 'height') => {
    const v = n[axis];
    if (inFlow && v === 'fill') return axis === main ? 'flex:1 1 0;min-width:0' : 'align-self:stretch';
    if (n.type === 'text' && (v === undefined || v === 'hug') && axis === 'height') return '';
    return `${axis}:${Math.round(axis === 'width' ? b.w : b.h)}px`;
  };
  for (const a of ['width', 'height'] as const) { const s = sizeCss(a); if (s) css.push(s); }
  if (n.type === 'frame' || n.type === 'rect' || n.type === 'ellipse') {
    const f = cssFill(n.fill === undefined && n.type !== 'frame' ? '#d9d9d9' : n.fill);
    if (f) css.push(f);
  }
  if (n.type === 'ellipse') css.push('border-radius:50%');
  else if (n.radius !== undefined) {
    const rr = Array.isArray(n.radius) ? n.radius : [n.radius];
    css.push(`border-radius:${rr.map((r) => (typeof r === 'number' ? `${r}px` : '0px')).join(' ')}`);
  }
  if (n.stroke) css.push(`border:${n.strokeWidth ?? 1}px ${n.strokeDash?.length ? 'dashed' : 'solid'} ${n.stroke}`);
  if (n.opacity !== undefined && n.opacity < 1) css.push(`opacity:${n.opacity}`);
  if (n.rotation) css.push(`transform:rotate(${n.rotation}deg)`);
  if (n.shadows?.length) css.push(`box-shadow:${n.shadows.map((s) => `${s.inset ? 'inset ' : ''}${s.x ?? 0}px ${s.y ?? 4}px ${s.blur ?? 12}px ${s.color ?? 'rgba(0,0,0,0.15)'}`).join(',')}`);
  if (n.blur) css.push(`filter:blur(${n.blur}px)`);
  const a11y = `${n.role ? ` role="${escHtml(n.role)}"` : ''}${n.label ? ` aria-label="${escHtml(n.label)}"` : ''}${n.disabled ? ' aria-disabled="true"' : ''}`;
  const tag = (inner: string, el = 'div') => `<${el} data-tandem-id="${escHtml(n.id)}"${a11y} style="${escHtml(css.join(';'))}">${inner}</${el}>`;

  switch (n.type) {
    case 'frame': {
      if (n.layout === 'row' || n.layout === 'column') {
        const [t, r, bt, l] = padOf(n);
        css.push('display:flex', `flex-direction:${n.layout}`, `gap:${n.gap ?? 0}px`, `padding:${t}px ${r}px ${bt}px ${l}px`);
        css.push(`align-items:${{ start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[n.align ?? 'start']}`);
        css.push(`justify-content:${{ start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' }[n.justify ?? 'start']}`);
        if (n.children?.some((k) => k.position === 'absolute')) css.push('position:' + (parent && !inFlow ? 'absolute' : 'relative'));
      } else if (inFlow || !parent) css.push('position:relative');
      if (n.clip !== false) css.push('overflow:hidden');
      return tag((n.children ?? []).map((k) => htmlNode(k, boxes, n, asset)).join(''));
    }
    case 'text': {
      const st = textStyle(n);
      css.push(`font-family:${cssFamily(n.fontFamily ?? DEFAULT_FONT)}`, `font-size:${st.fontSize}px`, `font-weight:${st.fontWeight}`, `line-height:${n.lineHeight ?? 1.3}`, `color:${n.color ?? '#111111'}`, 'white-space:pre-wrap', 'font-synthesis:none');
      if (n.italic) css.push('font-style:italic');
      if (st.letterSpacing) css.push(`letter-spacing:${st.letterSpacing}px`);
      if (n.textAlign) css.push(`text-align:${n.textAlign}`);
      if (n.textDecoration && n.textDecoration !== 'none') css.push(`text-decoration:${n.textDecoration}`);
      return tag(escHtml(n.text ?? ''), 'p');
    }
    case 'image':
      css.push(`object-fit:${n.fit ?? 'cover'}`);
      return `<img data-tandem-id="${escHtml(n.id)}" alt="${escHtml(n.alt ?? n.name ?? '')}" src="${escHtml(n.src ? asset(n.src) : '')}" style="${escHtml(css.join(';'))}">`;
    case 'svg': {
      let markup = n.svg ?? '';
      if (n.color) markup = markup.replace(/currentColor/g, n.color);
      return tag(markup.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<svg/, '<svg width="100%" height="100%"'));
    }
    case 'path': {
      const vb = n.viewBox ?? [0, 0, b.w, b.h];
      const f = typeof n.fill === 'string' ? n.fill : 'none';
      return tag(`<svg width="100%" height="100%" viewBox="${vb.join(' ')}" preserveAspectRatio="none"><path d="${escHtml(n.d ?? '')}" fill="${escHtml(f)}"${n.stroke ? ` stroke="${escHtml(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"` : ''}/></svg>`);
    }
    default:
      return tag('');
  }
}

// ---------- computed colours ----------

/** Fills behind a node: page background, then every ancestor's solid fill, composited in order. */
/** A "var:name" reference resolved against the document, or the value itself. */
function varLookup(doc: TandemDoc, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = /^var:([A-Za-z][\w-]*)$/.exec(value);
  return m ? (doc.variables?.[m[1]] ?? value) : value;
}

interface Backdrop {
  /** Every colour the text could be sitting on, worst case included (gradient stops expand this). */
  colors: string[];
  gradient: boolean;
  /** An image sits behind the text, so the contrast cannot be computed from the document. */
  image: boolean;
}

function backdropOf(doc: TandemDoc, page: Page, nodeId: string): Backdrop {
  const idx = indexDoc(doc);
  const chain: TandemNode[] = [];
  for (let w = idx.get(nodeId)?.parent; w; w = idx.get(w.id)?.parent) chain.unshift(w);
  let colors = [page.background ?? '#ffffff'];
  let gradient = false;
  for (const n of chain) {
    if (n.type === 'image' || (typeof n.src === 'string' && n.src)) return { colors, gradient, image: true };
    const f = varLookup(doc, n.fill);
    if (typeof f === 'string') { colors = colors.map((c) => flattenOver(f, c)); continue; }
    const paints = Array.isArray(f) ? f : f ? [f] : [];
    const stops: string[] = [];
    for (const p of paints) {
      if (typeof p === 'string') stops.push(p);
      else if (p && typeof p === 'object' && Array.isArray((p as { stops?: unknown }).stops)) {
        gradient = true;
        for (const s of (p as { stops: { color?: unknown }[] }).stops) if (typeof s.color === 'string') stops.push(s.color);
      }
    }
    if (!stops.length) continue;
    const next = new Set<string>();
    for (const c of colors) for (const s of stops.slice(0, 8)) next.add(flattenOver(s, c));
    colors = [...next].slice(0, 8);
  }
  return { colors, gradient, image: false };
}

/** Alpha-resolved colours for a node, so exports and reviews can see the flat value. */
function computedColors(doc: TandemDoc, page: Page, node: TandemNode): Record<string, string> {
  const bg = backdropOf(doc, page, node.id).colors[0] ?? page.background ?? '#ffffff';
  const out: Record<string, string> = {};
  const fill = varLookup(doc, node.fill);
  const color = varLookup(doc, node.color);
  const stroke = varLookup(doc, node.stroke);
  const outline = varLookup(doc, node.outline?.color);
  if (typeof fill === 'string') out.fill = flattenOver(fill, bg);
  if (typeof color === 'string') out.color = flattenOver(color, bg);
  if (typeof stroke === 'string') out.stroke = flattenOver(stroke, bg);
  if (typeof outline === 'string') out.outline = flattenOver(outline, bg);
  const shadows = (node.shadows ?? []).map((s) => { const c = varLookup(doc, s.color); return typeof c === 'string' ? flattenOver(c, bg) : null; }).filter(Boolean);
  if (shadows.length) out.shadows = shadows.join(', ');
  return out;
}

/** The document token closest to the failing colour that would pass the contrast requirement. */
function suggestToken(doc: TandemDoc, fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }, need: number): string {
  const want = luminance(fg);
  let best: { name: string; ratio: number; delta: number } | null = null;
  for (const [name, value] of Object.entries(doc.variables ?? {})) {
    if (typeof value !== 'string') continue;
    const c = parseColor(value);
    if (!c) continue;
    const ratio = contrastRatio(c, bg);
    if (ratio + 0.005 < need) continue;
    const delta = Math.abs(luminance(c) - want);
    if (!best || delta < best.delta) best = { name, ratio, delta };
  }
  return best ? ` — try var:${best.name} (${best.ratio.toFixed(2)}:1)` : '';
}
