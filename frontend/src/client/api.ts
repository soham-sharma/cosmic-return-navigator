/**
 * Envelope-aware API client.
 *
 * SHARED FILE — every endpoint returns { success, data, meta }, so `unwrap` is
 * the one helper the whole frontend needs. Add sibling functions here.
 */
import type { ApiEnvelope, KpiSnapshot } from './types.js';
import { MOCK_KPI_SNAPSHOT } from './mock.js';

export type DataSource = 'live' | 'mock';

export interface Loaded<T> {
  data: T;
  source: DataSource;
  /** Why we fell back. Null when source is 'live'. */
  reason: string | null;
}

async function unwrap<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = (await res.json()) as ApiEnvelope<T>;
  if (!body.success) throw new Error(body.error.message);
  return body.data;
}

/**
 * Fetches the executive KPI snapshot, falling back to the bundled baseline so
 * the page still renders when the backend is not running.
 */
export async function loadKpis(windowDays = 30): Promise<Loaded<KpiSnapshot>> {
  try {
    const data = await unwrap<KpiSnapshot>(`/api/v1/analytics/kpis?windowDays=${windowDays}`);
    return { data, source: 'live', reason: null };
  } catch (err) {
    return {
      data: MOCK_KPI_SNAPSHOT,
      source: 'mock',
      reason: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
