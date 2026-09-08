/**
 * ============================================================================
 * AGENT CONTRACT 1/7 — RETURN ELIGIBILITY AGENT
 * ============================================================================
 *
 * PURPOSE
 *   Decide whether this return is permitted, and prove why. Validates the
 *   request against order history, the return window, product-category rules,
 *   loyalty benefits and regional consumer-protection law, then emits a
 *   decision with a full rule-by-rule audit trail.
 *
 * PIPELINE POSITION
 *   Stage 1, runs IN PARALLEL with the Sentiment & Retention Agent.
 *   Depends only on `CaseContext` + `ReturnIntent` — never on another agent.
 *   Downstream: Resolution Planning consumes this output.
 *
 * DECISION LOGIC (simulated — deterministic rules, no ML)
 *   Rules are evaluated in order and ALL are recorded (even passes), because
 *   the UI renders the whole trace. Precedence, highest first:
 *
 *   1. ELG_ORDER_MATCH        Order exists, belongs to the customer, contains
 *                             the line item, and quantity is available to
 *                             return (quantity - returnedQuantity >= requested).
 *                             FAIL -> DENIED (hard stop, data integrity).
 *   2. ELG_CATEGORY_RETURNABLE Category `returnable` flag + isPerishable +
 *                             isFinalSale. FAIL -> DENIED, unless the regional
 *                             statutory window still applies (rule 4 can waive).
 *   3. ELG_RETURN_WINDOW      daysSinceDelivery <= effectiveReturnWindowDays.
 *                             The effective window is precomputed in
 *                             `context.policy.effectiveReturnWindowDays` as
 *                             max(categoryWindow + tierExtension + reason
 *                             extension, statutoryWindow).
 *                             FAIL -> DENIED, but see rule 5.
 *   4. ELG_REGIONAL_STATUTE   If the region's statutory window is more generous
 *                             than store policy and the category is not exempt,
 *                             WAIVE a window failure and record the citation.
 *   5. ELG_DAMAGE_ON_ARRIVAL  DAMAGED_ON_ARRIVAL / DEFECTIVE / WRONG_ITEM_SENT
 *                             extend the window and waive all fees. This is the
 *                             rule that approves the primary demo scenario.
 *   6. ELG_EVIDENCE_REQUIRED  Damage claims in categories with
 *                             requiresProofOfDamage and no photo evidence ->
 *                             APPROVED_WITH_CONDITIONS (non-blocking; the
 *                             Communication Agent asks for a photo).
 *   7. ELG_FRAUD_SCREEN       returnsLast90Days >= threshold OR returnRate >=
 *                             threshold OR FRAUD_WATCHLIST flag ->
 *                             MANUAL_REVIEW (blocking escalation).
 *   8. ELG_RESTOCKING_FEE     Compute the fee: category % , waived by tier
 *                             benefit, reason policy, or regional prohibition.
 *
 *   eligibilityScore: 0-100 confidence-weighted composite used for ranking in
 *   the support console; NOT the decision itself.
 *
 * ESCALATION / EDGE CASES
 *
 *   EXACTLY ONE escalation from this agent is blocking:
 *     FRAUD_SIGNAL_DETECTED    serial-returner thresholds breached  (BLOCKING)
 *
 *   Everything else is advisory, including the denials:
 *     OUTSIDE_RETURN_WINDOW     window failed, no waiver applied (non-blocking)
 *     CATEGORY_NOT_RETURNABLE   perishable / restricted category (non-blocking)
 *     FINAL_SALE_ITEM           final-sale flag                  (non-blocking)
 *     ORDER_ITEM_MISMATCH       data-integrity problem           (non-blocking)
 *     PROOF_OF_DAMAGE_REQUIRED  damage claim without evidence    (non-blocking)
 *     REGIONAL_LAW_OVERRIDE     statute beat store policy        (non-blocking,
 *                               informational — proves compliance)
 *
 *   WHY A DENIAL DOES NOT HALT THE PIPELINE: a DENIED decision is an answer,
 *   not an error. Sentiment may still find a VIP worth a goodwill gesture, so
 *   Resolution Planning must always get its turn and may return STORE_CREDIT or
 *   DENY-with-apology. Marking a denial blocking would send every out-of-window
 *   request to a human queue — reintroducing exactly the support backlog this
 *   product exists to remove.
 *
 *   Fraud is the exception because a flagged account must never be
 *   auto-approved, and no amount of customer value should override that.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { ConfidenceSchema, RuleEvaluationSchema, ScoreSchema } from '../../domain/common.schema';
import { ReturnIntentSchema, ReturnReasonSchema, FaultAttributionSchema } from '../../domain/return.schema';

/* --------------------------------- INPUT ---------------------------------- */

export const EligibilityInputSchema = z.object({
  caseId: z.string(),
  intent: ReturnIntentSchema,
  context: CaseContextSchema,
});
export type EligibilityInput = z.infer<typeof EligibilityInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

export const EligibilityDecisionSchema = z.enum([
  /** Clean approval, fully automated. */
  'APPROVED',
  /** Approved but something is needed (photo, original packaging, inspection). */
  'APPROVED_WITH_CONDITIONS',
  /** Not permitted under policy or law. */
  'DENIED',
  /** Cannot decide automatically — a human must look (fraud, ambiguity). */
  'MANUAL_REVIEW',
]);
export type EligibilityDecision = z.infer<typeof EligibilityDecisionSchema>;

/** Serial-returner screening. Simulated from pre-aggregated counters. */
export const FraudAssessmentSchema = z.object({
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  riskScore: ScoreSchema,
  returnsLast90Days: z.number().int().nonnegative(),
  lifetimeReturnRate: z.number().min(0).max(1),
  /** Named signals, e.g. 'HIGH_FREQUENCY', 'WATCHLIST', 'SERIAL_MISMATCH'. */
  flags: z.array(z.string()).default([]),
  requiresManualReview: z.boolean(),
});
export type FraudAssessment = z.infer<typeof FraudAssessmentSchema>;

export const WindowAssessmentSchema = z.object({
  /** Which timestamp the clock ran from. */
  clockStart: z.enum(['DELIVERED_AT', 'PLACED_AT']),
  clockStartAt: z.string(),
  daysElapsed: z.number().int(),
  /** Store policy base, before any extension. */
  basePolicyWindowDays: z.number().int().nonnegative(),
  /** Days granted by loyalty tier. */
  tierExtensionDays: z.number().int().nonnegative(),
  /** Days granted by the return reason (e.g. damage). */
  reasonExtensionDays: z.number().int().nonnegative(),
  /** Statutory floor for the region. */
  statutoryWindowDays: z.number().int().nonnegative(),
  /** The window actually applied. */
  effectiveWindowDays: z.number().int().nonnegative(),
  withinWindow: z.boolean(),
  /** Negative when the window has already closed. */
  daysRemaining: z.number().int(),
});
export type WindowAssessment = z.infer<typeof WindowAssessmentSchema>;

export const EligibilityOutputSchema = z.object({
  decision: EligibilityDecisionSchema,
  /** 0-100 composite; high means "obviously eligible". */
  eligibilityScore: ScoreSchema,

  /** Reason, re-normalized after the agent inspects order evidence — may
   *  differ from what the customer said (e.g. delivery scan shows damage). */
  normalizedReason: ReturnReasonSchema,
  faultAttribution: FaultAttributionSchema,

  window: WindowAssessmentSchema,
  fraud: FraudAssessmentSchema,

  /** Every rule evaluated, in evaluation order. Never empty. */
  ruleTrace: z.array(RuleEvaluationSchema).min(1),

  /* --- financial consequences of the eligibility decision --- */
  /** Maximum refundable amount before resolution-specific adjustments. */
  refundableAmountUsd: z.number().nonnegative(),
  restockingFeePct: z.number().min(0).max(100),
  restockingFeeUsd: z.number().nonnegative(),
  returnShippingPaidBy: z.enum(['MERCHANT', 'CUSTOMER', 'CARRIER_CLAIM']),

  /* --- conditions attached to an APPROVED_WITH_CONDITIONS decision --- */
  conditions: z
    .array(
      z.object({
        code: z.enum(['PHOTO_EVIDENCE', 'ORIGINAL_PACKAGING', 'WAREHOUSE_INSPECTION', 'SERIAL_VERIFICATION', 'ALL_ACCESSORIES']),
        description: z.string(),
        /** True if the condition must be met before the resolution executes. */
        blocksResolution: z.boolean(),
      }),
    )
    .default([]),

  /** Statutory provisions that changed the outcome — compliance evidence. */
  regionalOverridesApplied: z
    .array(z.object({ regionCode: z.string(), provision: z.string(), effect: z.string() }))
    .default([]),

  /** True when the item must be physically inspected before refunding. */
  requiresInspection: z.boolean(),
  /** Policy citation string rendered in the customer-facing explanation. */
  policyCitation: z.string(),
  /** Customer-safe one-liner, e.g. "Approved — arrived damaged, within window." */
  customerFacingSummary: z.string(),
});
export type EligibilityOutput = z.infer<typeof EligibilityOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const EligibilityResultSchema = agentResultSchema(EligibilityOutputSchema);
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;
