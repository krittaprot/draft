// Validation schema for node properties (server only; keeps zod out of the browser bundle).
import { z } from 'zod';

const color = z.string().min(1).max(64).regex(/^[#a-zA-Z0-9(),.%\s-]+$/, 'must be a CSS color like #1f2937 or rgba(0,0,0,0.5)');
const stop = z.object({ offset: z.number().min(0).max(1), color }).strict();
const gradient = z.object({
  type: z.enum(['linear', 'radial']),
  angle: z.number().optional(),
  stops: z.array(stop).min(2).max(16),
}).strict();
export const fillSchema = z.union([color, gradient]);
const size = z.union([z.number().min(0).max(100000), z.enum(['hug', 'fill'])]);
const shadow = z.object({
  x: z.number().default(0), y: z.number().default(4), blur: z.number().min(0).default(12),
  color: color.default('rgba(0,0,0,0.15)'), inset: z.boolean().optional(),
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
  stroke: z.union([color, z.null()]),
  strokeWidth: z.number().min(0).max(1000),
  strokeDash: z.array(z.number().min(0)).max(8),
  radius: z.union([z.number().min(0), z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)])]),
  shadows: z.array(shadow).max(8),
  blur: z.number().min(0).max(500),
  // frame
  layout: z.enum(['none', 'row', 'column']),
  gap: z.number(),
  padding: z.union([z.number(), z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number(), z.number()])]),
  align: z.enum(['start', 'center', 'end', 'stretch']),
  justify: z.enum(['start', 'center', 'end', 'space-between']),
  clip: z.boolean(),
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
  color,
  // image
  src: z.string().max(20_000_000),
  fit: z.enum(['cover', 'contain', 'fill']),
  // path & svg
  d: z.string().max(500000),
  viewBox: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
  svg: z.string().max(500000),
  // free-form note for humans and agents (design rationale, todo)
  note: z.string().max(5000),
}).partial().strict();

export type Props = z.infer<typeof propsSchema>;
export type Fill = z.infer<typeof fillSchema>;

