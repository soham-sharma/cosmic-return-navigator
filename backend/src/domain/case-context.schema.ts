/**
 * CASE CONTEXT — the resolved, read-only facts every agent may rely on.
 *
 * The orchestrator hydrates this ONCE at the start of the pipeline (one lookup
 * per entity) and passes the same frozen object to all seven agents. Agents
 * therefore never query repositories themselves, which keeps them pure,
 * independently testable, and trivially parallelizable.
 *
 * This file lives in `domain/` (not `orchestrator/`) and imports only other
 * domain schemas, so agent contracts can depend on it without creating an
 * import cycle with the shared-state model.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, RegionCodeSchema } from './common.schema';
import { CustomerSchema } from './customer.schema';
import { OrderItemSchema, OrderSchema } from './order.schema';
import { InventorySchema, ProductSchema } from './product.schema';
import { CategoryPolicySchema, PolicyThresholdsSchema, ReasonPolicySchema, RegionalRuleSchema, TierBenefitSchema } from './policy.schema';
import { CarrierSchema, DropOffLocationSchema, FacilitySchema, PackagingKitSchema } from './carrier.schema';
import { SustainabilityFactorsSchema } from './sustainability.schema';

/**
 * The slice of policy relevant to THIS case, pre-resolved by the orchestrator.
 * Saves every agent from re-implementing "find the rule that applies".
 */
export const ResolvedPolicySchema = z.object({
  policyId: z.string(),
  policyVersion: z.string(),
  /** Category policy for the returned product (or the default). */
  categoryPolicy: CategoryPolicySchema,
  /** Benefits for this customer's tier. */
  tierBenefit: TierBenefitSchema,
  /** Statutory rules for the shipping region. */
  regionalRule: RegionalRuleSchema,
  /** Overrides for the stated return reason. */
  reasonPolicy: ReasonPolicySchema,
  thresholds: PolicyThresholdsSchema,
  /**
   * Pre-computed effective window: max(store + tier + reason, statutory).
   * The Eligibility Agent still shows the derivation in its rule trace.
   */
  effectiveReturnWindowDays: z.number().int().nonnegative(),
  windowDerivation: z.array(
    z.object({ source: z.string(), days: z.number().int(), applied: z.boolean() }),
  ),
});
export type ResolvedPolicy = z.infer<typeof ResolvedPolicySchema>;

/** Reference data the Logistics and Sustainability agents choose from. */
export const LogisticsCatalogSchema = z.object({
  /** Carriers filtered to those serving the customer's region. */
  carriers: z.array(CarrierSchema),
  /** Candidate destination facilities, nearest first. */
  facilities: z.array(FacilitySchema),
  /** Drop-off points near the customer, nearest first. */
  dropOffLocations: z.array(DropOffLocationSchema),
  packagingKits: z.array(PackagingKitSchema),
  /** True when a consolidated batch is already scheduled in this postcode —
   *  the mechanism behind the demo's "consolidated shipping saves CO2" line. */
  consolidationBatchAvailable: z.boolean(),
  consolidationBatchDate: z.string().nullable(),
});
export type LogisticsCatalog = z.infer<typeof LogisticsCatalogSchema>;

export const CaseContextSchema = z.object({
  /** The frozen "now" for this pipeline run. Agents must use this, not the
   *  system clock, so every rule sees an identical timestamp. */
  now: IsoDateTimeSchema,
  regionCode: RegionCodeSchema,

  customer: CustomerSchema,
  order: OrderSchema,
  /** The specific line item being returned. */
  orderItem: OrderItemSchema,
  product: ProductSchema,
  /** Replacement availability for the same SKU. */
  inventory: InventorySchema,

  policy: ResolvedPolicySchema,
  logisticsCatalog: LogisticsCatalogSchema,
  sustainabilityFactors: SustainabilityFactorsSchema,

  /** Rolling aggregates the Insights Agent trends against. Pre-computed from
   *  the historical returns fixture so no agent has to scan the dataset. */
  historicalAggregates: z.object({
    skuReturnsLast30Days: z.number().int().nonnegative(),
    skuDamagedOnArrivalLast30Days: z.number().int().nonnegative(),
    skuReturnRatePct: z.number(),
    categoryReturnRatePct: z.number(),
    regionReturnRatePct: z.number(),
    /** Prior-period value, so the agent can compute a delta. */
    skuReturnsPrevious30Days: z.number().int().nonnegative(),
    totalReturnsLast30Days: z.number().int().nonnegative(),
  }),
});
export type CaseContext = z.infer<typeof CaseContextSchema>;
