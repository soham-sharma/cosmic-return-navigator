/**
 * ============================================================================
 * AGENT CONTRACT 6/7 — SUSTAINABILITY AGENT
 * ============================================================================
 * (Numbered 6 in the PRD; runs at pipeline stage 4 — see note below.)
 *
 * PURPOSE
 *   Quantify the environmental impact of each candidate return path (CO2 and
 *   packaging waste), recommend the greenest VIABLE option, choose the best
 *   end-of-life disposition, and produce the auditable SustainabilityRecord
 *   that the Sustainability Lead's dashboard aggregates.
 *
 * PIPELINE POSITION
 *   Stage 4, SEQUENTIAL after Logistics.
 *   WHY NOT PARALLEL WITH LOGISTICS: this agent scores the concrete options
 *   Logistics produced. Running it earlier would force it to guess at carriers
 *   and distances, and the "greener alternative" recommendation would not be
 *   traceable to a real bookable path.
 *   Its output feeds the orchestrator's conflict resolver, which makes the
 *   final cost-vs-carbon call before Communication runs.
 *
 * CO2 MODEL (simulated — deterministic factor model, see fixtures)
 *   Per option:
 *     transportKg   = weightKg * distanceKm * carrier.co2PerKgKm
 *                     * (consolidated ? consolidationCo2Multiplier : 1)
 *     packagingKg   = packagingKit.co2Kg  (0 when reusing the original box)
 *     processingKg  = facility.processingCo2PerItemKg
 *     dispositionKg = per-path factor (landfill worst, restock ~0)
 *     avoidedManufactureKg = NEGATIVE credit when the unit re-enters sale as
 *                     refurbished: -embodiedCarbonKg * refurbishAvoidanceRatio
 *     totalKg       = sum of the above
 *
 *   BASELINE (the counterfactual — must always be stated explicitly):
 *     Default INDIVIDUAL_EXPRESS_SHIPMENT: the same parcel moved alone by the
 *     fastest carrier in a new corrugated box, then landfilled.
 *     co2PreventedKg = max(0, baselineKg - footprintKg)
 *   NEVER report a negative "saving" — clamp at zero and warn instead.
 *
 *   sustainabilityScore (0-100) per option, then graded A-F via
 *   factors.gradeThresholds. Score blends: CO2 vs baseline (50%), packaging
 *   waste (20%), circularity of the disposition (30%).
 *
 * DISPOSITION SELECTION (highest viable path wins)
 *   RESTOCK_AS_NEW        condition NEW_UNOPENED and not damaged
 *   REPAIR_RETURN_...     resolution type is REPAIR
 *   REFURBISH_RESELL      product.refurbishable and condition repairable
 *   PARTS_HARVEST         not functional but components recoverable
 *   DONATE                usable, low resale value, donation partner in region
 *   RECYCLE               recyclablePct >= 50
 *   LIQUIDATE             sellable in bulk
 *   LANDFILL              last resort — always raises a warning
 *   NO_MOVEMENT           KEEP_AND_REFUND: the greenest outcome available
 *
 * GREEN NUDGE
 *   When the greenest option is not the provisional pick, the agent computes
 *   the trade-off (costDeltaUsd, transitDaysDelta) and emits a `tradeoff`
 *   verdict of ADOPT_GREEN / KEEP_CURRENT / OFFER_CUSTOMER_CHOICE. It may also
 *   attach a GreenIncentive (e.g. "+50 green points for store drop-off") that
 *   the Communication Agent surfaces. The agent RECOMMENDS; the orchestrator
 *   DECIDES.
 *
 * ESCALATION / EDGE CASES
 *   NO_GREENER_OPTION_AVAILABLE  the provisional pick is already the greenest,
 *                                or only one option exists (remote region)
 *                                -> non-blocking, informational. This is the
 *                                PRD's "no greener logistics option" case and
 *                                the UI must show it as a neutral fact, not a
 *                                failure.
 *   DISPOSITION_UNRESOLVED       no facility in region can perform any viable
 *                                disposition -> non-blocking, defaults to
 *                                LANDFILL with a warning and a flagged insight.
 *   MISSING_REQUIRED_DATA        no embodiedCarbonKg for the SKU -> falls back
 *                                to category averages, lowers confidence.
 *   Logistics SKIPPED            still runs: scores the NO_MOVEMENT path, which
 *                                is a genuine (and maximal) CO2 saving.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { ScoreSchema } from '../../domain/common.schema';
import {
  BaselineBasisSchema,
  Co2BreakdownSchema,
  DispositionPathSchema,
  GreenIncentiveSchema,
  PackagingRecommendationSchema,
  ScoredOptionSchema,
  SustainabilityRecordSchema,
} from '../../domain/sustainability.schema';
import { ResolutionOutputSchema } from '../resolution/resolution.contract';
import { LogisticsOutputSchema } from '../logistics/logistics.contract';

/* --------------------------------- INPUT ---------------------------------- */

export const SustainabilityInputSchema = z.object({
  caseId: z.string(),
  context: CaseContextSchema,
  resolution: ResolutionOutputSchema,
  /** Required even when logistics was skipped — `required: false` tells this
   *  agent to score the NO_MOVEMENT path. */
  logistics: LogisticsOutputSchema,
});
export type SustainabilityInput = z.infer<typeof SustainabilityInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

/** The agent's recommendation to the orchestrator about the green trade-off. */
export const SustainabilityTradeoffSchema = z.object({
  verdict: z.enum(['ADOPT_GREEN', 'KEEP_CURRENT', 'OFFER_CUSTOMER_CHOICE']),
  /** Extra cost of going green (negative = also cheaper). */
  costDeltaUsd: z.number(),
  /** Extra days of going green (negative = also faster). */
  transitDaysDelta: z.number().int(),
  /** CO2 saved by switching to the green option. */
  co2SavingKg: z.number().nonnegative(),
  /** USD per kg of CO2 avoided — the number that makes the call defensible. */
  costPerKgCo2Usd: z.number().nullable().default(null),
  reason: z.string(),
});
export type SustainabilityTradeoff = z.infer<typeof SustainabilityTradeoffSchema>;

export const DispositionPlanSchema = z.object({
  path: DispositionPathSchema,
  facilityId: z.string().nullable().default(null),
  /** 0-100: how well material is kept in the loop. */
  circularityScore: ScoreSchema,
  recoveredValueUsd: z.number().nonnegative(),
  /** Paths considered and rejected, with reasons — explainability. */
  alternativesConsidered: z
    .array(z.object({ path: DispositionPathSchema, viable: z.boolean(), reason: z.string() }))
    .default([]),
  rationale: z.string(),
});
export type DispositionPlan = z.infer<typeof DispositionPlanSchema>;

export const SustainabilityOutputSchema = z.object({
  /** Every logistics option with its CO2 verdict. Exactly one isGreenest. */
  scoredOptions: z.array(ScoredOptionSchema).min(1),
  /** The greenest FEASIBLE option. */
  greenestOptionId: z.string(),
  /** What the agent recommends the case actually use. Usually the greenest,
   *  but may equal the provisional pick when the trade-off is not worth it. */
  recommendedOptionId: z.string(),
  /** False for the "no greener option available" edge case. */
  greenerAlternativeAvailable: z.boolean(),
  tradeoff: SustainabilityTradeoffSchema,

  /* --- the authoritative footprint of the recommended path --- */
  footprintKg: z.number().nonnegative(),
  breakdown: Co2BreakdownSchema,
  baselineBasis: BaselineBasisSchema,
  baselineKg: z.number().nonnegative(),
  /** Headline number: max(0, baseline - footprint). */
  co2PreventedKg: z.number().nonnegative(),
  /** Relatable equivalents for the customer-facing message. */
  equivalents: z.object({
    carKmAvoided: z.number().nonnegative(),
    treeDaysOfAbsorption: z.number().nonnegative(),
    smartphoneChargesEquivalent: z.number().nonnegative(),
  }),

  packagingWasteGrams: z.number().nonnegative(),
  packaging: PackagingRecommendationSchema,

  disposition: DispositionPlanSchema,

  sustainabilityScore: ScoreSchema,
  grade: z.enum(['A', 'B', 'C', 'D', 'F']),
  /** Optional carbon offset to neutralize the residual footprint. */
  offset: z
    .object({ programId: z.string(), kgOffset: z.number().nonnegative(), costUsd: z.number().nonnegative() })
    .nullable()
    .default(null),
  /** Optional nudge for the Communication Agent to surface. */
  incentive: GreenIncentiveSchema.nullable().default(null),

  /** The persisted ledger entry. The orchestrator saves this via the service. */
  record: SustainabilityRecordSchema,

  /** One sentence for the customer, e.g. "Consolidated pickup saves 1.8 kg CO2
   *  versus an express single shipment." */
  customerFacingSummary: z.string(),
});
export type SustainabilityOutput = z.infer<typeof SustainabilityOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const SustainabilityResultSchema = agentResultSchema(SustainabilityOutputSchema);
export type SustainabilityResult = z.infer<typeof SustainabilityResultSchema>;
