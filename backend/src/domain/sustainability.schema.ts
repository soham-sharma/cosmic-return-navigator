/**
 * DATA MODEL: SustainabilityRecord
 *
 * The auditable environmental ledger entry for one return. Produced by the
 * Sustainability Agent and aggregated into the Sustainability Lead's dashboard.
 *
 * CO2 ACCOUNTING CONVENTION (important — keep the whole team consistent):
 *   footprint  = emissions this return actually causes
 *   baseline   = emissions the "naive" path would have caused
 *   prevented  = baseline - footprint   (>= 0; never report a negative saving)
 * The baseline must always be stated explicitly so the number is defensible.
 */
import { z } from 'zod';
import { ConfidenceSchema, IsoDateTimeSchema, ScoreSchema } from './common.schema';

/** What ultimately happens to the returned unit. Ordered best -> worst for
 *  circularity; the agent prefers the highest viable path. */
export const DispositionPathSchema = z.enum([
  'RESTOCK_AS_NEW',
  'REFURBISH_RESELL',
  'REPAIR_RETURN_TO_CUSTOMER',
  'PARTS_HARVEST',
  'DONATE',
  'RECYCLE',
  'LIQUIDATE',
  'LANDFILL',
  'NO_MOVEMENT',
]);
export type DispositionPath = z.infer<typeof DispositionPathSchema>;

/** Which counterfactual the saving is measured against. */
export const BaselineBasisSchema = z.enum([
  'INDIVIDUAL_EXPRESS_SHIPMENT',
  'STANDARD_INDIVIDUAL_SHIPMENT',
  'LANDFILL_DISPOSAL',
  'NEW_UNIT_MANUFACTURE',
]);
export type BaselineBasis = z.infer<typeof BaselineBasisSchema>;

/** Line-by-line CO2 attribution so the dashboard can show a breakdown chart. */
export const Co2BreakdownSchema = z.object({
  transportKg: z.number().nonnegative(),
  packagingKg: z.number().nonnegative(),
  /** Warehouse intake, inspection, restocking. */
  processingKg: z.number().nonnegative(),
  /** Recycling/landfill/refurb energy. */
  dispositionKg: z.number().nonnegative(),
  /** Negative credit when a refurbished unit avoids new manufacture. */
  avoidedManufactureKg: z.number().default(0),
  totalKg: z.number(),
});
export type Co2Breakdown = z.infer<typeof Co2BreakdownSchema>;

/** A logistics option with its environmental verdict attached. */
export const ScoredOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  co2Kg: z.number().nonnegative(),
  packagingWasteGrams: z.number().nonnegative(),
  sustainabilityScore: ScoreSchema,
  /** True for the greenest feasible option — drives the UI "leaf" badge. */
  isGreenest: z.boolean().default(false),
  breakdown: Co2BreakdownSchema,
  /** Extra cost vs. the cheapest option (can be negative = also cheaper). */
  costDeltaUsd: z.number(),
  /** Extra days vs. the fastest option. */
  transitDaysDelta: z.number().int(),
});
export type ScoredOption = z.infer<typeof ScoredOptionSchema>;

export const PackagingRecommendationSchema = z.object({
  recommendedKitId: z.string().nullable(),
  reuseOriginalBox: z.boolean(),
  wasteAvoidedGrams: z.number().nonnegative(),
  instructions: z.string(),
});
export type PackagingRecommendation = z.infer<typeof PackagingRecommendationSchema>;

/** Optional nudge offered to the customer to pick the greener path. */
export const GreenIncentiveSchema = z.object({
  type: z.enum(['GREEN_POINTS', 'TREE_PLANTED', 'DONATION_MATCH', 'NONE']),
  value: z.number().nonnegative(),
  condition: z.string().describe('e.g. "Choose store drop-off instead of pickup"'),
  customerFacingCopy: z.string(),
});
export type GreenIncentive = z.infer<typeof GreenIncentiveSchema>;

export const SustainabilityRecordSchema = z.object({
  recordId: z.string().describe('e.g. SUS-000001'),
  caseId: z.string(),
  returnId: z.string(),
  sku: z.string(),

  /** The option actually chosen. */
  selectedOptionId: z.string(),
  disposition: DispositionPathSchema,

  footprintKg: z.number().nonnegative().describe('Actual emissions of this return'),
  breakdown: Co2BreakdownSchema,

  baselineBasis: BaselineBasisSchema,
  baselineKg: z.number().nonnegative(),
  /** max(0, baselineKg - footprintKg) — the headline dashboard number. */
  co2PreventedKg: z.number().nonnegative(),

  packagingWasteGrams: z.number().nonnegative(),
  packagingWasteAvoidedGrams: z.number().nonnegative().default(0),
  /** Value recovered by restocking/refurbishing instead of scrapping. */
  recoveredValueUsd: z.number().nonnegative().default(0),
  /** 0-100: how well this return kept material in the loop. */
  circularityScore: ScoreSchema,
  sustainabilityScore: ScoreSchema.describe('Overall grade for this return'),
  grade: z.enum(['A', 'B', 'C', 'D', 'F']),

  /** False for the "no greener option available" edge case. */
  greenerAlternativeExisted: z.boolean(),
  /** True when the customer/orchestrator declined the greener option. */
  greenOptionDeclined: z.boolean().default(false),
  offsetPurchased: z
    .object({ programId: z.string(), kgOffset: z.number().nonnegative(), costUsd: z.number().nonnegative() })
    .nullable()
    .default(null),

  rationale: z.string(),
  confidence: ConfidenceSchema,
  calculatedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type SustainabilityRecord = z.infer<typeof SustainabilityRecordSchema>;

/** Emission/waste factors, externalized so they can be tuned without code
 *  changes. Loaded from mocks/fixtures/sustainability-factors.json. */
export const SustainabilityFactorsSchema = z.object({
  /** Fallback when a carrier has no specific factor. */
  defaultCo2PerKgKm: z.number().nonnegative(),
  processingCo2PerItemKg: z.number().nonnegative(),
  landfillCo2PerKgKg: z.number().nonnegative(),
  recyclingCo2SavedPerKgKg: z.number().nonnegative(),
  /** Fraction of embodied carbon avoided by reselling a refurbished unit. */
  refurbishAvoidanceRatio: z.number().min(0).max(1),
  offsetCostPerKgUsd: z.number().nonnegative(),
  /** Multiplier applied when a parcel rides in a consolidated batch. */
  consolidationCo2Multiplier: z.number().min(0).max(1),
  gradeThresholds: z.object({ A: z.number(), B: z.number(), C: z.number(), D: z.number() }),
});
export type SustainabilityFactors = z.infer<typeof SustainabilityFactorsSchema>;
