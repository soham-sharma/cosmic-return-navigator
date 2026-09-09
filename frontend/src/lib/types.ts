export type ReturnReason =
  | 'defective'
  | 'wrong_item'
  | 'changed_mind'
  | 'damaged_in_transit'
  | 'not_as_described'
  | 'other';

export type ResolutionType = 'refund' | 'exchange' | 'store_credit' | 'repair' | 'escalated';

export interface OrderLookupRequest {
  email: string;
  orderId: string;
}

export interface OrderItem {
  id: string;
  name: string;
  imageUrl?: string;
  price: number;
  quantity: number;
  sku: string;
}

export interface Order {
  id: string;
  date: string;
  items: OrderItem[];
  total: number;
}

export interface ReturnSubmission {
  orderId: string;
  email: string;
  selectedItemIds: string[];
  reason: ReturnReason;
  description: string;
}

export interface ReturnResponse {
  returnId: string;
  status: 'processing' | 'approved' | 'denied' | 'escalated';
  resolution?: ResolutionType;
  resolutionDetail?: string;
  estimatedRefund?: number;
  nextSteps?: string[];
  co2Saved?: number;
  bonusPoints?: number;
  pickupDate?: string;
  trackingNumber?: string;
}

export interface ProcessingStep {
  id: string;
  label: string;       // customer-friendly label, not agent name
  detail: string;
  done: boolean;
}

// ── KPI dashboard ─────────────────────────────────────────────────────────────

/** GET /api/v1/analytics/kpis */
export interface KpiSnapshot {
  windowDays: number;
  generatedAt: string;

  totalReturns: number;
  returnRatePct: number;
  avgTurnaroundHours: number;
  automationRatePct: number;
  ticketDeflectionPct: number;

  avgCostPerReturnUsd: number;
  totalReturnCostUsd: number;
  retainedRevenueUsd: number;
  repeatPurchaseRatePct: number;

  avgCsat: number;
  nps: number;

  co2PreventedKg: number;
  sustainableReturnPct: number;
  packagingWasteAvoidedKg: number;

  escalationRatePct: number;
  insightsGenerated: number;
  insightsActioned: number;

  /** Signed change vs the previous equivalent window. Sparse — most keys absent. */
  deltas: Record<string, number>;
}

/** Numeric keys of KpiSnapshot — the only things a tile may point at. */
export type KpiMetricKey = {
  [K in keyof KpiSnapshot]: KpiSnapshot[K] extends number ? K : never;
}[keyof KpiSnapshot];
