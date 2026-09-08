/**
 * Application error taxonomy.
 *
 * Every error surfaced through the API maps to exactly one `ErrorCode`, so the
 * frontend can branch on a stable string instead of parsing messages.
 * See docs/api_contracts.md for the full table.
 */

export const ERROR_CODE = {
  /** 400 — request body/query failed Zod validation. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 404 — referenced entity does not exist in the mock dataset. */
  NOT_FOUND: 'NOT_FOUND',
  /** 409 — operation invalid for the case's current status. */
  INVALID_STATE: 'INVALID_STATE',
  /** 422 — free-text intake could not be normalized into a return intent. */
  UNPARSEABLE_INTENT: 'UNPARSEABLE_INTENT',
  /** 422 — intent parsed, but no matching order/product could be resolved. */
  ORDER_NOT_RESOLVED: 'ORDER_NOT_RESOLVED',
  /** 500 — an agent threw an unexpected error. */
  AGENT_FAILED: 'AGENT_FAILED',
  /** 504 — an agent exceeded AGENT_TIMEOUT_MS. */
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  /** 500 — the orchestration pipeline aborted. */
  PIPELINE_FAILED: 'PIPELINE_FAILED',
  /** 409 — two agent outputs conflict and no policy resolves it. */
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
  /** 501 — wireframe stub not yet implemented. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  /** 429 — demo rate limit. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 500 — catch-all. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  UNPARSEABLE_INTENT: 422,
  ORDER_NOT_RESOLVED: 422,
  AGENT_FAILED: 500,
  AGENT_TIMEOUT: 504,
  PIPELINE_FAILED: 500,
  UNRESOLVED_CONFLICT: 409,
  NOT_IMPLEMENTED: 501,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** True when a retry with identical input could succeed (timeouts etc.). */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryable = options.retryable ?? code === 'AGENT_TIMEOUT';
    if (options.cause) this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

/* ----------------------------- Shorthand factories ------------------------ */

export const notFound = (entity: string, id: string) =>
  new AppError('NOT_FOUND', `${entity} '${id}' was not found.`, { details: { entity, id } });

export const validationError = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, { details });

export const invalidState = (message: string, details?: unknown) =>
  new AppError('INVALID_STATE', message, { details });

export const notImplemented = (what: string) =>
  new AppError('NOT_IMPLEMENTED', `${what} is not implemented yet (wireframe stub).`, {
    details: { stub: what },
  });

export const agentTimeout = (agentId: string, ms: number) =>
  new AppError('AGENT_TIMEOUT', `Agent '${agentId}' exceeded its ${ms}ms budget.`, {
    details: { agentId, timeoutMs: ms },
    retryable: true,
  });
