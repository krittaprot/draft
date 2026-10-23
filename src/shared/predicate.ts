// Property predicates shared by update_where and find_nodes: `{fill:"#fff", text:{contains:"⌘"}}`.
import type { TandemNode } from './model.ts';

type Scalar = string | number | boolean | null;

export interface MatchOps {
  equals?: Scalar;
  contains?: string;
  startsWith?: string;
  regex?: string;
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
  in?: Scalar[];
  exists?: boolean;
}

export type PredicateValue = Scalar | Scalar[] | MatchOps;
export type Predicate = Record<string, PredicateValue>;

const OPS: (keyof MatchOps)[] = ['equals', 'contains', 'startsWith', 'regex', 'lt', 'lte', 'gt', 'gte', 'in', 'exists'];

/** Accepts a bare scalar (equality), an array (membership) or an explicit operator object. */
export function compilePredicate(where: Predicate): { matches: (n: TandemNode) => boolean; describe: string } {
  const tests: ((n: TandemNode) => boolean)[] = [];
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(where)) {
    const get = (n: TandemNode): unknown => key === 'type' || key === 'id' ? (n as unknown as Record<string, unknown>)[key] : (n as unknown as Record<string, unknown>)[key];
    const isOps = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).some((k) => (OPS as string[]).includes(k));
    if (isOps) {
      const ops = raw as MatchOps;
      parts.push(`${key}(${JSON.stringify(ops)})`);
      tests.push((n) => matchOps(get(n), ops));
    } else if (Array.isArray(raw)) {
      parts.push(`${key} in ${JSON.stringify(raw)}`);
      tests.push((n) => raw.some((v) => get(n) === v));
    } else {
      parts.push(`${key}=${JSON.stringify(raw)}`);
      tests.push((n) => get(n) === raw);
    }
  }
  return {
    describe: parts.join(' and ') || 'everything',
    matches: (n) => tests.every((t) => t(n)),
  };
}

function matchOps(value: unknown, ops: MatchOps): boolean {
  if (ops.exists !== undefined) {
    const present = value !== undefined && value !== null;
    if (present !== ops.exists) return false;
  }
  if (ops.equals !== undefined && value !== ops.equals) return false;
  if (ops.in !== undefined && !ops.in.includes(value as Scalar)) return false;
  if (ops.contains !== undefined) {
    if (typeof value !== 'string' || !value.includes(ops.contains)) return false;
  }
  if (ops.startsWith !== undefined) {
    if (typeof value !== 'string' || !value.startsWith(ops.startsWith)) return false;
  }
  if (ops.regex !== undefined) {
    let re: RegExp;
    try { re = new RegExp(ops.regex); } catch { throw new Error(`invalid regex: ${ops.regex}`); }
    if (typeof value !== 'string' || !re.test(value)) return false;
  }
  if (typeof value === 'number') {
    if (ops.lt !== undefined && !(value < ops.lt)) return false;
    if (ops.lte !== undefined && !(value <= ops.lte)) return false;
    if (ops.gt !== undefined && !(value > ops.gt)) return false;
    if (ops.gte !== undefined && !(value >= ops.gte)) return false;
  } else if (ops.lt !== undefined || ops.lte !== undefined || ops.gt !== undefined || ops.gte !== undefined) {
    return false;
  }
  return true;
}
