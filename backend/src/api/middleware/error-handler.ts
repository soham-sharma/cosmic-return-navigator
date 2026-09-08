/**
 * Terminal error handler + 404 handler.
 *
 * Every thrown error funnels through here and leaves as an `ErrorEnvelope`, so
 * the frontend has exactly one error shape to handle. Stack traces are logged
 * server-side and never sent to the client outside development.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { AppError } from '../../core/errors';

export function notFoundHandler(req: Request, res: Response): void {
  res.fail('NOT_FOUND', `No route matches ${req.method} ${req.originalUrl}.`, 404, {
    method: req.method,
    path: req.originalUrl,
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  /* --- our own typed errors --- */
  if (err instanceof AppError) {
    // 4xx are expected outcomes (bad input, missing entity) — log at warn.
    const level = err.status >= 500 ? 'error' : 'warn';
    logger[level](`[api] ${err.code}: ${err.message}`, {
      requestId: req.requestId,
      path: req.originalUrl,
      details: err.details,
    });
    res.fail(err.code, err.message, err.status, err.details, err.retryable);
    return;
  }

  /* --- a Zod error escaping a handler means we validated too late --- */
  if (err instanceof ZodError) {
    logger.warn('[api] Unhandled ZodError escaped a handler', { requestId: req.requestId, path: req.originalUrl });
    res.fail('VALIDATION_ERROR', 'Request or response failed schema validation.', 400, {
      issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }

  /* --- anything else is a bug --- */
  const message = err instanceof Error ? err.message : String(err);
  logger.error('[api] Unhandled error', {
    requestId: req.requestId,
    path: req.originalUrl,
    error: message,
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.fail(
    'INTERNAL_ERROR',
    'Something went wrong on our side.',
    500,
    env.isProduction ? undefined : { error: message },
  );
}

/**
 * Wraps an async handler so rejected promises reach `errorHandler`.
 * Express 4 does not do this automatically.
 */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
