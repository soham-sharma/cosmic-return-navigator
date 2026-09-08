/**
 * ============================================================================
 * AGENT CONTRACT 4/7 — LOGISTICS AGENT
 * ============================================================================
 *
 * PURPOSE
 *   Plan and "book" reverse logistics: enumerate viable return paths, pick a
 *   provisional winner, generate the label, schedule the pickup or drop-off,
 *   and seed the tracking timeline.
 *
 * PIPELINE POSITION
 *   Stage 3, SEQUENTIAL after Resolution Planning.
 *   SKIPPED entirely when `resolution.requiresReturnShipment === false`
 *   (KEEP_AND_REFUND, DENY, pure STORE_CREDIT). When skipped it still returns
 *   a result with status SKIPPED and `required: false` so the UI shows the card
 *   greyed out rather than missing.
 *
 * CRITICAL CONTRACT DETAIL — WHY THIS AGENT EMITS *OPTIONS*, NOT A DECISION
 *   This agent produces `candidateOptions[]` plus a `provisionalSelectionId`
 *   chosen on cost/speed alone. The Sustainability Agent (stage 4) then scores
 *   every option for CO2, and the ORCHESTRATOR makes the final call in its
 *   conflict resolver. That keeps the cost-vs-carbon trade-off in one place
 *   instead of hiding it inside a single agent, and it is what makes the
 *   "consolidated shipping saves X kg CO2" moment demonstrable.
 *   `finalSelectionId` on this output stays null until the orchestrator writes
 *   it back via `applyFinalSelection()`.
 *
 * DECISION LOGIC (simulated — filter, cost model, rank)
 *   STEP 1: FILTER CARRIERS
 *     - servedRegions includes context.regionCode
 *     - servesRemoteAddresses if shippingAddress.isRemote
 *     - maxWeightKg >= parcel weight
 *     - NOT hazmatRestricted when product.sustainability.hazmatClass !== NONE
 *       (smartwatch = LITHIUM_BATTERY -> ground-only carriers)
 *   STEP 2: BUILD OPTIONS (carrier x supported method)
 *     cost      = baseCostUsd + perKgCostUsd * weightKg
 *                 + pickupSurchargeUsd (HOME_PICKUP only)
 *                 + packagingKit.costUsd
 *                 + destinationFacility.processingCostUsd
 *     distance  = haversine(customer, destination facility) — mocked table
 *     co2       = weightKg * distanceKm * carrier.co2PerKgKm
 *                 * (consolidation ? factors.consolidationCo2Multiplier : 1)
 *                 + packagingKit.co2Kg + facility.processingCo2PerItemKg
 *                 (first estimate only; Sustainability owns the real number)
 *     transit   = carrier.transitDaysMin..Max, midpoint
 *     handover  = HOME_PICKUP -> earliestPickupOffsetDays
 *                 DROP_OFF/STORE -> 0 (customer chooses when)
 *     convenience = 100 - distancePenalty - printingPenalty - waitPenalty
 *   STEP 3: PICK DESTINATION FACILITY
 *     Prefer a facility whose `capabilities` match the likely disposition:
 *     restockable -> RETURNS_HUB/WAREHOUSE; damaged+repairable -> REPAIR_CENTER;
 *     damaged+not repairable -> REFURB or RECYCLING_CENTER. Nearest wins ties.
 *   STEP 4: PROVISIONAL SELECTION
 *     Weighted: cost .45, speed .35, convenience .20 — deliberately NOT
 *     carbon-aware, so the Sustainability Agent has something to argue with.
 *     Priority-handling tiers (tierBenefit.priorityHandling) shift weight to
 *     speed.
 *   STEP 5: MATERIALIZE THE SHIPMENT (all mocked)
 *     Label: LBL-xxxxxx, fake tracking number in the carrier's format, mock
 *     labelUrl, QR data when the carrier supports paperless.
 *     Pickup: next available window >= earliestPickupOffsetDays, skipping
 *     Sundays; marked isConsolidated when a batch exists in the postcode.
 *     Tracking: one real LABEL_CREATED/PICKUP_SCHEDULED event plus PROJECTED
 *     future events (isProjected: true) so the UI can draw the full timeline.
 *
 * ESCALATION / EDGE CASES
 *   NO_CARRIER_COVERAGE   no carrier serves this address (remote region)
 *                         -> blocking, LOGISTICS_OPS. Also flips the
 *                         Sustainability Agent into "no greener option" mode.
 *   HAZMAT_RESTRICTED     lithium battery with only air carriers available
 *                         -> non-blocking if a ground carrier exists, blocking
 *                         if none do.
 *   OVERSIZED_ITEM        exceeds every carrier's maxWeightKg -> blocking,
 *                         suggests white-glove collection.
 *   PICKUP_UNAVAILABLE    no pickup slot inside the SLA -> non-blocking,
 *                         auto-falls back to DROP_OFF_POINT and says so.
 *   MISSING_REQUIRED_DATA no product dimensions -> uses category defaults and
 *                         warns.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { ScoreSchema } from '../../domain/common.schema';
import { ReturnMethodSchema } from '../../domain/carrier.schema';
import { LogisticsOptionSchema, ShipmentSchema, ReturnLabelSchema, PickupWindowSchema, TrackingEventSchema } from '../../domain/shipment.schema';
import { ResolutionOutputSchema } from '../resolution/resolution.contract';

/* --------------------------------- INPUT ---------------------------------- */

export const LogisticsInputSchema = z.object({
  caseId: z.string(),
  context: CaseContextSchema,
  /** Required: tells the agent whether a shipment is needed at all, and
   *  whether an outbound replacement must also be planned. */
  resolution: ResolutionOutputSchema,
});
export type LogisticsInput = z.infer<typeof LogisticsInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

/** Scoring transparency for the provisional pick. */
export const LogisticsSelectionBasisSchema = z.object({
  strategy: z.enum(['LOWEST_COST', 'FASTEST', 'BALANCED', 'MOST_CONVENIENT', 'GREENEST']),
  weights: z.object({ cost: z.number(), speed: z.number(), convenience: z.number() }),
  /** Why this strategy was used (e.g. "Platinum tier -> priority handling"). */
  reason: z.string(),
});
export type LogisticsSelectionBasis = z.infer<typeof LogisticsSelectionBasisSchema>;

export const LogisticsOutputSchema = z.object({
  /** False when the resolution needs no physical return. */
  required: z.boolean(),
  skipReason: z.string().nullable().default(null),

  /** All viable paths, ranked by the agent's provisional strategy.
   *  `sustainabilityScore` is null here — filled in at stage 4. */
  candidateOptions: z.array(LogisticsOptionSchema).default([]),
  /** Cost/speed-optimal pick. May be overridden by the orchestrator. */
  provisionalSelectionId: z.string().nullable().default(null),
  /** Written back by the orchestrator AFTER conflict resolution. */
  finalSelectionId: z.string().nullable().default(null),
  selectionBasis: LogisticsSelectionBasisSchema.nullable().default(null),

  /** Materialized artifacts for the provisional selection. Regenerated if the
   *  orchestrator switches options. */
  shipment: ShipmentSchema.nullable().default(null),
  label: ReturnLabelSchema.nullable().default(null),
  pickup: PickupWindowSchema.nullable().default(null),
  dropOffLocationId: z.string().nullable().default(null),
  /** Real + projected events for the UI timeline. */
  trackingEvents: z.array(TrackingEventSchema).default([]),

  /** Outbound replacement leg, when the resolution ships something out. */
  outboundShipment: ShipmentSchema.nullable().default(null),

  method: ReturnMethodSchema.nullable().default(null),
  destinationFacilityId: z.string().nullable().default(null),
  packagingKitId: z.string().nullable().default(null),

  /** Aggregate figures for the provisional selection. */
  estimatedCostUsd: z.number().nonnegative().default(0),
  estimatedTransitDays: z.number().int().nonnegative().default(0),
  estimatedCo2Kg: z.number().nonnegative().default(0),
  estimatedArrivalAt: z.string().nullable().default(null),
  /** Convenience of the provisional pick, for the UI badge. */
  convenienceScore: ScoreSchema.nullable().default(null),

  /** Carriers considered and why any were dropped — explainability. */
  carriersEvaluated: z
    .array(z.object({ carrierId: z.string(), carrierName: z.string(), eligible: z.boolean(), reason: z.string() }))
    .default([]),

  /** True when the pickup joins an existing neighbourhood batch. */
  consolidationApplied: z.boolean().default(false),
  customerFacingSummary: z.string(),
});
export type LogisticsOutput = z.infer<typeof LogisticsOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const LogisticsResultSchema = agentResultSchema(LogisticsOutputSchema);
export type LogisticsResult = z.infer<typeof LogisticsResultSchema>;
