// Validation schema for node properties (server only; keeps zod out of the browser bundle).
import { z } from 'zod';

const color = z.string().min(1).max(64).regex(/^[#a-zA-Z0-9(),.%\s-]+$/, 'must be a CSS color like #1f2937 or rgba(0,0,0,0.5)');
/** `var:paper` — a reference to a document variable, resolved at render time. */
const varRef = z.string().min(5).max(64).regex(/^var:[A-Za-z][\w-]*$/, 'must be a variable reference like var:paper');
const paint = z.union([color, varRef]);
const numberOrVar = z.union([z.number(), varRef]);
const stop = z.object({ offset: z.number().min(0).max(1), color: paint }).strict();
const gradient = z.object({
  type: z.enum(['linear', 'radial']),
  angle: z.number().optional(),
  stops: z.array(stop).min(2).max(16),
}).strict();
export const fillSchema = z.union([paint, gradient]);
const size = z.union([z.number().min(0).max(100000), z.enum(['hug', 'fill'])]);
const shadow = z.object({
  x: z.number().default(0), y: z.number().default(4), blur: z.number().min(0).default(12),
  color: paint.default('rgba(0,0,0,0.15)'), inset: z.boolean().optional(),
}).strict();
const box = z.object({
  width: z.number().min(0).max(1000), offset: z.number().min(-100).max(100).default(0),
  color: paint, dash: z.array(z.number().min(0)).max(8).optional(),
}).strict();

export const propsSchema = z.object({
  name: z.string().max(200),
  x: z.number(), y: z.number(),
  width: size, height: size,
  minWidth: z.number().min(0), maxWidth: z.number().min(0),
  rotation: z.number(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(), locked: z.boolean(),
  position: z.enum(['auto', 'absolute']),
  fill: z.union([fillSchema, z.array(fillSchema).max(8), z.null()]),
  stroke: z.union([paint, z.null()]),
  strokeWidth: numberOrVar,
  strokeAlign: z.enum(['inner', 'center', 'outer']),
  strokeDash: z.array(z.number().min(0)).max(8),
  radius: z.union([numberOrVar, z.tuple([numberOrVar, numberOrVar, numberOrVar, numberOrVar])]),
  shadows: z.array(shadow).max(8),
  blur: z.number().min(0).max(500),
  outline: z.union([box, z.null()]),
  // frame
  layout: z.enum(['none', 'row', 'column']),
  gap: numberOrVar,
  padding: z.union([numberOrVar, z.tuple([numberOrVar, numberOrVar]), z.tuple([numberOrVar, numberOrVar, numberOrVar, numberOrVar])]),
  align: z.enum(['start', 'center', 'end', 'stretch']),
  justify: z.enum(['start', 'center', 'end', 'space-between']),
  clip: z.boolean(),
  // components: `component: true` marks a frame as a definition, `component: "<id>"` points an instance at one.
  component: z.union([z.boolean(), z.string().max(64)]),
  // text
  text: z.string().max(50000),
  fontSize: z.number().min(1).max(2000),
  fontFamily: z.string().max(200).regex(/^[\w\s,'"-]+$/, 'letters, spaces, quotes, commas and dashes only'),
  fontWeight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  lineHeight: z.number().min(0.5).max(5),
  letterSpacing: z.number().min(-50).max(200),
  textAlign: z.enum(['left', 'center', 'right']),
  textDecoration: z.enum(['none', 'underline', 'line-through']),
  wrap: z.enum(['auto', 'nowrap', 'truncate']),
  maxLines: z.number().int().min(1).max(100),
  color: paint,
  // image
  src: z.string().max(20_000_000),
  fit: z.enum(['cover', 'contain', 'fill']),
  // path & svg
  d: z.string().max(500000),
  viewBox: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
  svg: z.string().max(500000),
  // accessibility semantics carried into exports and prototypes
  role: z.string().max(64),
  label: z.string().max(500),
  alt: z.string().max(500),
  /** An inactive control: its text is exempt from WCAG 1.4.3 contrast, and exports carry aria-disabled. */
  disabled: z.boolean(),
  // free-form note for humans and agents (design rationale, todo)
  note: z.string().max(5000),
}).partial().strict();

export type Props = z.infer<typeof propsSchema>;
export type Fill = z.infer<typeof fillSchema>;

/** Document-level design tokens. Colours are strings, metrics are numbers. */
export const variablesSchema = z.record(z.string().min(1).max(64).regex(/^[A-Za-z][\w-]*$/, 'letters, digits, - and _'), z.union([
  z.string().min(1).max(200),
  z.number(),
]));
export type Variables = z.infer<typeof variablesSchema>;
