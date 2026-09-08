/**
 * ============================================================================
 * AGENT CONTRACT 3/7 — RESOLUTION PLANNING AGENT
 * ============================================================================
 *
 * PURPOSE
 *   Choose the optimal outcome — refund, exchange, store credit, repair,
 *   replacement, keep-and-refund or escalation — by explicitly trading off
 *   customer satisfaction, business cost and retention value. Emits the chosen
 *   plan plus every rejected alternative with its scores, so the decision is
 *   fully auditable.
 *
 * PIPELINE POSITION
 *   Stage 2, SEQUENTIAL. Hard dependency on BOTH stage-1 agents:
 *   eligibility (what is permitted) and sentiment (how generous to be).
 *   Downstream: Logistics (does the item need to move?), Communication (what
 *   to promise), Sustainability (which disposition applies).
 *
 * DECISION LOGIC (simulated — candidate generation + weighted scoring)
 *
 *   STEP 1: GENERATE CANDIDATES
 *     Start from all 9 ResolutionTypes, then mark each feasible/infeasible:
 *       REPLACEMENT      requires inventory.availableUnits > 0 and the same SKU
 *                        still being sold.
 *       EXCHANGE         requires an alternate variant in stock.
 *       REPAIR           requires product.repairable and within warrantyMonths.
 *       REFUND           requires order.paymentInstrumentValid, else falls back
 *                        to STORE_CREDIT (PAYMENT_INSTRUMENT_INVALID).
 *       KEEP_AND_REFUND  requires estimated return-shipping cost >
 *                        thresholds.keepAndRefundCostRatio x item value, OR
 *                        item value < keepAndRefundMaxItemUsd.
 *       PARTIAL_REFUND   only when the item is usable (condition USED_GOOD /
 *                        OPENED_LIKE_NEW) and the customer may want to keep it.
 *       DENY             only when eligibility DENIED and no goodwill override.
 *       ESCALATE         always feasible; the safety net.
 *
 *   STEP 2: SCORE EACH CANDIDATE (0-100 per dimension)
 *     satisfactionScore  base per type (replacement 90, refund 75, credit 60,
 *                        repair 50...) adjusted by requestedOutcome match
 *                        (+15 if it is what the customer actually asked for)
 *                        and by speed (estimatedResolutionHours).
 *     costScore          100 - normalize(estimatedCostUsd) against the most
 *                        expensive candidate. Cost = goods + outbound shipping
 *                        + reverse shipping + processing + goodwill - recovered
 *                        value from restock/refurb.
 *     retentionScore     from sentiment: churn reduction expected if this type
 *                        is granted, weighted by customerValue.valueBand.
 *     sustainabilityScore provisional heuristic (NO_RETURN_REQUIRED > repair >
 *                        restock-able replacement > refund-and-scrap). The
 *                        Sustainability Agent later refines the LOGISTICS side;
 *                        this field only ranks resolution TYPES.
 *
 *   STEP 3: WEIGHT AND RANK
 *     Default weights: satisfaction .35, cost .30, retention .25, sustain .10.
 *     `sentiment.retention.satisfactionWeightBoost` shifts weight from cost to
 *     satisfaction for at-risk/high-value customers — this is the mechanism by
 *     which a VIP gets a better outcome than policy alone would give.
 *     Weights are renormalized to sum to 1 and RETURNED in the output so the
 *     UI can show the exact trade-off that was made.
 *
 *   STEP 4: APPLY GOODWILL
 *     Take sentiment's recommendedGestures, keep those whose cumulative
 *     estimatedCostUsd fits inside retention.maxGoodwillBudgetUsd, and convert
 *     them into GoodwillGrants. The demo's "+500 Cosmic Rewards points" is a
 *     BONUS_POINTS grant sized by tierBenefit.pointsMultiplier.
 *
 *   STEP 5: APPROVAL GATE
 *     requiresHumanApproval = totalCostUsd > thresholds.autoApproveMaxUsd
 *                             OR eligibility.decision === 'MANUAL_REVIEW'
 *                             OR goodwill exceeded the tier budget
 *                             OR type === 'ESCALATE'.
 *
 * ESCALATION / EDGE CASES
 *   HIGH_VALUE_APPROVAL_REQUIRED  cost over threshold        -> blocking
 *   NO_FEASIBLE_RESOLUTION        every candidate infeasible -> blocking
 *   REPLACEMENT_OUT_OF_STOCK      preferred type unavailable -> non-blocking
 *                                 (agent silently falls back and says so)
 *   PAYMENT_INSTRUMENT_INVALID    refund impossible          -> non-blocking,
 *                                 auto-switches to STORE_CREDIT
 *   VIP_RETENTION_OVERRIDE        granted above-policy value -> non-blocking,
 *                                 recorded for audit
 *   CONFLICTING_AGENT_OUTPUTS     eligibility DENIED but sentiment demands a
 *                                 gesture -> the agent must resolve this
 *                                 itself (apology credit) rather than escalate,
 *                                 UNLESS the denial is legal/fraud-based.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { ConfidenceSchema, ScoreSchema } from '../../domain/common.schema';
import { ReturnIntentSchema } from '../../domain/return.schema';
import { GoodwillGrantSchema, ResolutionOptionSchema, ResolutionTypeSchema } from '../../domain/resolution.schema';
import { EligibilityOutputSchema } from '../eligibility/eligibility.contract';
import { SentimentOutputSchema } from '../sentiment/sentiment.contract';

/* --------------------------------- INPUT ---------------------------------- */

export const ResolutionInputSchema = z.object({
  caseId: z.string(),
  intent: ReturnIntentSchema,
  context: CaseContextSchema,
  /** Both stage-1 outputs are REQUIRED — this agent is never run without them. */
  eligibility: EligibilityOutputSchema,
  sentiment: SentimentOutputSchema,
});
export type ResolutionInput = z.infer<typeof ResolutionInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

/** The weights actually used, after the sentiment boost. Sums to 1.0. */
export const DecisionWeightsSchema = z.object({
  satisfaction: z.number().min(0).max(1),
  cost: z.number().min(0).max(1),
  retention: z.number().min(0).max(1),
  sustainability: z.number().min(0).max(1),
  /** Why the weights deviated from default, if they did. */
  adjustmentReason: z.string().nullable().default(null),
});
export type DecisionWeights = z.infer<typeof DecisionWeightsSchema>;

/** One row of the comparison table the UI renders. */
export const DecisionMatrixRowSchema = z.object({
  optionId: z.string(),
  type: ResolutionTypeSchema,
  label: z.string(),
  satisfactionScore: ScoreSchema,
  costScore: ScoreSchema,
  retentionScore: ScoreSchema,
  sustainabilityScore: ScoreSchema,
  weightedScore: ScoreSchema,
  estimatedCostUsd: z.number().nonnegative(),
  feasible: z.boolean(),
  /** Populated for the winner; null otherwise. */
  selected: z.boolean().default(false),
  /** One sentence: why this option lost (or won). */
  verdict: z.string(),
});
export type DecisionMatrixRow = z.infer<typeof DecisionMatrixRowSchema>;

/** Full cost breakdown, so the ROI/business-case workstream has real numbers. */
export const CostBreakdownSchema = z.object({
  refundUsd: z.number().nonnegative().default(0),
  storeCreditUsd: z.number().nonnegative().default(0),
  replacementGoodsCostUsd: z.number().nonnegative().default(0),
  outboundShippingUsd: z.number().nonnegative().default(0),
  reverseShippingUsd: z.number().nonnegative().default(0),
  processingUsd: z.number().nonnegative().default(0),
  goodwillUsd: z.number().nonnegative().default(0),
  /** Credit for value recovered by restocking/refurbishing (reduces net). */
  recoveredValueUsd: z.number().nonnegative().default(0),
  /** Sum of the above, recovered value subtracted. */
  netCostUsd: z.number(),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

export const ResolutionOutputSchema = z.object({
  /** The winning option. */
  recommended: ResolutionOptionSchema,
  /** Ranked runners-up (feasible and infeasible), best first. */
  alternatives: z.array(ResolutionOptionSchema).default([]),
  /** Every candidate as a scored row — the "explainable rationale" artifact. */
  decisionMatrix: z.array(DecisionMatrixRowSchema).min(1),
  weights: DecisionWeightsSchema,

  goodwill: z.array(GoodwillGrantSchema).default([]),
  /** True when goodwill exceeded the sentiment agent's stated budget. */
  goodwillBudgetExceeded: z.boolean().default(false),

  costs: CostBreakdownSchema,
  /** Revenue we believe this resolution protects (churn-adjusted LTV). */
  estimatedRetainedValueUsd: z.number().nonnegative(),
  /** retainedValue / netCost — the headline efficiency number for the deck. */
  retentionRoi: z.number().nullable().default(null),

  /** GATE FOR THE LOGISTICS AGENT. False -> logistics is SKIPPED. */
  requiresReturnShipment: z.boolean(),
  /** GATE FOR OUTBOUND: a replacement/exchange also needs a forward shipment. */
  requiresOutboundShipment: z.boolean(),

  requiresHumanApproval: z.boolean(),
  approvalReason: z.string().nullable().default(null),
  /** SLA promise the Communication Agent will quote to the customer. */
  slaHours: z.number().nonnegative(),

  /** Exact wording to show the customer. The Communication Agent may re-tone
   *  it but must not contradict it. */
  customerFacingSummary: z.string(),
  /** Longer internal explanation for the support console. */
  internalRationale: z.string(),
});
export type ResolutionOutput = z.infer<typeof ResolutionOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const ResolutionResultSchema = agentResultSchema(ResolutionOutputSchema);
export type ResolutionResult = z.infer<typeof ResolutionResultSchema>;
