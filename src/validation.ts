import type { Request } from 'express';
import { z } from 'zod';
import { BadRequestError } from './errors.js';

// Request validation. Both helpers throw BadRequestError with the first issue's message,
// which the error handler turns into 400 BAD_REQUEST.

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request');
  }
  return parsed.data;
}

export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: Request): T {
  return parse(schema, req.body ?? {});
}

export function parseQuery<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: Request): T {
  return parse(schema, req.query);
}

/** A whole number from the query string (`?limit=20`); values outside [min, max] are rejected. */
export function queryInt(min: number, max: number) {
  return z.coerce
    .number({ invalid_type_error: 'Expected a number' })
    .int('Expected a whole number')
    .min(min, `Must be at least ${min}`)
    .max(max, `Must be at most ${max}`);
}
