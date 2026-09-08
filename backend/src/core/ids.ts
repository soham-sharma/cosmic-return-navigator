/**
 * Deterministic, human-readable ID generation.
 *
 * Prefixed IDs make demo logs, screenshots and API payloads self-describing
 * (`RET-000123` is obviously a return case). A monotonic counter per prefix
 * keeps the demo reproducible; `randomUUID` is reserved for trace/request IDs
 * where readability does not matter.
 */
import { randomUUID } from 'node:crypto';

export const ID_PREFIX = {
  case: 'RET',
  returnRequest: 'RR',
  order: 'ORD',
  customer: 'CUST',
  resolution: 'RES',
  shipment: 'SHP',
  label: 'LBL',
  pickup: 'PKP',
  message: 'MSG',
  notification: 'NTF',
  sustainability: 'SUS',
  insight: 'INS',
  escalation: 'ESC',
  agentRun: 'RUN',
  event: 'EVT',
  logisticsOption: 'OPT',
  goodwill: 'GDW',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const counters = new Map<IdKind, number>();

/** e.g. newId('case') -> 'RET-000001' */
export function newId(kind: IdKind, width = 6): string {
  const next = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, next);
  return `${ID_PREFIX[kind]}-${String(next).padStart(width, '0')}`;
}

/** Seed a counter so fixture IDs and generated IDs never collide. */
export function seedCounter(kind: IdKind, value: number): void {
  counters.set(kind, Math.max(counters.get(kind) ?? 0, value));
}

/** Reset all counters — used by `POST /demo/reset` and by tests. */
export function resetCounters(): void {
  counters.clear();
}

/** Opaque correlation ID for a single HTTP request or pipeline execution. */
export function newTraceId(): string {
  return randomUUID();
}
