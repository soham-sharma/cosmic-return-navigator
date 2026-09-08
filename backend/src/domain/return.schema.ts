/**
 * DATA MODEL: Return (intent + request)
 *
 * Two distinct concepts, deliberately separated:
 *   - `ReturnIntent`   — the NORMALIZED interpretation of what the customer
 *                        said. Produced by the orchestrator's intent parser
 *                        from messy free text. Cheap, disposable, re-derivable.
 *   - `ReturnRequest`  — the PERSISTED business record of the return. Created
 *                        once the intent resolves to a real order line.
 *
 * The full workflow state (agent outputs, escalations, trace) lives in
 * `ReturnCase` — see case-state.schema.ts.
 */
import { z } from 'zod';
import { ChannelSchema, IsoDateTimeSchema, RegionCodeSchema, UnitScoreSchema } from './common.schema';

/**
 * Normalized reason taxonomy. The distinction that matters most for the demo
 * is DAMAGED_ON_ARRIVAL (merchant at fault -> free return, window extension,
 * empathetic tone) vs CHANGE_OF_MIND (customer at fault -> restocking fee may
 * apply, standard tone).
 */
export const ReturnReasonSchema = z.enum([
  'DAMAGED_ON_ARRIVAL',
  'DEFECTIVE',
  'WRONG_ITEM_SENT',
  'NOT_AS_DESCRIBED',
  'MISSING_PARTS',
  'ARRIVED_LATE',
  'CHANGE_OF_MIND',
  'BETTER_PRICE_FOUND',
  'SIZE_FIT_ISSUE',
  'DUPLICATE_ORDER',
  'UNKNOWN',
]);
export type ReturnReason = z.infer<typeof ReturnReasonSchema>;

/** Who bears responsibility — drives fee waivers and tone. */
export const FaultAttributionSchema = z.enum(['MERCHANT', 'CARRIER', 'CUSTOMER', 'UNDETERMINED']);
export type FaultAttribution = z.infer<typeof FaultAttributionSchema>;

/**
 * Reasons where the merchant or carrier is at fault, rather than the customer.
 *
 * Shared DOMAIN knowledge, deliberately not owned by any single agent: three
 * agents need the same answer and must not disagree about it.
 *   - Eligibility waives fees and extends the window.
 *   - Logistics prioritizes customer convenience ("we broke it, we come to you").
 *   - Communication selects an empathetic rather than neutral tone.
 */
export const MERCHANT_FAULT_REASONS = [
  'DAMAGED_ON_ARRIVAL',
  'DEFECTIVE',
  'WRONG_ITEM_SENT',
  'NOT_AS_DESCRIBED',
  'MISSING_PARTS',
] as const satisfies readonly ReturnReason[];

export function isMerchantFault(reason: string): boolean {
  return (MERCHANT_FAULT_REASONS as readonly string[]).includes(reason);
}

export const ItemConditionSchema = z.enum([
  'NEW_UNOPENED',
  'OPENED_LIKE_NEW',
  'USED_GOOD',
  'DAMAGED',
  'NOT_FUNCTIONAL',
  'UNKNOWN',
]);
export type ItemCondition = z.infer<typeof ItemConditionSchema>;

/** What the customer asked for, if they said. May be overridden by the
 *  Resolution Planning Agent when a better option exists. */
export const RequestedOutcomeSchema = z.enum([
  'REFUND',
  'REPLACEMENT',
  'EXCHANGE',
  'STORE_CREDIT',
  'REPAIR',
  'UNSPECIFIED',
]);
export type RequestedOutcome = z.infer<typeof RequestedOutcomeSchema>;

/* --------------------------------- Intent --------------------------------- */

export const ReturnIntentSchema = z.object({
  /** Verbatim customer text — preserved for the Sentiment Agent and audit. */
  rawText: z.string(),
  channel: ChannelSchema.default('IN_APP'),

  /** Resolved entities. Null when the parser could not identify them. */
  customerId: z.string().nullable().default(null),
  orderId: z.string().nullable().default(null),
  orderItemId: z.string().nullable().default(null),
  sku: z.string().nullable().default(null),

  /** Extracted signals. */
  productMention: z.string().nullable().default(null).describe('e.g. "smartwatch"'),
  quantity: z.number().int().positive().default(1),
  reason: ReturnReasonSchema,
  faultAttribution: FaultAttributionSchema.default('UNDETERMINED'),
  reportedCondition: ItemConditionSchema.default('UNKNOWN'),
  requestedOutcome: RequestedOutcomeSchema.default('UNSPECIFIED'),

  /** Relative time phrase resolved against the (frozen) clock. */
  purchaseAgeDaysStated: z.number().int().nonnegative().nullable().default(null),

  /** Parser confidence. Below ~0.5 the orchestrator asks a clarifying question
   *  instead of running the pipeline on a guess. */
  parseConfidence: UnitScoreSchema,
  /** Fields the parser could not fill and that the UI should prompt for. */
  missingFields: z.array(z.string()).default([]),
  /** Keyword/entity spans the parser matched — powers the UI "we understood"
   *  explainer chips. */
  extractedEntities: z
    .array(z.object({ type: z.string(), value: z.string(), sourceText: z.string() }))
    .default([]),

  regionCode: RegionCodeSchema.nullable().default(null),
  hasPhotoEvidence: z.boolean().default(false),
  parsedAt: IsoDateTimeSchema,
});
export type ReturnIntent = z.infer<typeof ReturnIntentSchema>;

/* -------------------------------- Request --------------------------------- */

export const ReturnStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'AWAITING_SHIPMENT',
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTED',
  'RESOLVED',
  'CANCELLED',
  'ESCALATED',
]);
export type ReturnStatus = z.infer<typeof ReturnStatusSchema>;

export const ReturnSchema = z.object({
  returnId: z.string().describe('e.g. RR-000001'),
  /** Link back to the orchestration case that produced this return. */
  caseId: z.string(),

  customerId: z.string(),
  orderId: z.string(),
  orderItemId: z.string(),
  sku: z.string(),
  quantity: z.number().int().positive(),

  reason: ReturnReasonSchema,
  reasonDetail: z.string().nullable().default(null),
  faultAttribution: FaultAttributionSchema,
  reportedCondition: ItemConditionSchema,
  requestedOutcome: RequestedOutcomeSchema,

  status: ReturnStatusSchema,
  /** Declared value of the returned goods (quantity * unit price). */
  declaredValueUsd: z.number().nonnegative(),
  regionCode: RegionCodeSchema,

  /** IDs of records produced downstream. Null until that agent has run. */
  resolutionId: z.string().nullable().default(null),
  shipmentId: z.string().nullable().default(null),
  sustainabilityRecordId: z.string().nullable().default(null),

  evidenceUrls: z.array(z.string()).default([]),

  submittedAt: IsoDateTimeSchema,
  /** SLA target for closing the case — surfaced in the customer UI. */
  slaDueAt: IsoDateTimeSchema.nullable().default(null),
  closedAt: IsoDateTimeSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Return = z.infer<typeof ReturnSchema>;
