/**
 * Zod validation middleware.
 *
 * Validates and REPLACES `req.body` / `req.query` / `req.params` with the
 * parsed result, so route handlers work with typed, defaulted, coerced values
 * and never re-check anything.
 *
 * Validation failures return a 400 VALIDATION_ERROR with field-level details,
 * which is what the frontend renders next to the offending input.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

type Source = 'body' | 'query' | 'params';

export interface ValidationIssue {
  field: string;
  message: string;
  code: string;
}

function toIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
    code: i.code,
  }));
}

export function validate<S extends ZodTypeAny>(schema: S, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      res.fail(
        'VALIDATION_ERROR',
        `Invalid request ${source}.`,
        400,
        { source, issues: toIssues(result.error) },
      );
      return;
    }

    // Overwrite with the parsed value so handlers get defaults and coercion.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };
}

/** Convenience for typed handlers: `const body = parsed<typeof Schema>(req)`. */
export type Parsed<S extends ZodTypeAny> = z.infer<S>;
