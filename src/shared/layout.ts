// Computes the absolute page-space box of every node, including Figma-style auto-layout.
import type { Box, TandemNode, Page } from './model.ts';
import { measureText } from './text.ts';

export type Boxes = Map<string, Box>;
type Size = number | 'hug' | 'fill';
interface Sz { w: number; h: number }

export function isAuto(n: TandemNode): boolean {
  return n.type === 'frame' && (n.layout === 'row' || n.layout === 'column');
}

function spec(n: TandemNode, axis: 'width' | 'height'): Size {
  const v = n[axis];
  if (v !== undefined) return v;
  if (n.type === 'text') return 'hug';
  if (isAuto(n)) return 'hug';
  if ((n.type === 'svg' || n.type === 'path') && n.viewBox) return 'hug';
  if (n.type === 'frame' && n.children?.length) return 'hug';
  return 100;
}

export function padding(n: TandemNode): [number, number, number, number] {
  const p = n.padding ?? 0;
  if (typeof p === 'number') return [p, p, p, p];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return p;
}

function inFlow(k: TandemNode): boolean {
  return k.visible !== false && k.position !== 'absolute';
}

function clampW(n: TandemNode, w: number): number {
  if (n.maxWidth !== undefined) w = Math.min(w, n.maxWidth);
  if (n.minWidth !== undefined) w = Math.max(w, n.minWidth);
  return w;
}

/** Natural size of a node, optionally with its width and/or height decided by the parent. */
export function measure(n: TandemNode, forcedW?: number, forcedH?: number): Sz {
  const ws = spec(n, 'width');
  const hs = spec(n, 'height');
  let w = forcedW ?? (typeof ws === 'number' ? ws : undefined);
  const h = forcedH ?? (typeof hs === 'number' ? hs : undefined);
  if (w !== undefined) w = clampW(n, w);
  if (w !== undefined && h !== undefined) return { w, h };

  if (n.type === 'text') {
    if (w === undefined && n.maxWidth !== undefined) {
      const m = measureText(n, n.maxWidth);
      return { w: clampW(n, m.width), h: h ?? m.height };
    }
    const m = measureText(n, w);
    return { w: w ?? clampW(n, m.width), h: h ?? m.height };
  }
  if ((n.type === 'svg' || n.type === 'path') && n.viewBox) {
    const [, , vw, vh] = n.viewBox;
    if (w !== undefined) return { w, h: h ?? (w * vh) / vw };
    if (h !== undefined) return { w: (h * vw) / vh, h };
    return { w: vw, h: vh };
  }
  if (isAuto(n)) {
    const row = n.layout === 'row';
    const [pt, pr, pb, pl] = padding(n);
    const innerCross = row ? (h !== undefined ? h - pt - pb : undefined) : (w !== undefined ? w - pl - pr : undefined);
    const innerMain = row ? (w !== undefined ? w - pl - pr : undefined) : (h !== undefined ? h - pt - pb : undefined);
    const kids = (n.children ?? []).filter(inFlow);
    const gaps = (n.gap ?? 0) * Math.max(0, kids.length - 1);
    const sizes = kids.map((k) => measureChild(n, k, row, innerCross));
    const isFill = kids.map((k) => spec(k, row ? 'width' : 'height') === 'fill');
    // with the main size known, "fill" children get their final size, which can change their cross size (text wrap)
    if (innerMain !== undefined && isFill.some(Boolean)) {
      const fixed = sizes.reduce((a, s, i) => a + (isFill[i] ? 0 : row ? s.w : s.h), 0);
      const share = Math.max(0, (innerMain - fixed - gaps) / isFill.filter(Boolean).length);
      kids.forEach((k, i) => { if (isFill[i]) sizes[i] = measureChild(n, k, row, innerCross, share); });
    }
    const main = sizes.reduce((a, s) => a + (row ? s.w : s.h), 0) + gaps;
    const cross = Math.max(0, ...sizes.map((s) => (row ? s.h : s.w)));
    const W = row ? main + pl + pr : cross + pl + pr;
    const H = row ? cross + pt + pb : main + pt + pb;
    return { w: w ?? clampW(n, W), h: h ?? H };
  }
  if (n.type === 'frame' && n.children?.length) {
    let W = 0;
    let H = 0;
    for (const k of n.children) {
      if (k.visible === false) continue;
      const s = measure(k);
      W = Math.max(W, (k.x ?? 0) + s.w);
      H = Math.max(H, (k.y ?? 0) + s.h);
    }
    return { w: w ?? W, h: h ?? H };
  }
  return { w: w ?? 100, h: h ?? 100 };
}

/** Size of an auto-layout child when its main-axis size is not "fill". */
function measureChild(parent: TandemNode, k: TandemNode, row: boolean, innerCross: number | undefined, forcedMain?: number): Sz {
  const crossSpec = spec(k, row ? 'height' : 'width');
  const stretch = crossSpec === 'fill' || parent.align === 'stretch';
  const forcedCross = stretch ? innerCross : undefined;
  let s = row ? measure(k, forcedMain, forcedCross) : measure(k, forcedCross, forcedMain);
  // hug text inside a column wraps at the column's width instead of overflowing it
  if (!row && innerCross !== undefined && forcedCross === undefined && crossSpec === 'hug' && k.type === 'text' && s.w > innerCross) {
    s = measure(k, Math.max(0, innerCross), forcedMain);
  }
  return s;
}

export function layoutPage(page: Page): Boxes {
  const boxes: Boxes = new Map();
  for (const n of page.children) {
    const s = measure(n);
    place(n, n.x ?? 0, n.y ?? 0, s.w, s.h, boxes);
  }
  return boxes;
}

function place(n: TandemNode, x: number, y: number, w: number, h: number, boxes: Boxes): void {
  boxes.set(n.id, { x, y, w, h });
  if (n.type !== 'frame' || !n.children) return;
  const [pt, pr, pb, pl] = padding(n);

  const placeAbsolute = (k: TandemNode, innerW: number, innerH: number, ox: number, oy: number) => {
    const fw = k.width === 'fill' ? innerW : undefined;
    const fh = k.height === 'fill' ? innerH : undefined;
    const s = measure(k, fw, fh);
    place(k, ox + (k.x ?? 0), oy + (k.y ?? 0), s.w, s.h, boxes);
  };

  if (!isAuto(n)) {
    for (const k of n.children) placeAbsolute(k, w, h, x, y);
    return;
  }

  const row = n.layout === 'row';
  const innerW = Math.max(0, w - pl - pr);
  const innerH = Math.max(0, h - pt - pb);
  const innerMain = row ? innerW : innerH;
  const innerCross = row ? innerH : innerW;
  const gap = n.gap ?? 0;
  const kids = n.children.filter(inFlow);

  const cross: number[] = [];
  const main: (number | null)[] = [];
  for (const k of kids) {
    const mainSpec = spec(k, row ? 'width' : 'height');
    const s = measureChild(n, k, row, innerCross);
    cross.push(row ? s.h : s.w);
    main.push(mainSpec === 'fill' ? null : row ? s.w : s.h);
  }
  const fills = main.filter((m) => m === null).length;
  const fixed = main.reduce<number>((a, m) => a + (m ?? 0), 0);
  const free = innerMain - fixed - gap * Math.max(0, kids.length - 1);
  const fillSize = fills ? Math.max(0, free / fills) : 0;
  const sizes = main.map((m) => m ?? fillSize);
  const total = sizes.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1);

  let cursor = 0;
  let step = gap;
  const j = n.justify ?? 'start';
  if (!fills) {
    if (j === 'center') cursor = (innerMain - total) / 2;
    else if (j === 'end') cursor = innerMain - total;
    else if (j === 'space-between' && kids.length > 1) step = (innerMain - (total - gap * (kids.length - 1))) / (kids.length - 1);
  }

  kids.forEach((k, i) => {
    const mainSize = sizes[i];
    let crossSize = cross[i];
    // a "fill" child may wrap text differently at its final size: re-measure its cross axis
    if (main[i] === null) {
      const s = measureChild(n, k, row, innerCross, mainSize);
      crossSize = row ? s.h : s.w;
    }
    let off = 0;
    const a = n.align ?? 'start';
    if (a === 'center') off = (innerCross - crossSize) / 2;
    else if (a === 'end') off = innerCross - crossSize;
    const cx = row ? x + pl + cursor : x + pl + off;
    const cy = row ? y + pt + off : y + pt + cursor;
    place(k, cx, cy, row ? mainSize : crossSize, row ? crossSize : mainSize, boxes);
    cursor += mainSize + step;
  });

  for (const k of n.children) if (!inFlow(k)) placeAbsolute(k, w, h, x, y);
}

export function unionBox(list: Box[]): Box {
  if (!list.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...list.map((b) => b.x));
  const y0 = Math.min(...list.map((b) => b.y));
  const x1 = Math.max(...list.map((b) => b.x + b.w));
  const y1 = Math.max(...list.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
