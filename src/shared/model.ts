// The Tandem document model. A document has pages; a page has top-level nodes (usually frames,
// the "artboards"); frames nest. Sizing and auto-layout follow the Figma mental model:
// width/height are a number, "hug" (shrink to content) or "fill" (take the parent's free space).
import type { Props, Variables } from './schema.ts';
export type { Fill, Props, Variables } from './schema.ts';

export const NODE_TYPES = ['frame', 'rect', 'ellipse', 'text', 'image', 'path', 'svg', 'instance'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface TandemNode extends Props {
  id: string;
  type: NodeType;
  children?: TandemNode[];
  /** On a component frame: named states, each a map of component-local child id → prop patch. "@root" patches the frame. */
  states?: Record<string, Record<string, Record<string, unknown>>>;
  /** On an instance: props applied to nodes of the component, keyed by their component-local id. */
  overrides?: Record<string, Record<string, unknown>>;
  /** On an instance: which state of the component to show. */
  state?: string;
}

export interface Page { id: string; name: string; background?: string; children: TandemNode[] }

export interface TandemDoc {
  id: string;
  name: string;
  created: string;
  updated: string;
  rev: number;
  pages: Page[];
  /** Design tokens, referenced from props as "var:name". */
  variables?: Variables;
}

export interface Box { x: number; y: number; w: number; h: number }

export const DEFAULT_FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export const ID_RE = /^[A-Za-z][\w-]{0,63}$/;

export function newId(prefix = 'n'): string {
  const a = new Uint8Array(6);
  globalThis.crypto.getRandomValues(a);
  return prefix + '_' + Array.from(a, (b) => (b % 36).toString(36)).join('');
}

export interface Walked { node: TandemNode; parent: TandemNode | null; page: Page; siblings: TandemNode[]; depth: number }

export function walk(doc: TandemDoc, fn: (w: Walked) => void | false): void {
  for (const page of doc.pages) {
    const visit = (list: TandemNode[], parent: TandemNode | null, depth: number) => {
      for (const node of list) {
        if (fn({ node, parent, page, siblings: list, depth }) === false) continue;
        if (node.children) visit(node.children, node, depth + 1);
      }
    };
    visit(page.children, null, 0);
  }
}

export function indexDoc(doc: TandemDoc): Map<string, Walked> {
  const m = new Map<string, Walked>();
  walk(doc, (w) => { m.set(w.node.id, w); });
  return m;
}

export function findPage(doc: TandemDoc, id: string): Page | undefined {
  return doc.pages.find((p) => p.id === id);
}

export function pageOf(doc: TandemDoc, nodeId: string): Page | undefined {
  return indexDoc(doc).get(nodeId)?.page;
}

/** Plain-language reference of the node model, shared by the MCP instructions and the guide tool. */
export const MODEL_GUIDE = `Draft document model (Figma-like):
- document → pages → nodes. Top-level nodes on a page are usually frames ("artboards", e.g. a 1440x900 desktop screen or a 390x844 phone screen).
- Node types: frame (container, the only type with children), rect, ellipse, text, image, path (SVG path data in "d"), svg (a complete <svg> markup string, ideal for icons).
- Coordinates: x/y are relative to the parent frame. Top-level frames without x/y are placed automatically to the right of existing ones.
- Sizing: width/height = number (px) | "hug" (shrink to content) | "fill" (share the parent's free space; only inside auto-layout frames).
- Auto-layout (frames): layout "row" | "column" | "none" (default none = absolute positioning). gap, padding (n | [vertical, horizontal] | [top,right,bottom,left]), align (cross axis: start|center|end|stretch), justify (main axis: start|center|end|space-between). Children of auto-layout frames ignore x/y unless position:"absolute". Auto-layout frames default to width/height "hug".
- Styling: fill (CSS color, gradient {type:"linear"|"radial", angle, stops:[{offset,color}]}, an array of those, or null), stroke, strokeWidth (with strokeAlign inner|center|outer), strokeDash, radius (n or [tl,tr,br,bl]), opacity, rotation, shadows [{x,y,blur,color}], blur, clip (frames clip children by default). outline:{width,offset,color,dash} draws a ring outside the box without changing layout — use it for focus rings. Alpha colours are composited when rendered; get_node.computed shows the flat value.
- Text controls: wrap auto|nowrap|truncate and maxLines, so a tooltip wraps and a password field does not.
- Text: text, fontSize, fontFamily, fontWeight (100-900), italic, lineHeight (multiplier, default 1.3), letterSpacing (px), textAlign, textDecoration, color. Text with a fixed or fill width wraps; "hug" text grows to its longest line but wraps at the parent's width inside column frames.
- Fonts: fontFamily takes a family from list_fonts (Inter, Geist, Roboto, Open Sans, Lato, Montserrat, Poppins, Work Sans, DM Sans, Manrope, Space Grotesk, Plus Jakarta Sans, Figtree, Public Sans, Outfit, Archivo, Barlow, Rubik, IBM Plex, Source Sans/Serif, Noto Sans, Oswald, Bebas Neue, Anton, Playfair Display, Merriweather, Lora, Libre Baskerville, EB Garamond, DM Serif Display, Instrument Serif, Fraunces, JetBrains Mono, Fira Code, Roboto Mono, Space Mono, Geist Mono, …). Real metrics are used for wrapping and the same files render the PNG and the browser editor, so layouts match. fontWeight picks the nearest shipped weight; unknown families render as Helvetica — list_fonts shows what is safe.
- Image: src = an asset id from upload_image, a data: URL, or an https URL (fetched and stored on create), fit cover|contain|fill, radius.
- svg: svg markup; "currentColor" in it is replaced by the node's color.
- Variables: document-level tokens ({paper:"#faf6ef", space:8}) referenced as "var:paper" in colour props (fill, stroke, color, shadow and outline colours) and in radius, gap, padding and strokeWidth. Change the token once and every node that uses it re-renders. manage_variables sets them; export_tokens emits CSS/JSON/Tailwind.
- Components: a frame with component:true is a definition. {type:"instance", component:"card"} places it; overrides maps component-local ids to props, e.g. {overrides:{"title":{text:"Save"}}}. Instances are resolved at render time, so update_component is just update_nodes on the definition — every instance follows. Use "@root" in overrides to change the instance's own frame.
- States: a component can carry states:{"hover":{"cta":{"fill":"var:accent"}}} — a state is a prop patch keyed by the component-local child id, with "@root" for the frame itself. An instance picks one with state:"hover"; screenshot({node, state:"hover"}) previews a definition's state without saving anything. Because states patch the same tree, editing a child updates every state.
- Every node can carry name and note (design rationale visible to humans in the editor), plus role, label and alt for accessible exports.
- Ids: pass your own readable id (e.g. "hero-title") to refer to nodes later, or let Draft generate one.`;
