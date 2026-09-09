/*
 * API Service Layer — Cosmic Return Navigator
 *
 * All backend calls flow through here. Components never fetch directly.
 *
 * INTEGRATION:
 *   - Set NEXT_PUBLIC_API_URL in .env.local (e.g. /api/v1)
 *   - next.config.mjs rewrites /api/v1/* → http://localhost:4000/api/v1/*
 *   - Without NEXT_PUBLIC_API_URL the mock implementations run instead
 *
 * Backend response envelope: { success: boolean; data: T; meta: {...} }
 */

import type { OrderLookupRequest, Order, ReturnSubmission, ReturnResponse } from './types';
import { getUser } from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
// SSE must bypass the Next.js proxy (which buffers streaming responses).
// Point directly at the backend origin for EventSource connections.
const BACKEND_ORIGIN = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

// ── Envelope unwrapper ────────────────────────────────────────────────────────

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!body.success) throw new Error(body.error?.message ?? 'API error');
  return body.data as T;
}

// ── User orders ───────────────────────────────────────────────────────────────

export async function getUserOrders(emailOrCustomerId: string): Promise<Order[]> {
  if (API_URL) {
    const user = getUser();
    const customerId = user?.customerId ?? (emailOrCustomerId.includes('@') ? 'CUST-001001' : emailOrCustomerId);
    const res = await fetch(`${API_URL}/customers/${customerId}/orders`);
    if (!res.ok) return [];
    const raw: BackendOrder[] = await unwrap<BackendOrder[]>(res);
    return raw.map(mapOrder);
  }

  // Mock — remove when backend is connected
  await delay(700);
  return Object.values(MOCK_ORDERS);
}

// ── Order lookup (kept for backward compatibility) ────────────────────────────

export async function lookupOrder(req: OrderLookupRequest): Promise<Order | null> {
  if (API_URL) {
    const res = await fetch(`${API_URL}/orders/${req.orderId}`);
    if (!res.ok) return null;
    const raw: BackendOrder = await unwrap<BackendOrder>(res);
    return mapOrder(raw);
  }

  await delay(900);
  return MOCK_ORDERS[req.orderId] ?? null;
}

// ── Return submission ─────────────────────────────────────────────────────────

export async function submitReturn(submission: ReturnSubmission): Promise<ReturnResponse> {
  if (API_URL) {
    const text = buildReturnText(submission);
    const firstItemId = submission.selectedItemIds[0] ?? '';

    // Start the async pipeline
    const intakeRes = await fetch(`${API_URL}/returns/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        customerId: getUser()?.customerId ?? 'CUST-001001',
        orderId: submission.orderId,
        orderItemId: firstItemId,
        channel: 'IN_APP',
        async: true,
      }),
    });
    if (!intakeRes.ok) throw new Error('Failed to submit return');
    const intake: { caseId: string } = await unwrap(intakeRes);
    const { caseId } = intake;

    // Poll until pipeline reaches a terminal state (more reliable than SSE
    // when the pipeline may complete before the EventSource connects)
    await pollUntilDone(caseId);

    // Fetch the final outcome
    const outcomeRes = await fetch(`${API_URL}/returns/cases/${caseId}/outcome`);
    if (!outcomeRes.ok) throw new Error('Failed to fetch outcome');
    const outcome: BackendOutcome = await unwrap(outcomeRes);

    return mapOutcome(caseId, outcome);
  }

  // Mock — remove when backend is connected
  await delay(4500);
  return {
    returnId: `RET-${Math.floor(Math.random() * 90000) + 10000}`,
    status: 'approved',
    resolution: 'exchange',
    resolutionDetail: "We'll send a replacement to your address within 3–5 business days.",
    estimatedRefund: submission.reason === 'changed_mind' ? 149.99 : undefined,
    nextSteps: [
      'A prepaid return label has been emailed to you.',
      'Drop the item at any FedEx location or schedule a pickup.',
      'Your replacement ships once we receive the return.',
    ],
    co2Saved: 2.4,
    bonusPoints: 500,
    pickupDate: 'Tomorrow, 9am–6pm',
    trackingNumber: `1Z999AA1${Math.floor(Math.random() * 100000000)}`,
  };
}

// ── Return status ─────────────────────────────────────────────────────────────

export async function getReturnStatus(returnId: string): Promise<ReturnResponse | null> {
  if (API_URL) {
    const res = await fetch(`${API_URL}/returns/cases/${returnId}/outcome`);
    if (!res.ok) return null;
    const outcome: BackendOutcome = await unwrap(res);
    return mapOutcome(returnId, outcome);
  }

  await delay(600);
  return {
    returnId,
    status: 'approved',
    resolution: 'exchange',
    resolutionDetail: 'Replacement shipped.',
    trackingNumber: '1Z999AA101234567',
    nextSteps: ['Your replacement is on its way.'],
  };
}

// ── Polling helper ────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set([
  'COMPLETED', 'ESCALATED', 'DENIED', 'CANCELLED', 'FAILED',
]);

async function pollUntilDone(caseId: string): Promise<void> {
  const url = `${BACKEND_ORIGIN}/api/v1/returns/cases/${caseId}/agents`;
  const deadline = Date.now() + 300_000; // 5-minute hard cap

  while (Date.now() < deadline) {
    await delay(2000);
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (body.success && TERMINAL_STATUSES.has(body.data?.status)) return;
      }
    } catch {
      // network blip — keep polling
    }
  }
}

// ── Backend type shapes ───────────────────────────────────────────────────────

interface BackendOrderItem {
  orderItemId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceUsd: number;
  returnedQuantity: number;
}

interface BackendOrder {
  orderId: string;
  placedAt: string;
  deliveredAt?: string;
  totalUsd: number;
  items: BackendOrderItem[];
  derived?: {
    daysSinceDelivery: number | null;
    items: Array<{ orderItemId: string; withinWindow: boolean; daysRemaining: number | null }>;
  };
}

interface BackendOutcome {
  resolutionType: string;
  resolutionSummary: string;
  refundAmountUsd: number | null;
  pointsAwarded: number | null;
  pickupScheduledFor: string | null;
  trackingNumber: string | null;
  co2PreventedKg: number | null;
  nextSteps: string[];
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapOrder(o: BackendOrder): Order {
  return {
    id: o.orderId,
    date: o.deliveredAt ?? o.placedAt,
    total: o.totalUsd,
    items: o.items.map((i) => ({
      id: i.orderItemId,
      name: i.productName,
      sku: i.sku,
      price: i.unitPriceUsd,
      quantity: i.quantity - i.returnedQuantity,
    })),
  };
}

function mapOutcome(caseId: string, o: BackendOutcome): ReturnResponse {
  const resolutionMap: Record<string, ReturnResponse['resolution']> = {
    REFUND: 'refund',
    KEEP_AND_REFUND: 'refund',
    PARTIAL_REFUND: 'refund',
    REPLACEMENT: 'exchange',
    EXCHANGE: 'exchange',
    STORE_CREDIT: 'store_credit',
    REPAIR: 'repair',
    ESCALATE: 'escalated',
  };

  return {
    returnId: caseId,
    status: o.resolutionType === 'DENY' ? 'denied' : o.resolutionType === 'ESCALATE' ? 'escalated' : 'approved',
    resolution: resolutionMap[o.resolutionType] ?? 'exchange',
    resolutionDetail: o.resolutionSummary,
    estimatedRefund: o.refundAmountUsd ?? undefined,
    bonusPoints: o.pointsAwarded ?? undefined,
    pickupDate: o.pickupScheduledFor ?? undefined,
    trackingNumber: o.trackingNumber ?? undefined,
    co2Saved: o.co2PreventedKg ?? undefined,
    nextSteps: o.nextSteps,
  };
}

function buildReturnText(s: ReturnSubmission): string {
  const reasonLabels: Record<string, string> = {
    defective: 'defective / not working',
    wrong_item: 'wrong item received',
    changed_mind: 'changed my mind',
    damaged_in_transit: 'damaged during shipping',
    not_as_described: 'not as described',
    other: 'other reason',
  };
  const label = reasonLabels[s.reason] ?? s.reason;
  const extra = s.description ? ` Additional details: ${s.description}` : '';
  return `I want to return order ${s.orderId} because ${label}.${extra}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MOCK_ORDERS: Record<string, Order> = {
  'ORD-20941': {
    id: 'ORD-20941',
    date: '2026-08-19',
    total: 299.98,
    items: [
      { id: 'item-1', name: 'Cosmic Smartwatch Series X', sku: 'SKU-SW-X100', price: 149.99, quantity: 1 },
      { id: 'item-2', name: 'Wireless Charging Pad', sku: 'SKU-WCP-200', price: 49.99, quantity: 1 },
      { id: 'item-3', name: 'Sport Band — Midnight', sku: 'SKU-SB-MN', price: 29.99, quantity: 2 },
    ],
  },
  'ORD-18822': {
    id: 'ORD-18822',
    date: '2026-08-28',
    total: 189.99,
    items: [
      { id: 'item-4', name: 'Nebula Pro Headphones', sku: 'SKU-HDP-BT500', price: 189.99, quantity: 1 },
    ],
  },
  'ORD-17301': {
    id: 'ORD-17301',
    date: '2026-09-01',
    total: 134.98,
    items: [
      { id: 'item-5', name: 'Cosmic Explorer Jacket', sku: 'SKU-JKT-EXP', price: 99.99, quantity: 1 },
      { id: 'item-6', name: 'Nebula Graphic Tee', sku: 'SKU-TEE-NBL', price: 34.99, quantity: 1 },
    ],
  },
};
