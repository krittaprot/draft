// Edit operations. MCP tools and the browser editor both express changes as ops, which are validated
// and applied to a copy of the document; the store then commits the result as one revision.
import { propsSchema, variablesSchema } from '../shared/schema.ts';
import { ID_RE, NODE_TYPES, indexDoc, newId, walk, type TandemDoc, type TandemNode, type NodeType, type Page } from '../shared/model.ts';
import { layoutPage } from '../shared/layout.ts';
import { compilePredicate, type Predicate } from '../shared/predicate.ts';

export type NodeSpec = Record<string, unknown>;
export type Op =
  | { op: 'create'; parent?: string; index?: number; node: NodeSpec }
  | { op: 'update'; id: string; props?: Record<string, unknown>; unset?: string[] }
  | { op: 'update_where'; where: Predicate; props?: Record<string, unknown>; unset?: string[]; page?: string }
  | { op: 'set_variables'; set?: Record<string, string | number>; unset?: string[]; force?: boolean }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; parent: string; index?: number }
  | { op: 'duplicate'; id: string; dx?: number; dy?: number }
  | { op: 'create_page'; id?: string; name: string; background?: string }
  | { op: 'update_page'; id: string; name?: string; background?: string }
  | { op: 'delete_page'; id: string }
  | { op: 'rename_doc'; name: string };

export class OpError extends Error {}

export interface ApplyResult { doc: TandemDoc; changed: string[]; created: string[]; errors: string[] }

const PROP_KEYS = Object.keys(propsSchema.shape);

function formatIssues(where: string, issues: { path: PropertyKey[]; message: string; code?: string }[]): string {
  return issues.map((i) => {
    const p = i.path.length ? `${where}.${i.path.map(String).join('.')}` : where;
    let msg = `${p}: ${i.message}`;
    if (i.code === 'unrecognized_keys') msg += ` (valid properties: ${PROP_KEYS.join(', ')})`;
    return msg;
  }).join('; ');
}

function validateProps(props: Record<string, unknown>, where: string): Record<string, unknown> {
  const r = propsSchema.safeParse(props);
  if (!r.success) throw new OpError(formatIssues(where, r.error.issues));
  return r.data as Record<string, unknown>;
}

function buildNode(spec: unknown, where: string, taken: Set<string>, created: string[]): TandemNode {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new OpError(`${where}: expected a node object`);
  const { type, id, children, states, overrides, state, ...props } = spec as Record<string, unknown>;
  if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
    throw new OpError(`${where}.type: must be one of ${NODE_TYPES.join(', ')}`);
  }
  let nodeId: string;
  if (id !== undefined) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new OpError(`${where}.id: must match ${ID_RE} (letters, digits, - and _)`);
    if (taken.has(id)) throw new OpError(`${where}.id: "${id}" is already used in this document`);
    nodeId = id;
  } else {
    do nodeId = newId(type.slice(0, 2)); while (taken.has(nodeId));
  }
  taken.add(nodeId);
  created.push(nodeId);
  const node: TandemNode = { id: nodeId, type: type as NodeType, ...validateProps(props, where) };
  if (type === 'instance') {
    if (typeof node.component !== 'string' || !node.component) throw new OpError(`${where}.component: an instance needs the id of a component frame`);
    if (children !== undefined) throw new OpError(`${where}.children: instances have no children — override the component instead`);
    if (states !== undefined) throw new OpError(`${where}.states: only component frames carry states`);
  } else if (children !== undefined) {
    if (type !== 'frame') throw new OpError(`${where}.children: only frames can have children`);
    if (!Array.isArray(children)) throw new OpError(`${where}.children: must be an array`);
    node.children = children.map((c, i) => buildNode(c, `${where}.children[${i}]`, taken, created));
  } else if (type === 'frame') node.children = [];
  if (states !== undefined) {
    if (type !== 'frame') throw new OpError(`${where}.states: only frames can carry states`);
    if (node.component !== true) throw new OpError(`${where}.states: mark the frame as a component (component: true) first`);
    if (!states || typeof states !== 'object' || Array.isArray(states)) throw new OpError(`${where}.states: expected an object of state name → node array`);
    node.states = {};
    for (const [name, patch] of Object.entries(states as Record<string, unknown>)) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new OpError(`${where}.states.${name}: expected an object of child id → props`);
      const clean: Record<string, Record<string, unknown>> = {};
      for (const [target, props2] of Object.entries(patch as Record<string, unknown>)) {
        clean[target] = validateProps((props2 ?? {}) as Record<string, unknown>, `${where}.states.${name}.${target}`);
      }
      node.states[name] = clean;
    }
  }
  if (state !== undefined) {
    if (type !== 'instance') throw new OpError(`${where}.state: only instances select a component state`);
    if (typeof state !== 'string') throw new OpError(`${where}.state: expected a state name`);
    node.state = state;
  }
  if (overrides !== undefined) {
    if (type !== 'instance') throw new OpError(`${where}.overrides: only instances can override component props`);
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new OpError(`${where}.overrides: expected an object of node id → props`);
    node.overrides = {};
    for (const [target, props2] of Object.entries(overrides as Record<string, unknown>)) {
      node.overrides[target] = validateProps((props2 ?? {}) as Record<string, unknown>, `${where}.overrides.${target}`);
    }
  }
  return node;
}

function resolveParent(doc: TandemDoc, parentId: string | undefined): { list: TandemNode[]; page: Page; frame: TandemNode | null } {
  if (!parentId) return { list: doc.pages[0].children, page: doc.pages[0], frame: null };
  const page = doc.pages.find((p) => p.id === parentId);
  if (page) return { list: page.children, page, frame: null };
  const w = indexDoc(doc).get(parentId);
  if (!w) throw new OpError(`parent "${parentId}" not found (use a page id or a frame id)`);
  if (w.node.type !== 'frame') throw new OpError(`parent "${parentId}" is a ${w.node.type}; only frames can contain nodes`);
  w.node.children ??= [];
  return { list: w.node.children, page: w.page, frame: w.node };
}

function insert(list: TandemNode[], node: TandemNode, index?: number) {
  if (index === undefined || index < 0 || index > list.length) list.push(node);
  else list.splice(index, 0, node);
}

/** Puts a new top-level node with no position to the right of everything on the page. */
function autoPlace(page: Page, node: TandemNode) {
  if (node.x !== undefined || node.y !== undefined) return;
  const others = page.children.filter((n) => n !== node && n.visible !== false);
  if (!others.length) { node.x = 0; node.y = 0; return; }
  const boxes = layoutPage({ ...page, children: others });
  let right = -Infinity;
  let top = Infinity;
  for (const n of others) { const b = boxes.get(n.id)!; right = Math.max(right, b.x + b.w); top = Math.min(top, b.y); }
  node.x = Math.round(right + 100);
  node.y = Math.round(top);
}

function cloneWithNewIds(n: TandemNode, taken: Set<string>, created: string[]): TandemNode {
  let id: string;
  do id = newId(n.type.slice(0, 2)); while (taken.has(id));
  taken.add(id);
  created.push(id);
  return { ...structuredClone(n), id, children: n.children?.map((c) => cloneWithNewIds(c, taken, created)) };
}

export function applyOps(source: TandemDoc, ops: Op[], opts: { atomic?: boolean } = {}): ApplyResult {
  if (!Array.isArray(ops) || !ops.length) throw new OpError('no operations given');
  if (ops.length > 500) throw new OpError('at most 500 operations per call');
  const doc: TandemDoc = structuredClone(source);
  const changed = new Set<string>();
  const created: string[] = [];
  const errors: string[] = [];
  const taken = new Set<string>([...indexDoc(doc).keys(), ...doc.pages.map((p) => p.id)]);

  ops.forEach((op, i) => {
    const where = `ops[${i}]`;
    try {
      switch (op.op) {
        case 'create': {
          const { list, page, frame } = resolveParent(doc, op.parent);
          const before = created.length;
          const node = buildNode(op.node, 'node', taken, created);
          insert(list, node, op.index);
          if (!frame) autoPlace(page, node);
          created.slice(before).forEach((id) => changed.add(id));
          break;
        }
        case 'update': {
          const w = indexDoc(doc).get(op.id);
          if (!w) throw new OpError(`node "${op.id}" not found`);
          // `state` lives beside props (like children), not inside the validated prop schema
          const { state, ...rest } = (op.props ?? {}) as Record<string, unknown>;
          const props = validateProps(rest, 'props');
          if (state !== undefined) {
            if (w.node.type !== 'instance') throw new OpError('state only applies to instances');
            w.node.state = String(state);
          }
          for (const k of op.unset ?? []) {
            if (!PROP_KEYS.includes(k)) throw new OpError(`unset: unknown property "${k}"`);
            delete (w.node as unknown as Record<string, unknown>)[k];
          }
          if (props.layout && props.layout !== 'none' && w.node.type !== 'frame') throw new OpError('layout only applies to frames');
          Object.assign(w.node, props);
          changed.add(op.id);
          break;
        }
        case 'update_where': {
          const { matches, describe } = compilePredicate(op.where ?? {});
          if (!Object.keys(op.where ?? {}).length) throw new OpError('where: give at least one property to match');
          const props = validateProps(op.props ?? {}, 'props');
          for (const k of op.unset ?? []) if (!PROP_KEYS.includes(k)) throw new OpError(`unset: unknown property "${k}"`);
          const pageId = op.page;
          if (pageId && !doc.pages.some((p) => p.id === pageId)) throw new OpError(`page "${pageId}" not found`);
          const hits: TandemNode[] = [];
          walk(doc, (w) => { if ((!pageId || w.page.id === pageId) && matches(w.node)) hits.push(w.node); });
          if (!hits.length) throw new OpError(`no nodes match ${describe}`);
          for (const node of hits) {
            for (const k of op.unset ?? []) delete (node as unknown as Record<string, unknown>)[k];
            Object.assign(node, props);
            changed.add(node.id);
          }
          break;
        }
        case 'set_variables': {
          const next = { ...(doc.variables ?? {}) };
          for (const key of op.unset ?? []) {
            if (!op.force) {
              const ref = `var:${key}`;
              let used = 0;
              walk(doc, ({ node }) => { if (JSON.stringify(node).includes(ref)) used++; });
              if (used) throw new OpError(`variable ${key} is referenced by ${used} node${used === 1 ? '' : 's'}; pass force to remove it anyway`);
            }
            delete next[key];
          }
          if (op.set !== undefined) Object.assign(next, variablesSchema.parse(op.set));
          doc.variables = next;
          break;
        }
        case 'delete': {
          const w = indexDoc(doc).get(op.id);
          if (!w) throw new OpError(`node "${op.id}" not found`);
          w.siblings.splice(w.siblings.indexOf(w.node), 1);
          changed.add(op.id);
          if (w.parent) changed.add(w.parent.id);
          break;
        }
        case 'move': {
          const idx = indexDoc(doc);
          const w = idx.get(op.id);
          if (!w) throw new OpError(`node "${op.id}" not found`);
          for (let p = idx.get(op.parent); p; p = p.parent ? idx.get(p.parent.id) : undefined) {
            if (p.node.id === op.id) throw new OpError('cannot move a node into itself');
          }
          const from = w.siblings.indexOf(w.node);
          w.siblings.splice(from, 1);
          const { list, frame } = resolveParent(doc, op.parent);
          insert(list, w.node, op.index);
          changed.add(op.id);
          if (w.parent) changed.add(w.parent.id);
          if (frame) changed.add(frame.id);
          break;
        }
        case 'duplicate': {
          const w = indexDoc(doc).get(op.id);
          if (!w) throw new OpError(`node "${op.id}" not found`);
          const before = created.length;
          const copy = cloneWithNewIds(w.node, taken, created);
          copy.name = (w.node.name ?? w.node.type) + ' copy';
          w.siblings.splice(w.siblings.indexOf(w.node) + 1, 0, copy);
          if (!w.parent && op.dx === undefined && op.dy === undefined) { delete copy.x; delete copy.y; autoPlace(w.page, copy); }
          else { copy.x = (copy.x ?? 0) + (op.dx ?? 20); copy.y = (copy.y ?? 0) + (op.dy ?? 20); }
          created.slice(before).forEach((id) => changed.add(id));
          break;
        }
        case 'create_page': {
          let id = op.id;
          if (id !== undefined && (!ID_RE.test(id) || taken.has(id))) throw new OpError(`page id "${id}" is invalid or taken`);
          id ??= newId('p');
          taken.add(id);
          doc.pages.push({ id, name: String(op.name || 'Page'), background: op.background, children: [] });
          created.push(id);
          changed.add(id);
          break;
        }
        case 'update_page': {
          const p = doc.pages.find((x) => x.id === op.id);
          if (!p) throw new OpError(`page "${op.id}" not found`);
          if (op.name !== undefined) p.name = String(op.name);
          if (op.background !== undefined) p.background = validateProps({ color: op.background }, 'background').color as string;
          changed.add(p.id);
          break;
        }
        case 'delete_page': {
          if (doc.pages.length === 1) throw new OpError('a document needs at least one page');
          const i2 = doc.pages.findIndex((x) => x.id === op.id);
          if (i2 < 0) throw new OpError(`page "${op.id}" not found`);
          doc.pages.splice(i2, 1);
          changed.add(op.id);
          break;
        }
        case 'rename_doc':
          doc.name = String(op.name).slice(0, 200) || doc.name;
          break;
        default:
          throw new OpError(`unknown op "${(op as { op: string }).op}"`);
      }
    } catch (e) {
      const msg = e instanceof OpError ? e.message : e instanceof Error ? e.message : String(e);
      if (opts.atomic !== false) throw new OpError(`${where} (${op.op}): ${msg}`);
      errors.push(`${where} (${op.op}): ${msg}`);
    }
  });
  return { doc, changed: [...changed], created, errors };
}
