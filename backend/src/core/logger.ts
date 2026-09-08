/**
 * Minimal structured logger (no dependency needed for a demo backend).
 * Emits single-line JSON in production, readable text in development.
 */
import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const threshold = RANK[env.LOG_LEVEL];

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (RANK[level] < threshold) return;

  if (env.isProduction) {
    console[level === 'debug' ? 'log' : level](
      JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...context }),
    );
    return;
  }

  const suffix = context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
  console[level === 'debug' ? 'log' : level](`[${level.toUpperCase()}] ${message}${suffix}`);
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
  /** Child logger that stamps every line with shared context (e.g. caseId). */
  child(base: Record<string, unknown>) {
    return {
      debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, { ...base, ...c }),
      info: (m: string, c?: Record<string, unknown>) => emit('info', m, { ...base, ...c }),
      warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, { ...base, ...c }),
      error: (m: string, c?: Record<string, unknown>) => emit('error', m, { ...base, ...c }),
    };
  },
};

export type Logger = typeof logger;
