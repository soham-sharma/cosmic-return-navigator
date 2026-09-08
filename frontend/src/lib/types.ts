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
