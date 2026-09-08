/**
 * Attaches a request ID and start time, and exposes `res.ok()` / `res.fail()`
 * helpers so every route returns the same envelope without boilerplate.
 */
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { clock } from '../../core/clock';
import { fail, ok, type ResponseMeta } from '../../core/envelope';
import type { ErrorCode } from '../../core/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      startedAtMs: number;
    }
    interface Response {
      /** Send a success envelope. */
      ok<T>(data: T, pagination?: ResponseMeta['pagination'], status?: number): void;
      /** Send an error envelope. */
      fail(code: ErrorCode, message: string, status: number, details?: unknown, retryable?: boolean): void;
      /** Build a meta block (used by the SSE route, which writes manually). */
      buildMeta(pagination?: ResponseMeta['pagination']): ResponseMeta;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.header('x-request-id') ?? randomUUID()).slice(0, 64);
  req.startedAtMs = Date.now();
  res.setHeader('x-request-id', req.requestId);

  res.buildMeta = (pagination) => ({
    requestId: req.requestId,
    timestamp: clock.nowIso(),
    durationMs: Date.now() - req.startedAtMs,
    ...(pagination ? { pagination } : {}),
  });

  res.ok = (data, pagination, status = 200) => {
    res.status(status).json(ok(data, res.buildMeta(pagination)));
  };

  res.fail = (code, message, status, details, retryable = false) => {
    res.status(status).json(fail(code, message, res.buildMeta(), details, retryable));
  };

  next();
}
