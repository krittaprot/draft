// Renders a page (or one node) to SVG. The browser editor draws this markup directly and the server
// rasterises the same markup to PNG for screenshots, so agents and humans see identical output.
import { DEFAULT_FONT, type Box, type TandemNode, type Fill, type Page } from './model.ts';
import { layoutPage, unionBox, type Boxes } from './layout.ts';
import { measureText, textStyle } from './text.ts';

export interface RenderOptions {
  /** Maps an image src (asset id, data URL) to an href usable in this context, or null if unavailable. */
  assetHref: (src: string) => string | null;
  /** Add data-id attributes for hit testing in the editor. */
  ids?: boolean;
}

const esc = (s: string | number) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const r2 = (v: number) => Math.round(v * 100) / 100;

function b64(s: string): string {
  const g = globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(s, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(s)));
}

class Ctx {
  defs: string[] = [];
  private n = 0;
  constructor(public opts: RenderOptions, public boxes: Boxes) {}
  uid(prefix: string) { return `${prefix}${++this.n}`; }
}

function paint(ctx: Ctx, f: Fill | undefined): string {
  if (f === undefined) return 'none';
  if (typeof f === 'string') return esc(f);
  const id = ctx.uid('g');
  const stops = f.stops.map((s) => `<stop offset="${s.offset}" stop-color="${esc(s.color)}"/>`).join('');
  if (f.type === 'radial') ctx.defs.push(`<radialGradient id="${id}">${stops}</radialGradient>`);
  else {
    // CSS convention: 180deg = top to bottom
    const a = ((f.angle ?? 180) - 90) * (Math.PI / 180);
    const dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
    ctx.defs.push(`<linearGradient id="${id}" x1="${r2(0.5 - dx)}" y1="${r2(0.5 - dy)}" x2="${r2(0.5 + dx)}" y2="${r2(0.5 + dy)}">${stops}</linearGradient>`);
  }
  return `url(#${id})`;
}

function fills(n: TandemNode, fallback?: string): Fill[] {
  if (n.fill === null) return [];
  if (n.fill === undefined) return fallback ? [fallback] : [];
  return Array.isArray(n.fill) ? n.fill : [n.fill];
}

function shapePath(n: TandemNode, b: Box): { tag: string; attrs: string } {
  if (n.type === 'ellipse') return { tag: 'ellipse', attrs: `cx="${r2(b.x + b.w / 2)}" cy="${r2(b.y + b.h / 2)}" rx="${r2(b.w / 2)}" ry="${r2(b.h / 2)}"` };
  const r = n.radius ?? 0;
  if (typeof r === 'number') {
    const rr = Math.min(r, b.w / 2, b.h / 2);
    return { tag: 'rect', attrs: `x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}"${rr ? ` rx="${r2(rr)}"` : ''}` };
  }
  const m = Math.min(b.w / 2, b.h / 2);
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, m));
  const { x, y, w, h } = b;
  const d = `M${r2(x + tl)},${r2(y)}H${r2(x + w - tr)}A${tr},${tr} 0 0 1 ${r2(x + w)},${r2(y + tr)}V${r2(y + h - br)}A${br},${br} 0 0 1 ${r2(x + w - br)},${r2(y + h)}H${r2(x + bl)}A${bl},${bl} 0 0 1 ${r2(x)},${r2(y + h - bl)}V${r2(y + tl)}A${tl},${tl} 0 0 1 ${r2(x + tl)},${r2(y)}Z`;
  return { tag: 'path', attrs: `d="${d}"` };
}

function strokeAttrs(n: TandemNode): string {
  if (!n.stroke) return '';
  let s = ` stroke="${esc(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"`;
  if (n.strokeDash?.length) s += ` stroke-dasharray="${n.strokeDash.join(' ')}"`;
  return s;
}

function shadowFilter(ctx: Ctx, n: TandemNode): string {
  const sh = (n.shadows ?? []).filter((s) => !s.inset);
  if (!sh.length && !n.blur) return '';
  const id = ctx.uid('f');
  let body = '';
  const merge: string[] = [];
  sh.forEach((s, i) => {
    body += `<feDropShadow dx="${s.x ?? 0}" dy="${s.y ?? 4}" stdDeviation="${r2((s.blur ?? 12) / 2)}" flood-color="${esc(s.color ?? 'rgba(0,0,0,0.15)')}" result="s${i}"/>`;
    merge.push(`<feMergeNode in="s${i}"/>`);
  });
  if (sh.length) body += `<feMerge>${merge.join('')}<feMergeNode in="SourceGraphic"/></feMerge>`;
  if (n.blur) body += `<feGaussianBlur stdDeviation="${r2(n.blur / 2)}"/>`;
  ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}</filter>`);
  return ` filter="url(#${id})"`;
}

function renderNode(ctx: Ctx, n: TandemNode): string {
  if (n.visible === false) return '';
  const b = ctx.boxes.get(n.id);
  if (!b) return '';
  const attrs: string[] = [];
  if (ctx.opts.ids) attrs.push(`data-id="${esc(n.id)}"`);
  if (n.opacity !== undefined && n.opacity < 1) attrs.push(`opacity="${n.opacity}"`);
  if (n.rotation) attrs.push(`transform="rotate(${n.rotation} ${r2(b.x + b.w / 2)} ${r2(b.y + b.h / 2)})"`);
  let inner = '';

  switch (n.type) {
    case 'frame':
    case 'rect':
    case 'ellipse': {
      const { tag, attrs: geo } = shapePath(n, b);
      const fl = fills(n, n.type === 'frame' ? undefined : '#d9d9d9');
      const filter = shadowFilter(ctx, n);
      if (!fl.length && (n.stroke || filter)) fl.push('none');
      fl.forEach((f, i) => {
        const last = i === fl.length - 1;
        inner += `<${tag} ${geo} fill="${f === 'none' ? 'none' : paint(ctx, f)}"${last ? strokeAttrs(n) : ''}${i === 0 ? filter : ''}/>`;
      });
      for (const s of (n.shadows ?? []).filter((s) => s.inset)) {
        const id = ctx.uid('c');
        ctx.defs.push(`<clipPath id="${id}"><${tag} ${geo}/></clipPath>`);
        inner += `<g clip-path="url(#${id})"><${tag} ${geo} fill="none" stroke="${esc(s.color ?? 'rgba(0,0,0,0.15)')}" stroke-width="${r2((s.blur ?? 12) / 2 + 2)}" transform="translate(${s.x ?? 0} ${s.y ?? 0})"/></g>`;
      }
      if (n.type === 'frame' && n.children?.length) {
        const kids = n.children.map((k) => renderNode(ctx, k)).join('');
        if (n.clip !== false) {
          const id = ctx.uid('c');
          ctx.defs.push(`<clipPath id="${id}"><${tag} ${geo}/></clipPath>`);
          inner += `<g clip-path="url(#${id})">${kids}</g>`;
        } else inner += kids;
      }
      break;
    }
    case 'text': {
      const st = textStyle(n);
      const { lines } = measureText(n, b.w + 1);
      const anchor = n.textAlign === 'center' ? 'middle' : n.textAlign === 'right' ? 'end' : 'start';
      const tx = n.textAlign === 'center' ? b.x + b.w / 2 : n.textAlign === 'right' ? b.x + b.w : b.x;
      const color = n.color ?? (typeof n.fill === 'string' ? n.fill : '#111111');
      let t = `<text font-family="${esc(n.fontFamily ?? DEFAULT_FONT)}" font-size="${st.fontSize}" font-weight="${st.fontWeight}" fill="${esc(color)}" text-anchor="${anchor}" xml:space="preserve"`;
      if (n.italic) t += ' font-style="italic"';
      if (st.letterSpacing) t += ` letter-spacing="${st.letterSpacing}"`;
      if (n.textDecoration && n.textDecoration !== 'none') t += ` text-decoration="${n.textDecoration}"`;
      t += '>';
      lines.forEach((line, i) => {
        // baseline sits about 0.35em below the middle of the line box
        const by = b.y + i * st.lineHeight + st.lineHeight / 2 + st.fontSize * 0.35;
        t += `<tspan x="${r2(tx)}" y="${r2(by)}">${esc(line) || ' '}</tspan>`;
      });
      inner = t + '</text>';
      break;
    }
    case 'image': {
      const href = n.src ? ctx.opts.assetHref(n.src) : null;
      const { tag, attrs: geo } = shapePath(n, b);
      if (!href) {
        inner = `<${tag} ${geo} fill="#e5e7eb"/><path d="M${r2(b.x + b.w / 2 - 12)},${r2(b.y + b.h / 2 + 8)}l8,-10 6,7 4,-4 6,7z" fill="#9ca3af"/>`;
        break;
      }
      const par = n.fit === 'fill' ? 'none' : n.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice';
      const id = ctx.uid('c');
      ctx.defs.push(`<clipPath id="${id}"><${tag} ${geo}/></clipPath>`);
      inner = `<g clip-path="url(#${id})"${shadowFilter(ctx, n)}><image href="${esc(href)}" x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" preserveAspectRatio="${par}"/></g>`;
      if (n.stroke) inner += `<${tag} ${geo} fill="none"${strokeAttrs(n)}/>`;
      break;
    }
    case 'path': {
      const [vx, vy, vw, vh] = n.viewBox ?? [0, 0, b.w || 1, b.h || 1];
      const tf = `translate(${r2(b.x)} ${r2(b.y)}) scale(${r2(b.w / vw)} ${r2(b.h / vh)}) translate(${-vx} ${-vy})`;
      const fl = fills(n);
      inner = `<path d="${esc(n.d ?? '')}" transform="${tf}" fill="${fl.length ? paint(ctx, fl[0]) : 'none'}"${strokeAttrs(n)}${shadowFilter(ctx, n)}/>`;
      break;
    }
    case 'svg': {
      // embedded as an <image> so scripts or external references inside the markup never execute
      let markup = n.svg ?? '';
      if (n.color) markup = markup.replace(/currentColor/g, n.color);
      if (markup && !/xmlns=/.test(markup)) markup = markup.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      inner = markup ? `<image href="data:image/svg+xml;base64,${b64(markup)}" x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" preserveAspectRatio="xMidYMid meet"${shadowFilter(ctx, n)}/>` : '';
      break;
    }
  }
  return `<g ${attrs.join(' ')}>${inner}</g>`;
}

export interface Rendered { svg: string; body: string; defs: string; box: Box; boxes: Boxes }

/** Renders a whole page, or just the subtree rooted at nodeId (cropped to that node). */
export function renderPage(page: Page, opts: RenderOptions, nodeId?: string, padding = 0): Rendered {
  const boxes = layoutPage(page);
  const ctx = new Ctx(opts, boxes);
  let body: string;
  let box: Box;
  if (nodeId) {
    const node = findIn(page.children, nodeId);
    if (!node) throw new Error(`node ${nodeId} is not on page ${page.id}`);
    body = renderNode(ctx, node);
    box = boxes.get(nodeId)!;
  } else {
    body = page.children.map((n) => renderNode(ctx, n)).join('');
    box = unionBox(page.children.filter((n) => n.visible !== false).map((n) => boxes.get(n.id)!));
  }
  box = { x: box.x - padding, y: box.y - padding, w: Math.max(1, box.w + padding * 2), h: Math.max(1, box.h + padding * 2) };
  const defs = ctx.defs.join('');
  const bg = !nodeId || padding ? `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${esc(page.background ?? '#f5f5f5')}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(box.w)}" height="${r2(box.h)}" viewBox="${r2(box.x)} ${r2(box.y)} ${r2(box.w)} ${r2(box.h)}"><defs>${defs}</defs>${bg}${body}</svg>`;
  return { svg, body, defs, box, boxes };
}

export function findIn(list: TandemNode[], id: string): TandemNode | undefined {
  for (const n of list) {
    if (n.id === id) return n;
    if (n.children) { const f = findIn(n.children, id); if (f) return f; }
  }
  return undefined;
}
