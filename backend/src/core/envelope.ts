/**
 * Uniform API response envelope.
 *
 * EVERY endpoint returns this shape. The frontend can therefore write one
 * `unwrap()` helper and one error interceptor for the whole surface.
 *
 *   success: { success: true,  data: T,      meta }
 *   failure: { success: false, error: {...}, meta }
 */
import { z } from 'zod';
import type { ErrorCode } from './errors';

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  durationMs?: number;
  /** Present on list endpoints. */
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level validation issues, or arbitrary diagnostic context. */
    details?: unknown;
    retryable: boolean;
  };
  meta: ResponseMeta;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(data: T, meta: ResponseMeta): SuccessEnvelope<T> {
  return { success: true, data, meta };
}

export function fail(
  code: ErrorCode,
  message: string,
  meta: ResponseMeta,
  details?: unknown,
  retryable = false,
): ErrorEnvelope {
  return { success: false, error: { code, message, details, retryable }, meta };
}

/* ------------------------------ Zod mirrors ------------------------------- */
/* Exported so the frontend (and contract tests) can validate responses.      */

export const ResponseMetaSchema = z.object({
  requestId: z.string(),
  timestamp: z.string().datetime(),
  durationMs: z.number().optional(),
  pagination: z
    .object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    })
    .optional(),
});

export const successEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({ success: z.literal(true), data: dataSchema, meta: ResponseMetaSchema });

export const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    retryable: z.boolean(),
  }),
  meta: ResponseMetaSchema,
});
