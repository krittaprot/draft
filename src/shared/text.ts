// Text measurement shared by the server (PNG screenshots) and the browser editor, so both wrap text
// identically. Measurement walks the same per-glyph fallback chain the renderer emits, so a character the
// primary family lacks is measured with the face that will actually draw it.
import type { TandemNode } from './model.ts';
import { advance, averageWidth, faceFor, FALLBACK_FAMILIES, type FontFace } from './fonts.ts';

// Helvetica advance widths per 1000 em for ASCII 32..126 — the approximation for fonts we do not ship.
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space .. /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
  278, 278, 584, 584, 584, 556, 1015, // : ; < = > ? @
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A-Z
  278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // a-z
  334, 260, 334, 584, // { | } ~
];

function charWidth(c: number): number {
  if (c >= 32 && c <= 126) return ASCII[c - 32] / 1000;
  if (c === 9) return 1.1;
  // Thai combining vowels and tone marks take no horizontal space
  if (c === 0x0e31 || (c >= 0x0e34 && c <= 0x0e3a) || (c >= 0x0e47 && c <= 0x0e4e)) return 0;
  if (c >= 0x0e00 && c <= 0x0e7f) return 0.58;
  if (c >= 0x0300 && c <= 0x036f) return 0; // combining diacritics
  if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60)) return 1;
  if (c >= 0x1f300) return 1.2; // emoji
  return 0.6;
}

export interface TextStyle { family: string; fontSize: number; fontWeight: number; italic: boolean; letterSpacing: number; lineHeight: number; wrap: 'auto' | 'nowrap' | 'truncate'; maxLines?: number }

export function textStyle(n: TandemNode): TextStyle {
  const fontSize = n.fontSize ?? 16;
  return {
    family: n.fontFamily ?? '',
    fontSize,
    fontWeight: n.fontWeight ?? 400,
    italic: n.italic === true,
    letterSpacing: n.letterSpacing ?? 0,
    lineHeight: (n.lineHeight ?? 1.3) * fontSize,
    wrap: n.wrap ?? 'auto',
    maxLines: n.maxLines,
  };
}

/** Faces to try per character: the requested one, then the generic fallbacks that ship with Draft. */
function stack(st: TextStyle): FontFace[] {
  const primary = faceFor(st.family, st.fontWeight, st.italic);
  const out: FontFace[] = primary ? [primary] : [];
  for (const family of FALLBACK_FAMILIES) {
    if (primary && family === primary.family) continue;
    const f = faceFor(family, st.fontWeight, false);
    if (f) out.push(f);
  }
  return out;
}

/** Vertical distance from the top of a line box to the text baseline (CSS half-leading). */
export function baselineOffset(st: TextStyle): number {
  const face = faceFor(st.family, st.fontWeight, st.italic);
  if (!face) return st.lineHeight / 2 + st.fontSize * 0.35;
  const asc = (face.asc / face.upem) * st.fontSize;
  const desc = (Math.abs(face.desc) / face.upem) * st.fontSize;
  return (st.lineHeight - (asc + desc)) / 2 + asc;
}

export function measureLine(s: string, st: TextStyle): number {
  const faces = stack(st);
  if (!faces.length) {
    // unknown family: Helvetica widths with a small weight adjustment, as before
    let em = 0, count = 0;
    for (const ch of s) { em += charWidth(ch.codePointAt(0)!); count++; }
    const weightFactor = 1 + Math.max(-0.04, Math.min(0.1, (st.fontWeight - 400) / 400 * 0.07));
    return em * st.fontSize * weightFactor + st.letterSpacing * count;
  }
  let em = 0, count = 0;
  for (const ch of s) {
    em += glyphWidth(faces, ch.codePointAt(0)!);
    count++;
  }
  return em * st.fontSize + st.letterSpacing * count;
}

function glyphWidth(faces: FontFace[], cp: number): number {
  for (const face of faces) {
    const w = advance(face, cp);
    if (w !== null) return w;
  }
  // no bundled face covers it: script-shaped estimate against the primary face's scale
  const avg = averageWidth(faces[0]);
  if (cp === 9) return 1.1;
  if (cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) return 1;
  if (cp >= 0x1f300) return 1.2;
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.58;
  return avg || 0.6;
}

/** Cuts a line to fit maxWidth, ending with an ellipsis. */
function ellipsize(line: string, st: TextStyle, maxWidth: number): string {
  if (measureLine(line, st) <= maxWidth) return line;
  const chars = [...line];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureLine(chars.slice(0, mid).join('') + '…', st) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + '…';
}

/** Splits text into lines, wrapping at maxWidth when given. */
export function wrapText(text: string, st: TextStyle, maxWidth?: number): string[] {
  const out: string[] = [];
  if (st.wrap === 'nowrap' || st.wrap === 'truncate') {
    const single = text.replace(/\n/g, ' ');
    out.push(st.wrap === 'truncate' && maxWidth !== undefined ? ellipsize(single, st, maxWidth) : single);
    return out;
  }
  for (const para of text.split('\n')) {
    if (maxWidth === undefined || measureLine(para, st) <= maxWidth + 0.5) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(?<= )/)) { // keep trailing spaces with words
      const candidate = line + word;
      if (measureLine(candidate.trimEnd(), st) <= maxWidth + 0.5) { line = candidate; continue; }
      if (line) { out.push(line.trimEnd()); line = ''; }
      if (measureLine(word.trimEnd(), st) <= maxWidth + 0.5) { line = word; continue; }
      // a single word longer than the line (or unspaced scripts like Thai): break by character
      for (const ch of word) {
        if (line && measureLine(line + ch, st) > maxWidth + 0.5) { out.push(line); line = ''; }
        line += ch;
      }
    }
    out.push(line.trimEnd());
  }
  const limit = st.maxLines;
  if (limit && out.length > limit) {
    const kept = out.slice(0, limit);
    kept[limit - 1] = maxWidth === undefined ? ellipsize(kept[limit - 1], st, measureLine(kept[limit - 1], st)) : ellipsize(kept[limit - 1], st, maxWidth);
    return kept;
  }
  return out;
}

export interface Measured { lines: string[]; width: number; height: number; truncated: boolean }

export function measureText(n: TandemNode, maxWidth?: number): Measured {
  const st = textStyle(n);
  const lines = wrapText(n.text ?? '', st, maxWidth);
  const width = Math.ceil(Math.max(0, ...lines.map((l) => measureLine(l, st))));
  const whole = wrapText(n.text ?? '', { ...st, wrap: 'auto', maxLines: undefined }, maxWidth);
  return { lines, width, height: Math.ceil(lines.length * st.lineHeight), truncated: lines.length < whole.length };
}
