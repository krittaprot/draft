// Tandem browser editor: infinite canvas, layers, inspector, comments, history and live agent activity.
import { indexDoc, type Box, type TandemDoc, type TandemNode, type Page } from '../shared/model.ts';
import { renderPage } from '../shared/render.ts';
import { isAuto, type Boxes } from '../shared/layout.ts';

interface Me { name: string; role: 'owner' | 'editor' | 'viewer'; version: string; publicUrl: string }
interface Rev { rev: number; author: string; message: string; time: string; changed: string[] }
interface Comment { id: string; pageId: string; nodeId?: string; x: number; y: number; author: string; text: string; time: string; resolved: boolean; replies: { id: string; author: string; text: string; time: string }[] }
type Tool = 'select' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'text' | 'comment';
type Op = Record<string, unknown> & { op: string };

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll(s)] as T[];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SVGNS = 'http://www.w3.org/2000/svg';
// The icon's story in the UI: teal is you (selection, handles), coral is agents (their changes), gold marks review pins.
const YOU = '#0F6E56';
const YOU_WASH = 'rgba(15,110,86,0.08)';
const AGENT = '#D85A30';
const PIN = '#EF9F27';
const PIN_INK = '#412402';

const S = {
  me: null as Me | null,
  doc: null as TandemDoc | null,
  live: null as TandemDoc | null, // latest version; doc differs while previewing a revision
  preview: null as Rev | null,
  pageId: '',
  sel: [] as string[],
  hover: null as string | null,
  tool: 'select' as Tool,
  zoom: 1, panX: 80, panY: 80,
  boxes: new Map() as Boxes,
  comments: [] as Comment[],
  history: [] as Rev[],
  tab: 'design' as 'design' | 'comments' | 'history',
  collapsed: new Set<string>(),
  flash: new Map<string, number>(), // node id -> expiry (recent agent changes)
  showResolved: false,
  drag: null as null | { kind: string; [k: string]: unknown },
  space: false,
};

// ---------------- API ----------------

async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-tandem': '1' };
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(init.json); }
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? res.statusText);
  return data as T;
}

const canEdit = () => S.me?.role !== 'viewer' && !S.preview;

async function ops(list: Op[], message: string) {
  if (!S.doc || !canEdit()) return;
  try {
    const r = await api<{ rev: number; created: string[] }>(`/api/docs/${S.doc.id}/ops`, { method: 'POST', json: { ops: list, message } });
    await loadDoc(S.doc.id);
    return r;
  } catch (e) { toast(`Couldn't apply: ${(e as Error).message}`, true); await loadDoc(S.doc.id); }
}

async function loadDoc(id: string, keepView = true) {
  const doc = await api<TandemDoc>(`/api/docs/${id}`);
  const first = !S.doc || S.doc.id !== id;
  S.live = doc;
  if (!S.preview) S.doc = doc;
  if (first || !doc.pages.some((p) => p.id === S.pageId)) S.pageId = doc.pages[0].id;
  const idx = indexDoc(doc);
  S.sel = S.sel.filter((s) => idx.has(s));
  ($('#doc-name') as HTMLInputElement).value = doc.name;
  document.title = `${doc.name} · Tandem`;
  if (first) {
    S.comments = await api<Comment[]>(`/api/docs/${id}/comments`);
    history.replaceState(null, '', `#doc=${id}`);
  }
  await loadHistory();
  render();
  if (first || !keepView) zoomToFit();
}

async function loadHistory() {
  if (!S.doc) return;
  S.history = await api<Rev[]>(`/api/docs/${S.doc.id}/history?limit=150`);
}

// ---------------- geometry ----------------

const page = (): Page | undefined => S.doc?.pages.find((p) => p.id === S.pageId);
const toPage = (sx: number, sy: number) => ({ x: (sx - S.panX) / S.zoom, y: (sy - S.panY) / S.zoom });
const toScreen = (b: Box) => ({ x: b.x * S.zoom + S.panX, y: b.y * S.zoom + S.panY, w: b.w * S.zoom, h: b.h * S.zoom });
const stage = () => $<SVGSVGElement>('#stage');
function localPoint(e: { clientX: number; clientY: number }) {
  const r = stage().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function zoomToFit(ids?: string[], tries = 0) {
  const pg = page();
  if (!pg) return;
  // the canvas can still be 0x0 while the window is opening
  const rect = stage().getBoundingClientRect();
  if ((rect.width < 50 || rect.height < 50) && tries < 60) { requestAnimationFrame(() => zoomToFit(ids, tries + 1)); return; }
  const list = (ids ?? pg.children.map((n) => n.id)).map((id) => S.boxes.get(id)).filter(Boolean) as Box[];
  const r = stage().getBoundingClientRect();
  if (!list.length) { S.zoom = 1; S.panX = r.width / 2 - 200; S.panY = 80; drawWorld(); return; }
  const x0 = Math.min(...list.map((b) => b.x)), y0 = Math.min(...list.map((b) => b.y));
  const x1 = Math.max(...list.map((b) => b.x + b.w)), y1 = Math.max(...list.map((b) => b.y + b.h));
  S.zoom = Math.min(2, Math.max(0.02, Math.min((r.width - 120) / (x1 - x0 || 1), (r.height - 120) / (y1 - y0 || 1))));
  S.panX = (r.width - (x1 - x0) * S.zoom) / 2 - x0 * S.zoom;
  S.panY = (r.height - (y1 - y0) * S.zoom) / 2 - y0 * S.zoom;
  drawWorld();
}

function zoomAt(factor: number, sx: number, sy: number) {
  const before = toPage(sx, sy);
  S.zoom = Math.min(64, Math.max(0.02, S.zoom * factor));
  S.panX = sx - before.x * S.zoom;
  S.panY = sy - before.y * S.zoom;
  drawWorld();
}

// ---------------- rendering ----------------

const assetHref = (src: string) => (src.startsWith('data:image/') ? src : /^a_[a-f0-9]{64}\.\w+$/.test(src) ? `/assets/${src}` : null);

function render() {
  // hide what can't be used: viewers never edit, and nobody edits while previewing an old revision
  document.body.classList.toggle('readonly', !canEdit());
  document.body.classList.toggle('viewer', S.me?.role === 'viewer');
  ($('#doc-name') as HTMLInputElement).readOnly = !canEdit();
  drawPages();
  drawLayers();
  drawCanvas();
  drawPanel();
  drawBanner();
  ($('#comment-count') as HTMLElement).textContent = String(S.comments.filter((c) => !c.resolved).length || '');
}

function drawCanvas() {
  const pg = page();
  const world = $('#world');
  if (!pg) { world.innerHTML = ''; return; }
  const r = renderPage(pg, { assetHref, ids: true });
  S.boxes = r.boxes;
  world.innerHTML = `<defs>${r.defs}</defs>${r.body}`;
  ($('#empty') as HTMLElement).hidden = pg.children.length > 0;
  $('#canvas-wrap').style.background = pg.background ?? '';
  drawWorld();
}

function drawWorld() {
  $('#world').setAttribute('transform', `translate(${S.panX} ${S.panY}) scale(${S.zoom})`);
  ($('#zoom-btn') as HTMLElement).textContent = `${Math.round(S.zoom * 100)}%`;
  drawOverlay();
}

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawOverlay() {
  const ov = $('#overlay');
  ov.replaceChildren();
  const pg = page();
  if (!pg) return;
  const idx = S.doc ? indexDoc(S.doc) : new Map();
  // frame titles
  for (const n of pg.children) {
    const b = S.boxes.get(n.id);
    if (!b || n.visible === false) continue;
    const s = toScreen(b);
    const label = svgEl('text', { x: s.x, y: s.y - 6, class: 'frame-label', 'data-label': n.id, fill: S.sel.includes(n.id) ? YOU : '#71717a', 'font-size': 11, style: 'cursor:default;user-select:none' }, n.name ?? n.id);
    ov.append(label);
  }
  // recent agent changes and review highlights
  const now = Date.now();
  const changed = new Set<string>(S.preview ? S.preview.changed : []);
  for (const [id, until] of S.flash) { if (until > now) changed.add(id); else S.flash.delete(id); }
  // outline only the outermost changed layer: a new card shows as one box, not one per child
  const outermost = [...changed].filter((id) => { let p = idx.get(id)?.parent; while (p) { if (changed.has(p.id)) return false; p = idx.get(p.id)?.parent; } return true; });
  for (const id of outermost) {
    const b = S.boxes.get(id);
    if (!b) continue;
    const s = toScreen(b);
    ov.append(svgEl('rect', { x: s.x - 2, y: s.y - 2, width: s.w + 4, height: s.h + 4, fill: 'none', stroke: AGENT, 'stroke-width': 2, 'stroke-dasharray': '6 3', rx: 2 }));
  }
  if (S.hover && !S.sel.includes(S.hover)) {
    const b = S.boxes.get(S.hover);
    if (b) { const s = toScreen(b); ov.append(svgEl('rect', { x: s.x, y: s.y, width: s.w, height: s.h, fill: 'none', stroke: YOU, 'stroke-width': 1 })); }
  }
  for (const id of S.sel) {
    const b = S.boxes.get(id);
    if (!b) continue;
    const s = toScreen(b);
    ov.append(svgEl('rect', { x: s.x, y: s.y, width: s.w, height: s.h, fill: 'none', stroke: YOU, 'stroke-width': 1.5 }));
    const node = idx.get(id)?.node as TandemNode | undefined;
    if (S.sel.length === 1 && canEdit() && node && !node.locked) {
      for (const [h, hx, hy] of [['nw', s.x, s.y], ['ne', s.x + s.w, s.y], ['se', s.x + s.w, s.y + s.h], ['sw', s.x, s.y + s.h]] as const) {
        ov.append(svgEl('rect', { x: hx - 4, y: hy - 4, width: 8, height: 8, fill: '#fff', stroke: YOU, 'stroke-width': 1.5, 'data-handle': h, style: `cursor:${h === 'nw' || h === 'se' ? 'nwse' : 'nesw'}-resize` }));
      }
      const dim = `${Math.round(b.w)} × ${Math.round(b.h)}`;
      const tw = dim.length * 6 + 10;
      ov.append(svgEl('rect', { x: s.x + s.w / 2 - tw / 2, y: s.y + s.h + 6, width: tw, height: 16, rx: 3, fill: YOU }));
      ov.append(svgEl('text', { x: s.x + s.w / 2, y: s.y + s.h + 18, 'text-anchor': 'middle', 'font-size': 10, fill: '#fff' }, dim));
    }
  }
  // comment pins
  S.comments.filter((c) => c.pageId === pg.id && (S.showResolved || !c.resolved)).forEach((c) => {
    const nb = c.nodeId ? S.boxes.get(c.nodeId) : null;
    const pos = toScreen({ x: nb ? Math.min(c.x, nb.x + nb.w) : c.x, y: nb ? Math.max(c.y, nb.y) : c.y, w: 0, h: 0 });
    const g = svgEl('g', { 'data-comment': c.id, style: 'cursor:pointer', transform: `translate(${pos.x} ${pos.y})` });
    g.append(svgEl('path', { d: 'M0,0 h22 a6,6 0 0 1 6,6 v10 a6,6 0 0 1 -6,6 h-16 l-6,6 z', transform: 'translate(0 -28)', fill: c.resolved ? '#a1a1aa' : PIN, stroke: '#fff', 'stroke-width': 1.5 }));
    g.append(svgEl('text', { x: 14, y: -13, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: c.resolved ? '#fff' : PIN_INK }, (c.author[0] ?? '?').toUpperCase()));
    ov.append(g);
  });
  if (S.drag?.kind === 'create' && S.drag.rect) {
    const r = S.drag.rect as Box;
    const s = toScreen(r);
    ov.append(svgEl('rect', { x: s.x, y: s.y, width: s.w, height: s.h, fill: YOU_WASH, stroke: YOU, 'stroke-width': 1 }));
  }
}

function drawPages() {
  const ul = $('#pages');
  ul.innerHTML = (S.doc?.pages ?? []).map((p) => `<li data-page="${esc(p.id)}" class="${p.id === S.pageId ? 'active' : ''}"><span class="ico">▤</span><span class="name">${esc(p.name)}</span>${S.doc!.pages.length > 1 && canEdit() ? `<button class="act" data-del-page="${esc(p.id)}" title="Delete page">✕</button>` : ''}</li>`).join('');
}

const TYPE_ICON: Record<string, string> = { frame: '#', rect: '▢', ellipse: '○', text: 'T', image: '▣', path: '✎', svg: '◇' };

function drawLayers() {
  const pg = page();
  const ul = $('#layers');
  if (!pg) { ul.innerHTML = ''; return; }
  const changed = new Set<string>([...S.flash.keys()]);
  const rows: string[] = [];
  const visit = (list: TandemNode[], depth: number) => {
    // top of the stack first, like Figma
    for (const n of [...list].reverse()) {
      const kids = n.children?.length ? n.children : null;
      const open = kids && !S.collapsed.has(n.id);
      const label = n.name ?? (n.type === 'text' ? (n.text ?? '').slice(0, 40) : n.type);
      rows.push(`<li data-node="${esc(n.id)}" class="${S.sel.includes(n.id) ? 'active' : ''} ${n.visible === false ? 'hidden' : ''} ${changed.has(n.id) ? 'changed' : ''}" style="padding-left:${8 + depth * 14}px">
        <span class="twisty" data-twisty="${esc(n.id)}">${kids ? (open ? '▾' : '▸') : ''}</span><span class="ico">${TYPE_ICON[n.type]}</span>
        <span class="name" title="${esc(n.id)}">${esc(label || n.id)}</span>
        ${canEdit() ? `<button class="act ${n.locked ? 'on' : ''}" data-lock="${esc(n.id)}" title="Lock">${n.locked ? '🔒' : '🔓'}</button><button class="act ${n.visible === false ? 'on' : ''}" data-eye="${esc(n.id)}" title="Show/hide">${n.visible === false ? '◌' : '●'}</button>` : ''}</li>`);
      if (open) visit(kids!, depth + 1);
    }
  };
  visit(pg.children, 0);
  ul.innerHTML = rows.join('') || '<li class="meta">No layers</li>';
  ul.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
}

function drawBanner() {
  const b = $('#banner');
  if (!S.preview) { b.hidden = true; return; }
  b.hidden = false;
  const latest = S.preview.rev === S.live?.rev;
  b.innerHTML = `<span>${latest ? 'Latest change' : `Viewing revision ${S.preview.rev}`} by <b>${esc(S.preview.author)}</b>: ${esc(S.preview.message)}</span>${S.me?.role !== 'viewer' && !latest ? '<button class="btn small" data-restore>Restore this version</button>' : ''}<button class="btn small" data-exit-preview>${latest ? 'Done' : 'Back to live'}</button>`;
}

// ---------------- right panel ----------------

function drawPanel() {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  const p = $('#panel');
  if (S.tab === 'comments') p.innerHTML = commentsPanel();
  else if (S.tab === 'history') p.innerHTML = historyPanel();
  else p.innerHTML = designPanel();
  if (!canEdit()) {
    $$('#panel input:not([data-show-resolved]), #panel select, #panel textarea, #panel [data-set-layout], #panel [data-set-align]').forEach((el) => ((el as HTMLInputElement).disabled = true));
    $$('#panel .edit-only, #panel label:has(> input[data-upload])').forEach((el) => el.remove());
  }
  if (S.me?.role === 'viewer') $$('#panel .comment-only').forEach((el) => el.remove());
}

function selected(): TandemNode[] {
  if (!S.doc) return [];
  const idx = indexDoc(S.doc);
  return S.sel.map((id) => idx.get(id)?.node).filter(Boolean) as TandemNode[];
}

const num = (prop: string, label: string, v: unknown, step = 1) => `<label class="field"><span>${label}</span><input data-prop="${prop}" data-kind="num" type="number" step="${step}" value="${v ?? ''}"></label>`;
const sizeField = (prop: string, label: string, v: unknown, computed: number) => `<label class="field" title="number, hug or fill"><span>${label}</span><input data-prop="${prop}" data-kind="size" value="${typeof v === 'string' ? v : Math.round(computed * 100) / 100}" list="sizes"></label>`;
const sel = (prop: string, label: string, v: string | undefined, options: string[]) => `<label class="field"><span>${label}</span><select data-prop="${prop}" data-kind="str">${options.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
function colorField(prop: string, label: string, v: unknown, allowNone = true) {
  const c = typeof v === 'string' ? v : '';
  const hex = /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : '#000000';
  if (v !== undefined && v !== null && typeof v !== 'string') {
    return `<label class="field"><span>${label}</span><input data-prop="${prop}" data-kind="json" value='${esc(JSON.stringify(v))}'></label>`;
  }
  return `<label class="field"><span>${label}</span><input type="color" data-prop="${prop}" data-kind="color" value="${hex}"><input data-prop="${prop}" data-kind="colortext" value="${esc(c)}" placeholder="${allowNone ? 'none' : ''}"></label>`;
}

function designPanel(): string {
  const nodes = selected();
  if (!S.doc) return '';
  if (!nodes.length) {
    const pg = page();
    return `<div class="insp"><h3>Page</h3>${colorField('page:background', 'Bg', pg?.background ?? '#ececee', false)}
      <div class="actions"><button class="btn small" data-act="export-page">Export PNG</button><button class="btn small" data-act="share-page">Copy share link</button></div></div>
      <div class="insp"><h3>Document</h3><div class="meta">id ${esc(S.doc.id)} · revision ${S.doc.rev}</div><div class="meta">Select a layer to edit it. Agents see the same document through MCP.</div></div>`;
  }
  if (nodes.length > 1) {
    return `<div class="insp"><h3>${nodes.length} layers selected</h3><div class="actions"><button class="btn small edit-only" data-act="duplicate">Duplicate</button><button class="btn small danger edit-only" data-act="delete">Delete</button></div></div>`;
  }
  const n = nodes[0];
  const b = S.boxes.get(n.id) ?? { x: 0, y: 0, w: 0, h: 0 };
  const parent = S.doc ? indexDoc(S.doc).get(n.id)?.parent : null;
  const autoChild = parent && isAuto(parent) && n.position !== 'absolute';
  let h = `<datalist id="sizes"><option value="hug"><option value="fill"></datalist>
    <div class="insp"><h3><span>${TYPE_ICON[n.type]} ${n.type}</span><span class="meta" title="node id">${esc(n.id)}</span></h3>
    <label class="field"><span>Name</span><input data-prop="name" data-kind="str" value="${esc(n.name ?? '')}" placeholder="${esc(n.type)}"></label></div>
    <div class="insp"><h3>Layout</h3>
    ${autoChild ? `<div class="meta">Positioned by ${esc(parent!.name ?? parent!.id)}'s auto layout</div>` : `<div class="grid">${num('x', 'X', Math.round((n.x ?? 0) * 100) / 100)}${num('y', 'Y', Math.round((n.y ?? 0) * 100) / 100)}</div>`}
    <div class="grid">${sizeField('width', 'W', n.width, b.w)}${sizeField('height', 'H', n.height, b.h)}</div>
    <div class="grid">${num('rotation', '⟳', n.rotation ?? 0)}${num('opacity', 'α', n.opacity ?? 1, 0.05)}</div>
    ${parent && isAuto(parent) ? `<label class="check"><input type="checkbox" data-prop="position" data-kind="abs" ${n.position === 'absolute' ? 'checked' : ''}> Ignore auto layout (absolute)</label>` : ''}</div>`;

  if (n.type === 'frame') {
    const lay = n.layout ?? 'none';
    h += `<div class="insp"><h3>Auto layout</h3><div class="seg">${['none', 'row', 'column'].map((l) => `<button data-set-layout="${l}" class="${l === lay ? 'on' : ''}">${l === 'none' ? 'Off' : l === 'row' ? '→ Row' : '↓ Column'}</button>`).join('')}</div>
      ${lay !== 'none' ? `<div class="grid">${num('gap', 'Gap', n.gap ?? 0)}<label class="field" title="n, or v h, or t r b l"><span>Pad</span><input data-prop="padding" data-kind="pad" value="${Array.isArray(n.padding) ? n.padding.join(' ') : n.padding ?? 0}"></label></div>
      <div class="grid">${sel('align', 'Align', n.align ?? 'start', ['start', 'center', 'end', 'stretch'])}${sel('justify', 'Just', n.justify ?? 'start', ['start', 'center', 'end', 'space-between'])}</div>` : ''}
      <label class="check"><input type="checkbox" data-prop="clip" data-kind="bool" ${n.clip !== false ? 'checked' : ''}> Clip content</label></div>`;
  }
  if (n.type === 'text') {
    h += `<div class="insp"><h3>Text</h3><textarea class="field-area" data-prop="text" data-kind="str" rows="3">${esc(n.text ?? '')}</textarea>
      <label class="field"><span>Font</span><input data-prop="fontFamily" data-kind="str" value="${esc(n.fontFamily ?? '')}" placeholder="Helvetica Neue"></label>
      <div class="grid">${num('fontSize', 'Size', n.fontSize ?? 16)}${sel('fontWeight', 'Wt', String(n.fontWeight ?? 400), ['100', '200', '300', '400', '500', '600', '700', '800', '900'])}</div>
      <div class="grid">${num('lineHeight', 'LH', n.lineHeight ?? 1.3, 0.05)}${num('letterSpacing', 'LS', n.letterSpacing ?? 0, 0.1)}</div>
      <div class="seg">${['left', 'center', 'right'].map((a) => `<button data-set-align="${a}" class="${(n.textAlign ?? 'left') === a ? 'on' : ''}">${a}</button>`).join('')}</div>
      ${colorField('color', 'Color', n.color ?? '#111111', false)}
      <label class="check"><input type="checkbox" data-prop="italic" data-kind="bool" ${n.italic ? 'checked' : ''}> Italic</label></div>`;
  }
  if (n.type === 'image') {
    h += `<div class="insp"><h3>Image</h3>${sel('fit', 'Fit', n.fit ?? 'cover', ['cover', 'contain', 'fill'])}
      <label class="btn small" style="text-align:center">Replace image…<input type="file" accept="image/*" data-upload hidden></label></div>`;
  }
  if (n.type === 'svg') {
    h += `<div class="insp"><h3>SVG</h3><textarea class="field-area mono" data-prop="svg" data-kind="str" rows="5">${esc(n.svg ?? '')}</textarea>${colorField('color', 'Color', n.color ?? '', true)}</div>`;
  }
  if (n.type === 'path') {
    h += `<div class="insp"><h3>Path</h3><textarea class="field-area mono" data-prop="d" data-kind="str" rows="3">${esc(n.d ?? '')}</textarea></div>`;
  }
  if (n.type !== 'text' && n.type !== 'svg') {
    h += `<div class="insp"><h3>Fill</h3>${colorField('fill', 'Fill', n.fill === undefined ? (n.type === 'frame' ? null : '#d9d9d9') : n.fill)}</div>`;
  }
  h += `<div class="insp"><h3>Stroke &amp; corners</h3><div class="grid">${colorField('stroke', 'Line', n.stroke ?? '')}${num('strokeWidth', 'W', n.strokeWidth ?? 1)}</div>
    ${n.type !== 'ellipse' && n.type !== 'text' ? `<label class="field" title="n or tl tr br bl"><span>Radius</span><input data-prop="radius" data-kind="radius" value="${Array.isArray(n.radius) ? n.radius.join(' ') : n.radius ?? 0}"></label>` : ''}</div>`;
  const sh = n.shadows?.[0];
  h += `<div class="insp"><h3>Shadow <label class="check"><input type="checkbox" data-shadow-toggle ${sh ? 'checked' : ''}></label></h3>
    ${sh ? `<div class="grid3">${num('shadow:x', 'X', sh.x ?? 0)}${num('shadow:y', 'Y', sh.y ?? 4)}${num('shadow:blur', 'B', sh.blur ?? 12)}</div>${colorField('shadow:color', 'Color', sh.color ?? 'rgba(0,0,0,0.15)', false)}` : ''}</div>`;
  h += `<div class="insp"><h3>Note</h3><textarea class="field-area" data-prop="note" data-kind="str" rows="2" placeholder="Design rationale or todo, visible to agents">${esc(n.note ?? '')}</textarea></div>`;
  h += `<div class="insp"><h3>Actions</h3><div class="actions">
    <button class="btn small edit-only" data-act="duplicate">Duplicate</button><button class="btn small edit-only" data-act="forward">Bring forward</button><button class="btn small edit-only" data-act="backward">Send backward</button>
    <button class="btn small" data-act="export-node">Export PNG</button><button class="btn small" data-act="copy-html">Copy HTML</button><button class="btn small" data-act="share-node">Copy share link</button>
    <button class="btn small comment-only" data-act="comment-node">Comment</button><button class="btn small danger edit-only" data-act="delete">Delete</button></div></div>`;
  return h;
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function commentsPanel(): string {
  const list = S.comments.filter((c) => S.showResolved || !c.resolved).sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.time.localeCompare(a.time));
  const idx = S.doc ? indexDoc(S.doc) : new Map();
  return `<div class="panel-head"><span>${S.me?.role === 'viewer' ? 'Comments from people and agents.' : 'Pick the comment tool (C) and click the canvas.'}</span><label class="check"><input type="checkbox" data-show-resolved ${S.showResolved ? 'checked' : ''}> Resolved</label></div>` +
    (list.map((c) => {
      const target = c.nodeId ? (idx.get(c.nodeId)?.node as TandemNode | undefined) : undefined;
      return `<div class="thread ${c.resolved ? 'resolved' : ''}" data-thread="${esc(c.id)}">
      <div><span class="who">${esc(c.author)}</span> <span class="when">${ago(c.time)}</span></div>
      ${c.nodeId ? `<span class="target" data-goto="${esc(c.nodeId)}">on ${esc(target?.name ?? c.nodeId)}${target ? '' : ' (deleted)'}</span>` : ''}
      <div>${esc(c.text)}</div>
      ${c.replies.map((r) => `<div class="reply"><span class="who">${esc(r.author)}</span> <span class="when">${ago(r.time)}</span><div>${esc(r.text)}</div></div>`).join('')}
      ${S.me?.role !== 'viewer' ? `<form data-reply="${esc(c.id)}"><input placeholder="Reply…"><button class="btn small">Send</button></form>
      <div class="row"><button class="btn small ghost" data-resolve="${esc(c.id)}">${c.resolved ? 'Reopen' : 'Resolve'}</button><button class="btn small ghost danger" data-del-comment="${esc(c.id)}">Delete</button></div>` : ''}
    </div>`;
    }).join('') || '<div class="thread meta">No comments yet.</div>');
}

function historyPanel(): string {
  const agents = new Set(['owner', S.me?.name]);
  return `<div class="panel-head"><span>Click a revision to review it. Coral outlines show what changed.</span></div>` + S.history.map((r) => `<div class="rev ${S.preview?.rev === r.rev ? 'active' : ''}" data-rev="${r.rev}">
    <div class="top"><span class="who ${agents.has(r.author) ? '' : 'agent'}">${esc(r.author)}</span><span class="when">#${r.rev} · ${ago(r.time)}</span></div>
    <div class="msg">${esc(r.message)}</div>${r.changed.length ? `<div class="when">${r.changed.length} layer${r.changed.length > 1 ? 's' : ''} changed</div>` : ''}</div>`).join('');
}

// ---------------- panel events ----------------

function parseSize(v: string): number | 'hug' | 'fill' | undefined {
  const t = v.trim().toLowerCase();
  if (t === 'hug' || t === 'fill') return t;
  const n = Number(t);
  return Number.isFinite(n) && t !== '' ? Math.max(0, n) : undefined;
}
function parseNums(v: string): number[] { return v.trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite); }

async function onPanelChange(e: Event) {
  const el = e.target as HTMLInputElement;
  const prop = el.dataset.prop;
  if (!prop || !S.doc) return;
  const kind = el.dataset.kind;
  if (prop === 'page:background') { await ops([{ op: 'update_page', id: S.pageId, background: el.value }], 'Changed page background'); return; }
  const n = selected()[0];
  if (!n) return;
  if (prop.startsWith('shadow:')) {
    const key = prop.slice(7);
    const sh = { ...(n.shadows?.[0] ?? {}) } as Record<string, unknown>;
    sh[key] = key === 'color' ? el.value : Number(el.value);
    await ops([{ op: 'update', id: n.id, props: { shadows: [sh, ...(n.shadows ?? []).slice(1)] } }], 'Changed shadow');
    return;
  }
  let value: unknown;
  const unset: string[] = [];
  switch (kind) {
    case 'num': value = el.value === '' ? undefined : Number(el.value); break;
    case 'size': value = parseSize(el.value); if (value === undefined) return; break;
    case 'bool': value = el.checked; break;
    case 'abs': value = el.checked ? 'absolute' : 'auto'; break;
    case 'color': value = el.value; break;
    case 'colortext': value = el.value.trim() || null; break;
    case 'pad': { const a = parseNums(el.value); value = a.length === 1 ? a[0] : a.length === 2 ? a : a.length === 4 ? a : undefined; if (value === undefined) return; break; }
    case 'radius': { const a = parseNums(el.value); value = a.length === 4 ? a : a[0] ?? 0; break; }
    case 'json': try { value = JSON.parse(el.value); } catch { toast('Invalid JSON', true); return; } break;
    default: value = el.value;
  }
  if (kind === 'str' && prop !== 'text' && value === '') { unset.push(prop); value = undefined; }
  if (prop === 'fontWeight') value = Number(value);
  if (value === null && prop === 'stroke') { unset.push('stroke'); value = undefined; }
  if (value === undefined && !unset.length) unset.push(prop);
  const props = value === undefined ? {} : { [prop]: value };
  await ops([{ op: 'update', id: n.id, props, unset }], `Changed ${prop} of ${n.name ?? n.id}`);
}

async function onPanelClick(e: MouseEvent) {
  const t = (e.target as HTMLElement).closest<HTMLElement>('button, [data-goto], .rev, input[data-shadow-toggle], input[data-show-resolved]');
  if (!t || !S.doc) return;
  const n = selected()[0];
  const d = t.dataset;
  if (d.setLayout && n) {
    const props: Record<string, unknown> = { layout: d.setLayout };
    if (d.setLayout !== 'none' && n.layout === undefined) Object.assign(props, { gap: n.gap ?? 8, padding: n.padding ?? 0 });
    await ops([{ op: 'update', id: n.id, props }], `Set ${n.name ?? n.id} layout to ${d.setLayout}`);
  } else if (d.setAlign && n) await ops([{ op: 'update', id: n.id, props: { textAlign: d.setAlign } }], 'Changed text alignment');
  else if (t.hasAttribute('data-shadow-toggle') && n) {
    const on = (t as HTMLInputElement).checked;
    await ops([on ? { op: 'update', id: n.id, props: { shadows: [{ x: 0, y: 4, blur: 16, color: 'rgba(0,0,0,0.15)' }] } } : { op: 'update', id: n.id, unset: ['shadows'] }], on ? 'Added shadow' : 'Removed shadow');
  } else if (t.hasAttribute('data-show-resolved')) { S.showResolved = (t as HTMLInputElement).checked; render(); }
  else if (d.act) await action(d.act);
  else if (d.goto) { selectNode(d.goto, true); S.tab = 'comments'; }
  else if (d.resolve) {
    const c = S.comments.find((x) => x.id === d.resolve)!;
    await api(`/api/docs/${S.doc.id}/comments/${c.id}`, { method: 'POST', json: { resolved: !c.resolved } });
    await refreshComments();
  } else if (d.delComment) {
    if (!confirm('Delete this comment thread?')) return;
    await api(`/api/docs/${S.doc.id}/comments/${d.delComment}`, { method: 'DELETE' });
    await refreshComments();
  } else if (t.classList.contains('rev')) await previewRevision(Number(d.rev));
}

async function refreshComments() {
  if (!S.doc) return;
  S.comments = await api<Comment[]>(`/api/docs/${S.doc.id}/comments`);
  render();
}

async function previewRevision(rev: number) {
  if (!S.doc || !S.live) return;
  const meta = S.history.find((r) => r.rev === rev);
  if (!meta) return;
  if (S.preview?.rev === rev) { exitPreview(); return; }
  S.preview = meta;
  S.doc = rev === S.live.rev ? S.live : await api<TandemDoc>(`/api/docs/${S.live.id}?rev=${rev}`);
  if (!S.doc.pages.some((p) => p.id === S.pageId)) S.pageId = S.doc.pages[0].id;
  const pageOfChange = meta.changed.map((id) => indexDoc(S.doc!).get(id)?.page.id).find(Boolean);
  if (pageOfChange) S.pageId = pageOfChange;
  S.sel = [];
  render();
}

function exitPreview() {
  S.preview = null;
  S.doc = S.live;
  render();
}

async function action(act: string) {
  if (!S.doc) return;
  const nodes = selected();
  const n = nodes[0];
  const idx = indexDoc(S.doc);
  switch (act) {
    case 'delete': await ops(nodes.map((x) => ({ op: 'delete', id: x.id })), `Deleted ${nodes.map((x) => x.name ?? x.id).join(', ')}`); S.sel = []; render(); break;
    case 'duplicate': {
      const r = await ops(nodes.map((x) => ({ op: 'duplicate', id: x.id })), `Duplicated ${nodes.map((x) => x.name ?? x.id).join(', ')}`);
      if (r) { S.sel = r.created.filter((id) => indexDoc(S.doc!).get(id)?.parent?.id === idx.get(n.id)?.parent?.id); render(); }
      break;
    }
    case 'forward': case 'backward': {
      const w = idx.get(n.id)!;
      const i = w.siblings.indexOf(n);
      const to = act === 'forward' ? Math.min(w.siblings.length - 1, i + 1) : Math.max(0, i - 1);
      if (to !== i) await ops([{ op: 'move', id: n.id, parent: w.parent?.id ?? w.page.id, index: to }], `Reordered ${n.name ?? n.id}`);
      break;
    }
    case 'export-node': window.open(`/api/docs/${S.doc.id}/render.png?node=${encodeURIComponent(n.id)}&scale=2&download=1${S.preview ? `&rev=${S.preview.rev}` : ''}`); break;
    case 'export-page': window.open(`/api/docs/${S.doc.id}/render.png?page=${S.pageId}&scale=2&download=1${S.preview ? `&rev=${S.preview.rev}` : ''}`); break;
    case 'copy-html': await copy(await api<string>(`/api/docs/${S.doc.id}/export?node=${encodeURIComponent(n.id)}&format=html`), 'HTML copied'); break;
    case 'share-node': await copy((await api<{ url: string }>(`/api/docs/${S.doc.id}/share?node=${encodeURIComponent(n.id)}`)).url, 'Share link copied (PNG of this frame, 30 days)'); break;
    case 'share-page': await copy((await api<{ url: string }>(`/api/docs/${S.doc.id}/share?page=${S.pageId}`)).url, 'Share link copied (PNG of this page, 30 days)'); break;
    case 'comment-node': {
      const b = S.boxes.get(n.id)!;
      const s = toScreen(b);
      openCommentPop(s.x + s.w, s.y, { x: b.x + b.w, y: b.y }, n.id);
      break;
    }
  }
}

async function copy(text: string, msg: string) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copy this:', text); }
}

// ---------------- selection & canvas interaction ----------------

function selectNode(id: string | null, focus = false, add = false) {
  if (!id) S.sel = [];
  else if (add) S.sel = S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id];
  else S.sel = [id];
  if (id && S.doc) {
    const w = indexDoc(S.doc).get(id);
    if (w && w.page.id !== S.pageId) { S.pageId = w.page.id; drawCanvas(); }
    // expand ancestors in the layer tree
    let p = w?.parent;
    while (p) { S.collapsed.delete(p.id); p = indexDoc(S.doc).get(p.id)?.parent ?? null; }
  }
  render();
  if (focus && id) zoomToFit([id]);
}

function hitNode(target: EventTarget | null): string | null {
  let el = (target as Element | null)?.closest?.('[data-id]');
  if (!el || !S.doc) return null;
  const idx = indexDoc(S.doc);
  while (el) {
    const id = el.getAttribute('data-id')!;
    if (!(idx.get(id)?.node as TandemNode | undefined)?.locked) return id;
    el = el.parentElement?.closest('[data-id]') ?? null;
  }
  return null;
}

/** Deepest frame containing a page point, for placing newly drawn shapes. */
function frameAt(pt: { x: number; y: number }): TandemNode | null {
  const pg = page();
  if (!pg) return null;
  let best: TandemNode | null = null;
  const visit = (list: TandemNode[]) => {
    for (const n of list) {
      if (n.type !== 'frame' || n.visible === false) continue;
      const b = S.boxes.get(n.id);
      if (b && pt.x >= b.x && pt.y >= b.y && pt.x <= b.x + b.w && pt.y <= b.y + b.h) { best = n; visit(n.children ?? []); }
    }
  };
  visit(pg.children);
  return best;
}

function movable(id: string): boolean {
  if (!S.doc) return false;
  const w = indexDoc(S.doc).get(id);
  if (!w || w.node.locked) return false;
  return !w.parent || !isAuto(w.parent) || w.node.position === 'absolute';
}

function onPointerDown(e: PointerEvent) {
  const st = stage();
  st.setPointerCapture(e.pointerId);
  const pt = localPoint(e);
  const pp = toPage(pt.x, pt.y);
  ($('#comment-pop') as HTMLElement).hidden = true;
  if (e.button === 1 || S.tool === 'hand' || S.space) {
    S.drag = { kind: 'pan', sx: pt.x, sy: pt.y, px: S.panX, py: S.panY };
    st.classList.add('panning');
    return;
  }
  const tgt = e.target as Element;
  const pin = tgt.closest('[data-comment]');
  if (pin) { S.tab = 'comments'; render(); $(`[data-thread="${pin.getAttribute('data-comment')}"]`)?.scrollIntoView({ block: 'center' }); return; }
  if (S.tool === 'comment') {
    if (S.me?.role === 'viewer') return;
    openCommentPop(pt.x, pt.y, pp, hitNode(tgt) ?? undefined);
    return;
  }
  if (!canEdit() && S.tool !== 'select') return;
  if (S.tool !== 'select') { S.drag = { kind: 'create', tool: S.tool, start: pp, rect: { x: pp.x, y: pp.y, w: 0, h: 0 } }; return; }

  const handle = tgt.getAttribute('data-handle');
  if (handle && S.sel.length === 1 && canEdit()) {
    const n = selected()[0];
    S.drag = { kind: 'resize', handle, start: pp, id: n.id, box: { ...S.boxes.get(n.id)! }, x: n.x ?? 0, y: n.y ?? 0, w: n.width, h: n.height };
    return;
  }
  const label = tgt.getAttribute('data-label');
  const id = label ?? hitNode(tgt);
  if (!id) { selectNode(null); S.drag = null; return; }
  if (!S.sel.includes(id) || e.shiftKey) selectNode(id, false, e.shiftKey);
  if (!canEdit()) return;
  const idx = indexDoc(S.doc!);
  const starts = S.sel.filter(movable).map((sid) => { const n = idx.get(sid)!.node; return { id: sid, x: n.x ?? 0, y: n.y ?? 0 }; });
  if (starts.length) S.drag = { kind: 'move', start: pp, starts, moved: false };
}

function onPointerMove(e: PointerEvent) {
  const pt = localPoint(e);
  const pp = toPage(pt.x, pt.y);
  const d = S.drag;
  if (!d) {
    const id = S.tool === 'select' ? hitNode(e.target) : null;
    if (id !== S.hover) { S.hover = id; drawOverlay(); }
    return;
  }
  if (d.kind === 'pan') {
    S.panX = (d.px as number) + pt.x - (d.sx as number);
    S.panY = (d.py as number) + pt.y - (d.sy as number);
    drawWorld();
  } else if (d.kind === 'create') {
    const s = d.start as { x: number; y: number };
    d.rect = { x: Math.min(s.x, pp.x), y: Math.min(s.y, pp.y), w: Math.abs(pp.x - s.x), h: Math.abs(pp.y - s.y) };
    drawOverlay();
  } else if (d.kind === 'move') {
    const s = d.start as { x: number; y: number };
    let dx = pp.x - s.x, dy = pp.y - s.y;
    if (!d.moved && Math.hypot(dx * S.zoom, dy * S.zoom) < 3) return;
    d.moved = true;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const idx = indexDoc(S.doc!);
    for (const m of d.starts as { id: string; x: number; y: number }[]) {
      const n = idx.get(m.id)!.node;
      n.x = Math.round(m.x + dx);
      n.y = Math.round(m.y + dy);
    }
    drawCanvas();
  } else if (d.kind === 'resize') {
    const b = d.box as Box;
    const s = d.start as { x: number; y: number };
    const dx = pp.x - s.x, dy = pp.y - s.y;
    const h = d.handle as string;
    let x = b.x, y = b.y, w = b.w, hh = b.h;
    if (h.includes('e')) w = b.w + dx;
    if (h.includes('w')) { w = b.w - dx; x = b.x + dx; }
    if (h.includes('s')) hh = b.h + dy;
    if (h.includes('n')) { hh = b.h - dy; y = b.y + dy; }
    if (e.shiftKey && b.w && b.h) { const r = b.w / b.h; if (w / hh > r) hh = w / r; else w = hh * r; }
    w = Math.max(1, Math.round(w)); hh = Math.max(1, Math.round(hh));
    const n = indexDoc(S.doc!).get(d.id as string)!.node;
    n.width = w;
    if (n.type !== 'text' || h.includes('n') || h.includes('s')) n.height = hh;
    if (movable(n.id)) { n.x = Math.round((d.x as number) + (x - b.x)); n.y = Math.round((d.y as number) + (y - b.y)); }
    d.changed = true;
    drawCanvas();
  }
}

async function onPointerUp(e: PointerEvent) {
  const d = S.drag;
  S.drag = null;
  stage().classList.remove('panning');
  if (!d || !S.doc) return;
  const idx = indexDoc(S.doc);
  if (d.kind === 'move' && d.moved) {
    const list = (d.starts as { id: string }[]).map((m) => { const n = idx.get(m.id)!.node; return { op: 'update', id: m.id, props: { x: n.x, y: n.y } }; });
    await ops(list, `Moved ${(d.starts as { id: string }[]).map((m) => idx.get(m.id)!.node.name ?? m.id).join(', ')}`);
  } else if (d.kind === 'resize' && d.changed) {
    const n = idx.get(d.id as string)!.node;
    const props: Record<string, unknown> = { width: n.width };
    if (n.type !== 'text' || typeof n.height === 'number') props.height = n.height;
    if (movable(n.id)) Object.assign(props, { x: n.x, y: n.y });
    await ops([{ op: 'update', id: n.id, props }], `Resized ${n.name ?? n.id}`);
  } else if (d.kind === 'create') {
    const r = d.rect as Box;
    // the tool picked at pointerdown; S.tool may already be the next one the user chose
    const tool = d.tool as Tool;
    if (S.tool === tool) setTool('select');
    const small = r.w * S.zoom < 4 && r.h * S.zoom < 4;
    const defaults: Record<string, [number, number]> = { frame: [400, 300], rect: [100, 100], ellipse: [100, 100], text: [0, 0] };
    const [dw, dh] = defaults[tool] ?? [100, 100];
    const box = small ? { x: r.x, y: r.y, w: dw, h: dh } : r;
    const parent = frameAt({ x: box.x, y: box.y });
    const pb = parent ? S.boxes.get(parent.id)! : null;
    const node: Record<string, unknown> = { type: tool };
    if (!parent || !isAuto(parent)) { node.x = Math.round(box.x - (pb?.x ?? 0)); node.y = Math.round(box.y - (pb?.y ?? 0)); }
    if (tool === 'text') { node.text = 'Text'; node.fontSize = 16; if (!small) node.width = Math.round(box.w); }
    else { node.width = Math.round(box.w); node.height = Math.round(box.h); }
    if (tool === 'frame') { node.fill = '#ffffff'; node.name = parent ? 'Frame' : `Frame ${page()!.children.filter((n) => n.type === 'frame').length + 1}`; }
    const res = await ops([{ op: 'create', parent: parent?.id ?? S.pageId, node }], `Added ${tool}`);
    if (res?.created[0]) {
      selectNode(res.created[0]);
      if (tool === 'text') { const ta = $<HTMLTextAreaElement>('#panel textarea[data-prop="text"]'); ta?.focus(); ta?.select(); }
    }
  }
  void e;
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const pt = localPoint(e);
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002)), pt.x, pt.y);
  else { S.panX -= e.deltaX; S.panY -= e.deltaY; drawWorld(); }
}

function onDblClick(e: MouseEvent) {
  // the first click re-rendered the canvas, so e.target is stale; hit-test what is under the pointer now
  const id = hitNode(document.elementFromPoint(e.clientX, e.clientY));
  if (!id || !S.doc) return;
  const n = indexDoc(S.doc).get(id)!.node;
  if (n.type === 'text') { selectNode(id); S.tab = 'design'; render(); const ta = $<HTMLTextAreaElement>('#panel textarea[data-prop="text"]'); ta?.focus(); ta?.select(); }
}

function openCommentPop(sx: number, sy: number, pp: { x: number; y: number }, nodeId?: string) {
  const f = $<HTMLFormElement>('#comment-pop');
  f.hidden = false;
  f.style.left = `${Math.min(sx + 12, stage().clientWidth - 280)}px`;
  f.style.top = `${Math.max(8, sy - 20)}px`;
  f.dataset.x = String(pp.x); f.dataset.y = String(pp.y); f.dataset.node = nodeId ?? '';
  const ta = $<HTMLTextAreaElement>('textarea', f);
  ta.value = '';
  ta.focus();
}

function setTool(t: Tool) {
  if (S.me?.role === 'viewer' && t !== 'select' && t !== 'hand') return;
  S.tool = t;
  $$('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  stage().setAttribute('class', `tool-${t}`);
}

// ---------------- toasts, dialogs, live ----------------

function toast(html: string, error = false) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (error) el.style.borderLeftColor = 'var(--danger)';
  el.innerHTML = html;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

interface DocSummary { id: string; name: string; updated: string; rev: number; pages: { frames: unknown[] }[] }

let homeTimer = 0;
const onHome = () => !new URLSearchParams(location.hash.slice(1)).get('doc');

async function showHome() {
  const docs = await api<DocSummary[]>('/api/docs');
  // a design may have been opened while the list was loading; live refreshes must not cover it
  if (!onHome()) return;
  ($('#home') as HTMLElement).hidden = false;
  document.title = 'Your designs · Tandem';
  ($('#home-new') as HTMLElement).hidden = S.me?.role === 'viewer';
  ($('#home-empty') as HTMLElement).hidden = docs.length > 0;
  $('#home-grid').innerHTML = docs.map((d) => {
    const frames = d.pages.reduce((a, p) => a + p.frames.length, 0);
    return `<li><a class="home-card" href="#doc=${esc(d.id)}"><div class="home-thumb"><img src="/api/docs/${esc(d.id)}/thumb.png?rev=${d.rev}" alt="" loading="lazy"></div>
      <div class="home-meta"><b>${esc(d.name)}</b><span>${ago(d.updated)} · ${frames} frame${frames === 1 ? '' : 's'} · rev ${d.rev}</span></div></a>
      ${S.me?.role !== 'viewer' ? `<button class="btn small home-del" data-del-doc="${esc(d.id)}" aria-label="Delete ${esc(d.name)}">Delete</button>` : ''}</li>`;
  }).join('');
}

/** #doc=<id>[&node=<id>] opens a design; anything else shows the home screen. */
async function route() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const docId = hash.get('doc');
  if (!docId) { await showHome(); return; }
  clearTimeout(homeTimer);
  ($('#home') as HTMLElement).hidden = true;
  if (S.live?.id !== docId) { S.preview = null; S.sel = []; await loadDoc(docId); }
  else { document.title = `${S.live.name} · Tandem`; render(); }
  const node = hash.get('node');
  if (node && S.doc && indexDoc(S.doc).has(node)) selectNode(node, true);
}

async function openConnect() {
  const base = S.me!.publicUrl;
  const body = $('#connect-body');
  const owner = S.me!.role === 'owner';
  const [tokenRows, apps, people] = owner
    ? await Promise.all([
      api<{ name: string; role: string; created: string; lastUsed?: string }[]>('/api/tokens'),
      api<{ id: string; app: string; name: string; role: string; approvedBy: string; lastUsed?: string; redirect: string }[]>('/api/apps'),
      api<{ members: { email: string; name: string; role: string; lastSeen?: string }[]; google: boolean }>('/api/members'),
    ])
    : [[], [], { members: [], google: false }];
  body.innerHTML = `<div class="connect">
    <h3>Apps with sign-in (claude.ai, ChatGPT, Cursor…)</h3>
    <p>Add a custom connector with this URL. The app asks you to approve it here; nothing to copy.</p>
    <pre class="cmd">${esc(base)}/mcp</pre>
    ${apps.length ? `<table class="tokens">${apps.map((a) => `<tr><td><b>${esc(a.app)}</b> <span class="meta">as ${esc(a.name)}</span></td><td>${a.role}</td><td class="meta">${a.lastUsed ? 'used ' + ago(a.lastUsed) : 'not used yet'} · approved by ${esc(a.approvedBy)}</td><td><button class="btn small ghost danger" data-revoke-app="${esc(a.id)}">Disconnect</button></td></tr>`).join('')}</table>` : ''}
    <h3>Coding agents on the Tandem host (one command each)</h3>
    <pre class="cmd">tandem connect claude\ntandem connect codex\ntandem connect opencode</pre>
    <h3>Coding agents elsewhere</h3>
    ${owner ? `<p>Create a token for each agent; its name shows on every change it makes.</p><form id="new-token" class="row" style="justify-content:flex-start"><input name="name" placeholder="token name, e.g. claude-code" pattern="[a-z0-9][a-z0-9._-]{0,39}" required><select name="role"><option>editor</option><option>viewer</option></select><button class="btn primary">Create token</button></form><div id="token-out"></div>` : '<p>Ask the owner for a token.</p>'}
    <pre class="cmd" id="cmds">${esc(connectCommands(base, '<TOKEN>'))}</pre>
    ${tokenRows.length ? `<h3>Tokens</h3><table class="tokens">${tokenRows.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${t.role}</td><td class="meta">${t.lastUsed ? 'used ' + ago(t.lastUsed) : 'never used'}</td><td>${t.role === 'owner' && t.name === 'owner' ? '' : `<button class="btn small ghost danger" data-revoke="${esc(t.name)}">Revoke</button>`}</td></tr>`).join('')}</table>` : ''}
    ${owner ? `<h3>People</h3><p>${people.google ? 'These people can sign in with Google.' : 'Google sign-in is off on this server (set TANDEM_NEON_AUTH_URL). People below can sign in once it is on.'}</p>
    <form id="new-member" class="row" style="justify-content:flex-start"><input name="email" type="email" placeholder="name@example.com" required><select name="role"><option>editor</option><option>viewer</option><option>owner</option></select><button class="btn">Add person</button></form>
    ${people.members.length ? `<table class="tokens">${people.members.map((m) => `<tr><td><b>${esc(m.name)}</b> <span class="meta">${esc(m.email)}</span></td><td>${m.role}</td><td class="meta">${m.lastSeen ? 'seen ' + ago(m.lastSeen) : 'not signed in yet'}</td><td><button class="btn small ghost danger" data-remove-member="${esc(m.email)}">Remove</button></td></tr>`).join('')}</table>` : ''}` : ''}
  </div>`;
  const d = $<HTMLDialogElement>('#connect-dialog');
  if (!d.open) d.showModal();
}

function connectCommands(base: string, tok: string) {
  return `# Claude Code
claude mcp add --scope user --transport http tandem ${base}/mcp --header "Authorization: Bearer ${tok}"

# Codex (token from the environment)
export TANDEM_TOKEN=${tok}
codex mcp add tandem --url ${base}/mcp --bearer-token-env-var TANDEM_TOKEN

# opencode
opencode mcp add --global tandem --url ${base}/mcp --header "Authorization=Bearer ${tok}"

# Any MCP client (JSON config)
{ "mcpServers": { "tandem": { "type": "http", "url": "${base}/mcp", "headers": { "Authorization": "Bearer ${tok}" } } } }`;
}

function connectEvents() {
  const live = $('#live');
  const es = new EventSource('/api/events');
  es.onopen = () => { live.classList.add('on'); $('#live-text').textContent = 'Live'; };
  es.onerror = () => { live.classList.remove('on'); $('#live-text').textContent = 'Reconnecting…'; };
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data) as { type: string; docId?: string; rev?: number; author?: string; message?: string; changed?: string[] };
    if (onHome() && (ev.type === 'docs' || ev.type === 'doc')) { clearTimeout(homeTimer); homeTimer = window.setTimeout(() => { if (onHome()) void showHome(); }, 400); }
    if (!S.doc) return;
    if (ev.type === 'comments' && ev.docId === S.live?.id) { await refreshComments(); return; }
    if (ev.type !== 'doc' || ev.docId !== S.live?.id || (S.live && ev.rev! <= S.live.rev)) return;
    if (ev.author !== S.me?.name) {
      const until = Date.now() + 3000;
      for (const id of ev.changed ?? []) S.flash.set(id, until);
      toast(`<b>${esc(ev.author ?? '')}</b> · ${esc(ev.message ?? '')}`);
      setTimeout(() => drawOverlay(), 3100);
    }
    if (S.drag) return; // the next load picks it up
    await loadDoc(S.live!.id);
  };
}

// ---------------- keyboard ----------------

function onKey(e: KeyboardEvent) {
  const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
  if (e.code === 'Space' && !typing) { S.space = e.type === 'keydown'; if (!typing) e.preventDefault(); return; }
  if (e.type !== 'keydown' || typing) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); void undo(); return; }
  if (mod && k === 'd') { e.preventDefault(); if (S.sel.length) void action('duplicate'); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); const r = stage().getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); return; }
  if (mod && k === '-') { e.preventDefault(); const r = stage().getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); return; }
  if (mod && k === '0') { e.preventDefault(); const r = stage().getBoundingClientRect(); zoomAt(1 / S.zoom, r.width / 2, r.height / 2); return; }
  if (e.shiftKey && e.code === 'Digit1') { zoomToFit(); return; }
  if (e.shiftKey && e.code === 'Digit2' && S.sel.length) { zoomToFit(S.sel); return; }
  if (mod) return;
  if ((k === 'backspace' || k === 'delete') && S.sel.length && canEdit()) { e.preventDefault(); void action('delete'); return; }
  if (k === 'escape') {
    ($('#comment-pop') as HTMLElement).hidden = true;
    if (S.tool !== 'select') { setTool('select'); return; }
    const parent = S.sel.length === 1 && S.doc ? indexDoc(S.doc).get(S.sel[0])?.parent : null;
    selectNode(parent?.id ?? null);
    return;
  }
  if (k.startsWith('arrow') && S.sel.length && canEdit()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
    const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
    const idx = indexDoc(S.doc!);
    void ops(S.sel.filter(movable).map((id) => { const n = idx.get(id)!.node; return { op: 'update', id, props: { x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy } }; }), 'Nudged');
    return;
  }
  const tools: Record<string, Tool> = { v: 'select', h: 'hand', f: 'frame', r: 'rect', o: 'ellipse', t: 'text', c: 'comment' };
  if (tools[k]) setTool(tools[k]);
}

// Undo restores the revision before your latest change. That restore is itself a revision, so the
// chain remembers where it stands: pressing Cmd+Z again steps further back instead of undoing the undo.
const undoChain = { rev: -1, base: -1 }; // rev: the restore we made; base: the revision it restored

async function undo() {
  if (!S.live || !canEdit()) return;
  await loadHistory();
  const latest = S.history[0];
  if (!latest) return;
  const cur = latest.rev === undoChain.rev ? undoChain.base : latest.rev;
  const change = S.history.find((r) => r.rev === cur);
  if (!change || cur === 0) { toast('Nothing left to undo.'); return; }
  if (change.author !== S.me?.name) { toast(`The change before this is by <b>${esc(change.author)}</b>. Use History to restore an earlier version.`); return; }
  const r = await api<{ rev: number }>(`/api/docs/${S.live.id}/restore`, { method: 'POST', json: { rev: cur - 1 } });
  undoChain.rev = r.rev;
  undoChain.base = cur - 1;
  await loadDoc(S.live.id);
  toast(`Undid “${esc(change.message)}”`);
}

// ---------------- wiring ----------------

function wire() {
  const st = stage();
  st.addEventListener('pointerdown', onPointerDown);
  st.addEventListener('pointermove', onPointerMove);
  st.addEventListener('pointerup', (e) => void onPointerUp(e));
  st.addEventListener('wheel', onWheel, { passive: false });
  st.addEventListener('dblclick', onDblClick);
  st.addEventListener('pointerleave', () => { if (S.hover) { S.hover = null; drawOverlay(); } });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('resize', () => drawWorld());
  // Safari pinch-zoom
  let gs = 1;
  window.addEventListener('gesturestart', (e) => { e.preventDefault(); gs = 1; });
  window.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const ge = e as unknown as { scale: number; clientX: number; clientY: number };
    const pt = localPoint(ge);
    zoomAt(ge.scale / gs, pt.x, pt.y);
    gs = ge.scale;
  });

  $$('.tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
  $$('#tabs button').forEach((b) => b.addEventListener('click', async () => { S.tab = b.dataset.tab as typeof S.tab; if (S.tab === 'history') await loadHistory(); drawPanel(); }));
  $('#panel').addEventListener('change', (e) => void onPanelChange(e));
  $('#panel').addEventListener('click', (e) => void onPanelClick(e));
  $('#panel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const input = $<HTMLInputElement>('input', f);
    if (!f.dataset.reply || !input.value.trim()) return;
    await api(`/api/docs/${S.doc!.id}/comments/${f.dataset.reply}`, { method: 'POST', json: { reply: input.value } });
    await refreshComments();
  });
  $('#panel').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-upload]') || !input.files?.[0]) return;
    const file = input.files[0];
    const { id } = await api<{ id: string }>('/api/assets', { method: 'POST', body: file, headers: { 'content-type': file.type } });
    await ops([{ op: 'update', id: S.sel[0], props: { src: id } }], 'Replaced image');
  });

  $('#banner').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('[data-exit-preview]')) exitPreview();
    if (t.matches('[data-restore]') && S.preview && S.live) {
      const rev = S.preview.rev;
      if (!confirm(`Restore revision ${rev}? This adds a new revision; nothing is lost.`)) return;
      await api(`/api/docs/${S.live.id}/restore`, { method: 'POST', json: { rev } });
      exitPreview();
      await loadDoc(S.live.id);
    }
  });

  $('#pages').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const del = t.closest<HTMLElement>('[data-del-page]');
    if (del) { if (confirm('Delete this page?')) await ops([{ op: 'delete_page', id: del.dataset.delPage! }], 'Deleted page'); return; }
    const li = t.closest<HTMLElement>('[data-page]');
    if (li) { S.pageId = li.dataset.page!; S.sel = []; render(); zoomToFit(); }
  });
  $('#pages').addEventListener('dblclick', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
    if (li && canEdit()) inlineRename(li, S.doc!.pages.find((p) => p.id === li.dataset.page)!.name, (name) => ops([{ op: 'update_page', id: li.dataset.page!, name }], 'Renamed page'));
  });
  $('#add-page').addEventListener('click', async () => {
    const r = await ops([{ op: 'create_page', name: `Page ${S.doc!.pages.length + 1}` }], 'Added page');
    if (r) { S.pageId = r.created[0]; render(); }
  });

  $('#layers').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const d = t.dataset;
    if (d.twisty) { if (S.collapsed.has(d.twisty)) S.collapsed.delete(d.twisty); else S.collapsed.add(d.twisty); drawLayers(); return; }
    if (d.eye) { const n = indexDoc(S.doc!).get(d.eye)!.node; await ops([{ op: 'update', id: n.id, props: { visible: n.visible === false } }], `${n.visible === false ? 'Showed' : 'Hid'} ${n.name ?? n.id}`); return; }
    if (d.lock) { const n = indexDoc(S.doc!).get(d.lock)!.node; await ops([{ op: 'update', id: n.id, props: { locked: !n.locked } }], `${n.locked ? 'Unlocked' : 'Locked'} ${n.name ?? n.id}`); return; }
    const li = t.closest<HTMLElement>('[data-node]');
    if (li) selectNode(li.dataset.node!, false, e.shiftKey);
  });
  $('#layers').addEventListener('dblclick', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
    if (!li || !canEdit()) return;
    const n = indexDoc(S.doc!).get(li.dataset.node!)!.node;
    inlineRename($('.name', li), n.name ?? '', (name) => ops([name ? { op: 'update', id: n.id, props: { name } } : { op: 'update', id: n.id, unset: ['name'] }], 'Renamed layer'));
  });
  $('#layers').addEventListener('mouseover', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
    const id = li?.dataset.node ?? null;
    if (id !== S.hover) { S.hover = id; drawOverlay(); }
  });

  const nameInput = $<HTMLInputElement>('#doc-name');
  nameInput.addEventListener('change', () => { if (nameInput.value.trim()) void ops([{ op: 'rename_doc', name: nameInput.value.trim() }], 'Renamed document'); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  $('#docs-btn').addEventListener('click', () => { location.hash = ''; });
  window.addEventListener('hashchange', () => void route());
  $('#home-connect').addEventListener('click', () => void openConnect());
  $('#home-grid').addEventListener('error', (e) => { (e.target as HTMLElement).closest('.home-thumb')?.classList.add('empty'); }, true);
  $('#home-grid').addEventListener('load', (e) => { const img = e.target as HTMLImageElement; if (!img.naturalWidth) img.closest('.home-thumb')?.classList.add('empty'); }, true);
  $('#zoom-btn').addEventListener('click', () => zoomToFit());
  $('#connect-btn').addEventListener('click', () => void openConnect());
  $('#share-btn').addEventListener('click', () => void action(S.sel.length ? 'share-node' : 'share-page'));
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('dialog') as HTMLDialogElement).close()));

  $('#home-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const doc = await api<TandemDoc>('/api/docs', { method: 'POST', json: { name: (f.elements.namedItem('name') as HTMLInputElement).value } });
    f.reset();
    location.hash = `doc=${doc.id}`;
  });
  $('#home-grid').addEventListener('click', async (e) => {
    const del = (e.target as HTMLElement).closest<HTMLElement>('[data-del-doc]');
    if (!del) return;
    e.preventDefault();
    if (!confirm('Delete this design? It moves to the trash folder in the data directory, so it can be recovered.')) return;
    await api(`/api/docs/${del.dataset.delDoc}`, { method: 'DELETE' });
    if (S.live?.id === del.dataset.delDoc) { S.doc = S.live = null; }
    await showHome();
  });

  $('#connect-body').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    if (f.id === 'new-member') {
      try {
        await api('/api/members', { method: 'POST', json: { email: (f.elements.namedItem('email') as HTMLInputElement).value, role: (f.elements.namedItem('role') as HTMLSelectElement).value } });
        await openConnect();
      } catch (err) { toast(esc((err as Error).message), true); }
      return;
    }
    const name = (f.elements.namedItem('name') as HTMLInputElement).value;
    const role = (f.elements.namedItem('role') as HTMLSelectElement).value;
    try {
      const { token } = await api<{ token: string }>('/api/tokens', { method: 'POST', json: { name, role } });
      await openConnect();
      $('#token-out').innerHTML = `<div class="secret">Token for <b>${esc(name)}</b> (shown once): <code>${esc(token)}</code></div>`;
      $('#cmds').textContent = connectCommands(S.me!.publicUrl, token);
    } catch (err) { toast(esc((err as Error).message), true); }
  });
  $('#connect-body').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const app = el.closest<HTMLElement>('[data-revoke-app]');
    if (app) { if (confirm('Disconnect this app? It loses access immediately.')) { await api(`/api/apps/${app.dataset.revokeApp}`, { method: 'DELETE' }); await openConnect(); } return; }
    const mem = el.closest<HTMLElement>('[data-remove-member]');
    if (mem) { if (confirm(`Remove ${mem.dataset.removeMember}? They are signed out everywhere.`)) { await api(`/api/members/${encodeURIComponent(mem.dataset.removeMember!)}`, { method: 'DELETE' }); await openConnect(); } return; }
    const t = el.closest<HTMLElement>('[data-revoke]');
    if (!t || !confirm(`Revoke ${t.dataset.revoke}? Agents using it lose access immediately.`)) return;
    await api(`/api/tokens/${t.dataset.revoke}`, { method: 'DELETE' });
    await openConnect();
  });

  const pop = $<HTMLFormElement>('#comment-pop');
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $<HTMLTextAreaElement>('textarea', pop).value.trim();
    if (!text || !S.live) return;
    await api(`/api/docs/${S.live.id}/comments`, { method: 'POST', json: { pageId: S.pageId, nodeId: pop.dataset.node || undefined, x: Number(pop.dataset.x), y: Number(pop.dataset.y), text } });
    pop.hidden = true;
    setTool('select');
    S.tab = 'comments';
    await refreshComments();
  });
  $('[data-cancel]', pop).addEventListener('click', () => { pop.hidden = true; });
}

function inlineRename(el: HTMLElement, current: string, done: (v: string) => unknown) {
  const input = document.createElement('input');
  input.value = current;
  const old = el.innerHTML;
  el.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    if (save && input.value.trim() !== current) void done(input.value.trim());
    else el.innerHTML = old;
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

async function boot() {
  S.me = await api<Me>('/api/me');
  wire();
  setTool('select');
  connectEvents();
  await route();
}

boot().catch((e) => toast(`Failed to start: ${esc((e as Error).message)}`, true));
