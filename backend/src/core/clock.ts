/**
 * Clock abstraction.
 *
 * WHY THIS EXISTS: the primary demo scenario is "I bought a smartwatch 20 days
 * ago". If we used the real system clock, the fixture order would silently drift
 * out of the 30-day return window and the demo would start failing on its own.
 * Freezing "now" makes every date assertion (windows, SLAs, pickup slots)
 * deterministic. Agents and rules must ALWAYS read time from here, never from
 * `new Date()` / `Date.now()` directly.
 */
import { env } from '../config/env';

export interface Clock {
  now(): Date;
  nowIso(): string;
}

class FrozenClock implements Clock {
  constructor(private readonly frozenAt: Date) {}
  now(): Date {
    return new Date(this.frozenAt.getTime());
  }
  nowIso(): string {
    return this.frozenAt.toISOString();
  }
}

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

export const clock: Clock = env.DEMO_FREEZE_CLOCK
  ? new FrozenClock(new Date(env.DEMO_NOW))
  : new SystemClock();

/* -------------------------------------------------------------------------- */
/* Date helpers used across eligibility rules, SLAs and logistics windows.    */
/* -------------------------------------------------------------------------- */

export const MS_PER_DAY = 86_400_000;

/** Whole days elapsed between two instants (floored, never negative-rounded). */
export function daysBetween(from: string | Date, to: string | Date = clock.now()): number {
  const a = typeof from === 'string' ? new Date(from) : from;
  const b = typeof to === 'string' ? new Date(to) : to;
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Whole hours elapsed between two instants. */
export function hoursBetween(from: string | Date, to: string | Date = clock.now()): number {
  const a = typeof from === 'string' ? new Date(from) : from;
  const b = typeof to === 'string' ? new Date(to) : to;
  return Math.floor((b.getTime() - a.getTime()) / 3_600_000);
}

export function addDays(base: string | Date, days: number): Date {
  const d = typeof base === 'string' ? new Date(base) : new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function addHours(base: string | Date, hours: number): Date {
  const d = typeof base === 'string' ? new Date(base) : new Date(base.getTime());
  d.setUTCHours(d.getUTCHours() + hours);
  return d;
}

/** ISO string N days from the (possibly frozen) current time. */
export function isoInDays(days: number): string {
  return addDays(clock.now(), days).toISOString();
}

/** ISO string N hours from the (possibly frozen) current time. */
export function isoInHours(hours: number): string {
  return addHours(clock.now(), hours).toISOString();
}
