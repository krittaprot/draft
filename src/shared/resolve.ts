// Turns a document page into the tree the renderer draws: document variables resolved, component
// instances expanded (with their overrides and selected state), and paint values flattened. The stored
// document keeps its tokens and instances, so editing stays declarative while every render path —
// screenshot, PNG, SVG, HTML, the editor — sees one concrete tree.
import type { Page, TandemDoc, TandemNode, Variables } from './model.ts';

const VAR_RE = /^var:([A-Za-z][\w-]*)$/;

export interface ResolveOptions {
  /** Transient state per instance id, e.g. {"save-btn": "hover"} — used by screenshots, never stored. */
  states?: Record<string, string>;
  /** Problems found while resolving (unknown variable, missing component, missing state). */
  issues?: string[];
}

export interface ResolvedPage { page: Page; issues: string[] }

/** Replaces "var:name" strings anywhere in a props object, and records unknown names. */
export function resolveVariables(props: Record<string, unknown>, vars: Variables | undefined, issues: string[]): Record<string, unknown> {
  if (!vars) {
    const missing = new Set<string>();
    const scan = (v: unknown) => {
      if (typeof v === 'string') { const m = VAR_RE.exec(v); if (m) missing.add(m[1]); }
      else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    scan(props);
    for (const name of missing) issues.push(`unknown variable var:${name} (no document variables are defined)`);
    return props;
  }
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = VAR_RE.exec(v);
      if (!m) return v;
      const val = vars[m[1]];
      if (val === undefined) { issues.push(`unknown variable var:${m[1]}`); return v; }
      changed = true;
      return val;
    }
    if (Array.isArray(v)) { const out = v.map(walk); return out.some((x, i) => x !== v[i]) ? out : v; }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      let diff = false;
      for (const [k, val] of Object.entries(v)) { out[k] = walk(val); if (out[k] !== val) diff = true; }
      return diff ? out : v;
    }
    return v;
  };
  const out = walk(props) as Record<string, unknown>;
  return changed ? out : out;
}

/** State overlays are prop patches keyed by a component-local child id ("@root" patches the frame). */
function applyOverlay(kids: TandemNode[], overlay: Record<string, Record<string, unknown>> | undefined): TandemNode[] {
  if (!overlay) return kids;
  return kids.map((k) => {
    const patch = overlay[k.id];
    if (!patch) return k;
    const merged: TandemNode = { ...k, ...(patch as Record<string, unknown>) } as TandemNode;
    if (Array.isArray(patch.children)) merged.children = patch.children as TandemNode[];
    return merged;
  });
}

function componentIndex(doc: TandemDoc): Map<string, TandemNode> {
  const map = new Map<string, TandemNode>();
  for (const page of doc.pages) {
    const visit = (list: TandemNode[]) => {
      for (const n of list) {
        if (n.type === 'frame' && n.component === true) map.set(n.id, n);
        if (n.children) visit(n.children);
      }
    };
    visit(page.children);
  }
  return map;
}

const ROOT_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'position', 'locked', 'name', 'note', 'role', 'label'] as const;

function remap(node: TandemNode, prefix: string, overrides: Record<string, Record<string, unknown>> | undefined): TandemNode {
  const local = node.id;
  const own = overrides?.[local];
  const id = `${prefix}~${local}`;
  const out: TandemNode = { ...node, id, ...(own as Record<string, unknown> | undefined) };
  if (out.children) out.children = out.children.map((n) => remap(n, prefix, overrides));
  return out;
}

function placeholder(instance: TandemNode, message: string): TandemNode {
  return {
    id: instance.id,
    type: 'frame',
    width: instance.width ?? 220,
    height: instance.height ?? 48,
    fill: 'rgba(220,38,38,0.06)',
    stroke: '#dc2626',
    strokeWidth: 1,
    strokeDash: [4, 4],
    radius: 6,
    children: [{
      id: `${instance.id}~msg`, type: 'text', text: message, fontFamily: 'Inter', fontSize: 11,
      color: '#b91c1c', x: 8, y: 8, width: (typeof instance.width === 'number' ? instance.width : 220) - 16, lineHeight: 1.4,
    }],
  };
}

function expandInstance(
  instance: TandemNode, doc: TandemDoc, vars: Variables | undefined, opts: ResolveOptions,
  components: Map<string, TandemNode>, stack: string[],
): TandemNode {
  const issues = opts.issues ?? [];
  const wanted = typeof instance.component === 'string' ? instance.component : '';
  const component = components.get(wanted);
  if (!component) return placeholder(instance, `missing component ${wanted || '(none set)'}`);
  if (stack.includes(component.id)) return placeholder(instance, `component cycle: ${[...stack, component.id].join(' → ')}`);

  const state = opts.states?.[instance.id] ?? instance.state ?? 'default';
  const overlay = state === 'default' ? undefined : component.states?.[state];
  if (state !== 'default' && !overlay) {
    issues.push(`missing state "${state}" on component ${component.id}`);
    return placeholder(instance, `component ${component.id} has no state "${state}"`);
  }
  const kids = applyOverlay(component.children ?? [], overlay);
  const prefixed = kids.map((k) => remap(k, instance.id, instance.overrides));
  const root: TandemNode = { ...component, id: instance.id, states: undefined, children: prefixed };
  if (overlay?.['@root']) Object.assign(root, overlay['@root']);
  for (const key of ROOT_KEYS) {
    const v = (instance as unknown as Record<string, unknown>)[key];
    if (v !== undefined) (root as unknown as Record<string, unknown>)[key] = v;
  }
  root.type = 'frame';
  root.component = undefined;
  if (instance.overrides?.['@root']) Object.assign(root, instance.overrides['@root']);
  return resolveNode(root, doc, vars, opts, components, stack.concat(component.id));
}

function resolveNode(
  node: TandemNode, doc: TandemDoc, vars: Variables | undefined, opts: ResolveOptions,
  components: Map<string, TandemNode>, stack: string[],
): TandemNode {
  const issues = opts.issues ?? [];
  if (node.type === 'instance') return expandInstance(node, doc, vars, opts, components, stack);
  const { children, states, overrides, state, ...props } = node as TandemNode;
  const resolved = resolveVariables(props as Record<string, unknown>, vars, opts.issues ?? []);
  const out: TandemNode = { ...(resolved as Record<string, unknown>), id: node.id, type: node.type } as TandemNode;
  if (state !== undefined) out.state = state;
  if (overrides !== undefined) out.overrides = overrides;
  // A component definition can be previewed in one of its states (screenshot of a component, state:"hover").
  const preview = node.component === true && states ? opts.states?.[node.id] : undefined;
  const overlay = preview ? states![preview] : undefined;
  if (preview && !overlay) issues.push(`missing state "${preview}" on ${node.id}`);
  const kids = children ? applyOverlay(children, overlay) : undefined;
  if (kids) out.children = kids.map((k) => resolveNode(k, doc, vars, opts, components, stack));
  if (overlay?.['@root']) Object.assign(out, overlay['@root']);
  if (states) out.states = states;
  return out;
}

/** Expands instances and resolves variables for one page. Safe to call on every render. */
export function resolvePage(page: Page, doc: TandemDoc, opts: ResolveOptions = {}): ResolvedPage {
  const issues = opts.issues ?? [];
  const components = componentIndex(doc);
  const children = page.children.map((n) => resolveNode(n, doc, doc.variables, { ...opts, issues }, components, []));
  return { page: { ...page, children }, issues };
}
