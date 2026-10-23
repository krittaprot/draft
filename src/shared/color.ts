// Minimal colour maths shared by rendering diagnostics: parse what the schema allows, composite alpha
// over a backdrop, and measure WCAG contrast.
export interface RGBA { r: number; g: number; b: number; a: number }

const NAMED: Record<string, string> = {
  transparent: 'rgba(0,0,0,0)', black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080',
};

export function parseColor(input: string): RGBA | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const hex = h.length === 3 || h.length === 4 ? h.split('').map((c) => c + c).join('') : h;
    if (hex.length !== 6 && hex.length !== 8) return null;
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const n = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return { r: n(0), g: n(1), b: n(2), a: hex.length === 8 ? n(3) / 255 : 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map((p) => {
    if (p.endsWith('%')) return { pct: true, v: Number(p.slice(0, -1)) };
    return { pct: false, v: Number(p) };
  });
  if (parts.length < 3 || parts.some((p) => !Number.isFinite(p.v))) return null;
  const channel = (i: number) => parts[i].pct ? Math.round((parts[i].v / 100) * 255) : Math.round(parts[i].v);
  const alpha = parts[3] === undefined ? 1 : (parts[3].pct ? parts[3].v / 100 : parts[3].v);
  return { r: clamp(channel(0)), g: clamp(channel(1)), b: clamp(channel(2)), a: Math.max(0, Math.min(1, alpha)) };
}

const clamp = (v: number) => Math.max(0, Math.min(255, v));

/** Paints `top` over `bottom` (both parsed) and returns the opaque result. */
export function composite(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: Math.round(mix(top.r, bottom.r)), g: Math.round(mix(top.g, bottom.g)), b: Math.round(mix(top.b, bottom.b)), a };
}

export function toHex(c: RGBA): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ''}`;
}

export function luminance(c: RGBA): number {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Flattens a colour string over a backdrop string; falls back to the raw value when either is unparseable. */
export function flattenOver(fg: string, backdrop: string | null): string {
  const top = parseColor(fg);
  if (!top) return fg;
  if (top.a >= 1) return toHex(top);
  const bottom = backdrop ? parseColor(backdrop) : null;
  if (!bottom) return fg;
  return toHex(composite(top, { ...bottom, a: 1 }));
}
