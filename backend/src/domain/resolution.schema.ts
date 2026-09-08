/**
 * DATA MODEL: Resolution
 *
 * The decision record produced by the Resolution Planning Agent: what the
 * customer gets, what it costs the business, and why this option beat the
 * alternatives.
 */
import { z } from 'zod';
import { ConfidenceSchema, CurrencySchema, IsoDateTimeSchema, ScoreSchema } from './common.schema';

export const ResolutionTypeSchema = z.enum([
  /** Money back to the original payment instrument. */
  'REFUND',
  /** Money back, item NOT returned (return shipping costs more than the item). */
  'KEEP_AND_REFUND',
  /** Partial refund, customer keeps a usable-but-imperfect item. */
  'PARTIAL_REFUND',
  /** Same SKU shipped out; original returned. */
  'REPLACEMENT',
  /** Different SKU/variant shipped out. */
  'EXCHANGE',
  /** Credit to the Cosmic wallet, usually with a bonus uplift. */
  'STORE_CREDIT',
  /** Repair under warranty. */
  'REPAIR',
  /** No automated resolution — handed to a human. */
  'ESCALATE',
  /** Request declined, with rationale. */
  'DENY',
]);
export type ResolutionType = z.infer<typeof ResolutionTypeSchema>;

/** Retention gestures granted on top of the core resolution. This is the
 *  "+500 Cosmic Rewards points" in the demo narrative. */
export const GoodwillGrantSchema = z.object({
  grantId: z.string(),
  type: z.enum([
    'BONUS_POINTS',
    'DISCOUNT_CODE',
    'FREE_EXPEDITED_SHIPPING',
    'APOLOGY_CREDIT',
    'TIER_UPGRADE',
    'EXTENDED_WARRANTY',
    'HUMAN_CALLBACK',
  ]),
  /** Points for BONUS_POINTS, percent for DISCOUNT_CODE, USD for credits. */
  value: z.number().nonnegative(),
  unit: z.enum(['POINTS', 'PERCENT', 'USD', 'MONTHS', 'NONE']),
  /** Business cost of the gesture, normalized to USD for the cost model. */
  costUsd: z.number().nonnegative(),
  code: z.string().nullable().default(null),
  rationale: z.string(),
  expiresAt: IsoDateTimeSchema.nullable().default(null),
});
export type GoodwillGrant = z.infer<typeof GoodwillGrantSchema>;

/**
 * One candidate resolution, scored. The agent emits the full set so the UI can
 * show "why not the alternatives" — an explainability requirement.
 */
export const ResolutionOptionSchema = z.object({
  optionId: z.string(),
  type: ResolutionTypeSchema,

  refundAmountUsd: z.number().nonnegative().nullable().default(null),
  currency: CurrencySchema.default('USD'),
  storeCreditAmountUsd: z.number().nonnegative().nullable().default(null),
  replacementSku: z.string().nullable().default(null),
  /** Replacement sourced from refurbished stock: cheaper and greener. */
  replacementIsRefurbished: z.boolean().default(false),
  restockingFeeUsd: z.number().nonnegative().default(0),
  returnShippingPaidBy: z.enum(['MERCHANT', 'CUSTOMER', 'CARRIER_CLAIM']).default('MERCHANT'),

  /** Does this option require the item to come back? Gates the Logistics Agent. */
  requiresReturnShipment: z.boolean(),
  estimatedResolutionHours: z.number().nonnegative(),

  /* --- scoring (0-100 each; weights live in the agent output) --- */
  satisfactionScore: ScoreSchema.describe('Predicted customer satisfaction'),
  costScore: ScoreSchema.describe('Higher = cheaper for the business'),
  retentionScore: ScoreSchema.describe('Predicted churn-prevention value'),
  sustainabilityScore: ScoreSchema.describe('Provisional; refined by the Sustainability Agent'),
  weightedScore: ScoreSchema.describe('Final ranking score'),

  /** Total business cost: goods + shipping + goodwill + processing. */
  estimatedCostUsd: z.number().nonnegative(),
  feasible: z.boolean().describe('False when e.g. no inventory exists'),
  infeasibleReason: z.string().nullable().default(null),
  /** One sentence, customer-safe language. */
  customerFacingSummary: z.string(),
  /** Internal reasoning for support agents and auditors. */
  internalNotes: z.string().nullable().default(null),
});
export type ResolutionOption = z.infer<typeof ResolutionOptionSchema>;

export const ResolutionStatusSchema = z.enum([
  'PROPOSED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'COMPLETED',
  'CANCELLED',
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;

export const ResolutionSchema = z.object({
  resolutionId: z.string().describe('e.g. RES-000001'),
  caseId: z.string(),
  returnId: z.string(),

  status: ResolutionStatusSchema,
  /** The chosen option, denormalized so the record is self-contained. */
  selected: ResolutionOptionSchema,
  /** Ranked runners-up, for the "why not X" drill-down. */
  alternatives: z.array(ResolutionOptionSchema).default([]),
  goodwill: z.array(GoodwillGrantSchema).default([]),

  /** Aggregate business impact. */
  totalCostUsd: z.number().nonnegative(),
  /** Retained revenue we believe this resolution protects. */
  estimatedRetainedValueUsd: z.number().nonnegative(),

  /** True when totalCostUsd exceeds AUTO_APPROVE_MAX_USD or a rule demands it. */
  requiresHumanApproval: z.boolean(),
  approvedBy: z.string().nullable().default(null),
  approvedAt: IsoDateTimeSchema.nullable().default(null),
  /** Set when a human overrode the agent's recommendation. */
  overrideReason: z.string().nullable().default(null),

  rationale: z.string(),
  confidence: ConfidenceSchema,
  slaDueAt: IsoDateTimeSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Resolution = z.infer<typeof ResolutionSchema>;
