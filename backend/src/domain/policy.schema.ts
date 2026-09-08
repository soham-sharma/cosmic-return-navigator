/**
 * REFERENCE DATA: Return policy + regional consumer-protection rules.
 *
 * Externalized into fixtures so "complicated return policy" — Cosmic Mart's
 * top sentiment driver — becomes a tunable configuration rather than hardcoded
 * branching. The Eligibility Agent is a pure function of (case, policy).
 */
import { z } from 'zod';
import { LoyaltyTierSchema, RegionCodeSchema } from './common.schema';
import { ProductCategorySchema } from './product.schema';
import { ReturnReasonSchema } from './return.schema';

/** Base window and fees for one product category. */
export const CategoryPolicySchema = z.object({
  category: ProductCategorySchema,
  returnWindowDays: z.number().int().nonnegative(),
  /** False -> instant denial regardless of window (perishables, final sale). */
  returnable: z.boolean().default(true),
  restockingFeePct: z.number().min(0).max(100).default(0),
  requiresOriginalPackaging: z.boolean().default(false),
  /** Above this value, a human must approve the resolution. */
  requiresInspection: z.boolean().default(false),
  /** Photo proof required for damage claims in this category. */
  requiresProofOfDamage: z.boolean().default(false),
  nonReturnableReason: z.string().nullable().default(null),
});
export type CategoryPolicy = z.infer<typeof CategoryPolicySchema>;

/** Extra days and perks granted by loyalty tier — the mechanism that lets the
 *  business be generous to high-LTV customers without breaking policy. */
export const TierBenefitSchema = z.object({
  tier: LoyaltyTierSchema,
  windowExtensionDays: z.number().int().nonnegative().default(0),
  freeReturnShipping: z.boolean().default(false),
  restockingFeeWaived: z.boolean().default(false),
  /** Ceiling on retention gestures the Resolution Agent may grant. */
  goodwillBudgetUsd: z.number().nonnegative().default(0),
  priorityHandling: z.boolean().default(false),
  /** Multiplier applied to bonus-point grants. */
  pointsMultiplier: z.number().positive().default(1),
});
export type TierBenefit = z.infer<typeof TierBenefitSchema>;

/**
 * Statutory floors. Regional law can only ever be MORE generous than store
 * policy — the agent takes max(storeWindow, statutoryWindow).
 */
export const RegionalRuleSchema = z.object({
  regionCode: RegionCodeSchema,
  regionName: z.string(),
  /** e.g. EU Consumer Rights Directive: 14-day right of withdrawal. */
  statutoryWindowDays: z.number().int().nonnegative(),
  statutoryReference: z.string().describe('Citation shown in the rationale'),
  /** Merchant must pay return shipping for faulty goods. */
  merchantPaysReturnShippingOnFault: z.boolean().default(true),
  /** Restocking fees prohibited within the statutory window. */
  restockingFeeProhibited: z.boolean().default(false),
  refundDeadlineDays: z.number().int().positive().describe('Legal deadline to refund'),
  /** Categories exempted from the statutory window in this region. */
  exemptCategories: z.array(ProductCategorySchema).default([]),
  currency: z.string().default('USD'),
});
export type RegionalRule = z.infer<typeof RegionalRuleSchema>;

/** Reason-specific overrides. DAMAGED_ON_ARRIVAL is the important one: it
 *  extends the window and waives all fees. */
export const ReasonPolicySchema = z.object({
  reason: ReturnReasonSchema,
  windowExtensionDays: z.number().int().default(0),
  feesWaived: z.boolean().default(false),
  merchantPaysShipping: z.boolean().default(true),
  requiresEvidence: z.boolean().default(false),
  /** Skip warehouse inspection and resolve immediately. */
  allowsInstantResolution: z.boolean().default(false),
});
export type ReasonPolicy = z.infer<typeof ReasonPolicySchema>;

/** Thresholds that gate automation and trigger escalations. */
export const PolicyThresholdsSchema = z.object({
  autoApproveMaxUsd: z.number().nonnegative(),
  /** Above this, a human reviews regardless of tier. */
  manualReviewMinUsd: z.number().nonnegative(),
  /** Return shipping cost above this fraction of item value -> keep-and-refund. */
  keepAndRefundCostRatio: z.number().min(0).max(5),
  /** Absolute item value below which returning it never pays. */
  keepAndRefundMaxItemUsd: z.number().nonnegative(),
  /** Returns in 90 days that triggers fraud review. */
  fraudReviewReturnsLast90Days: z.number().int().positive(),
  /** Lifetime return rate that triggers fraud review. */
  fraudReviewReturnRate: z.number().min(0).max(1),
  /** LTV above which retention overrides may exceed normal policy. */
  vipLifetimeValueUsd: z.number().nonnegative(),
  /** Churn-risk score above which retention gestures become mandatory. */
  retentionInterventionChurnScore: z.number().min(0).max(100),
});
export type PolicyThresholds = z.infer<typeof PolicyThresholdsSchema>;

export const ReturnPolicySchema = z.object({
  policyId: z.string(),
  version: z.string(),
  effectiveFrom: z.string(),
  /** Applied when no category-specific policy matches. */
  defaultReturnWindowDays: z.number().int().nonnegative(),
  categories: z.array(CategoryPolicySchema),
  tierBenefits: z.array(TierBenefitSchema),
  regionalRules: z.array(RegionalRuleSchema),
  reasonPolicies: z.array(ReasonPolicySchema),
  thresholds: PolicyThresholdsSchema,
});
export type ReturnPolicy = z.infer<typeof ReturnPolicySchema>;
