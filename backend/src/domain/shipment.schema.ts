/**
 * DATA MODEL: Shipment (+ return label, pickup, tracking)
 *
 * Produced by the Logistics Agent. Everything is mocked: labels are fake URLs,
 * tracking events are generated, no carrier API is called.
 */
import { z } from 'zod';
import { AddressSchema, IsoDateTimeSchema, ScoreSchema } from './common.schema';
import { ReturnMethodSchema } from './carrier.schema';

export const ShipmentStatusSchema = z.enum([
  'LABEL_CREATED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'AT_FACILITY',
  'DELIVERED',
  'EXCEPTION',
  'CANCELLED',
]);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

export const ReturnLabelSchema = z.object({
  labelId: z.string().describe('e.g. LBL-000001'),
  trackingNumber: z.string(),
  carrierId: z.string(),
  /** Mock URL — points at our own /mock-assets path in the demo. */
  labelUrl: z.string(),
  format: z.enum(['PDF', 'PNG', 'ZPL', 'QR_ONLY']),
  /** Paperless returns: customer shows this at the drop-off point. */
  qrCodeData: z.string().nullable().default(null),
  requiresPrinting: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
export type ReturnLabel = z.infer<typeof ReturnLabelSchema>;

export const PickupWindowSchema = z.object({
  pickupId: z.string(),
  scheduledDate: z.string().describe('YYYY-MM-DD in the customer timezone'),
  windowStart: IsoDateTimeSchema,
  windowEnd: IsoDateTimeSchema,
  address: AddressSchema,
  /** e.g. "Leave at front desk". */
  instructions: z.string().nullable().default(null),
  /** Batched with other pickups in the area — the CO2 saving in the demo. */
  isConsolidated: z.boolean().default(false),
  confirmationCode: z.string(),
});
export type PickupWindow = z.infer<typeof PickupWindowSchema>;

export const TrackingEventSchema = z.object({
  eventId: z.string(),
  occurredAt: IsoDateTimeSchema,
  status: ShipmentStatusSchema,
  location: z.string(),
  description: z.string(),
  /** True for events the demo has not "reached" yet — the UI renders these
   *  greyed out as a projected timeline. */
  isProjected: z.boolean().default(false),
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

/**
 * A candidate logistics plan. The Logistics Agent emits several; the
 * Sustainability Agent scores them; the orchestrator picks the winner.
 * This is the object at the centre of the cost-vs-carbon trade-off.
 */
export const LogisticsOptionSchema = z.object({
  optionId: z.string().describe('e.g. OPT-000001'),
  carrierId: z.string(),
  carrierName: z.string(),
  method: ReturnMethodSchema,

  costUsd: z.number().nonnegative(),
  transitDays: z.number().int().nonnegative(),
  /** Days until the item leaves the customer's hands. */
  handoverDelayDays: z.number().int().nonnegative(),
  /** Total customer-perceived time to resolution. */
  totalDaysToResolution: z.number().int().nonnegative(),

  packagingKitId: z.string().nullable().default(null),
  destinationFacilityId: z.string(),
  /** Straight-line distance used by the CO2 model. */
  distanceKm: z.number().nonnegative(),
  consolidationEligible: z.boolean().default(false),
  paperlessLabel: z.boolean().default(true),

  /** Filled by the Logistics Agent as a first estimate; the Sustainability
   *  Agent replaces it with its authoritative calculation. */
  estimatedCo2Kg: z.number().nonnegative(),
  /** 0-100, written by the Sustainability Agent. Null until it has run. */
  sustainabilityScore: ScoreSchema.nullable().default(null),

  /** How convenient for the customer (drop-off distance, printing, etc.). */
  convenienceScore: ScoreSchema,
  feasible: z.boolean().default(true),
  infeasibleReason: z.string().nullable().default(null),
  customerFacingLabel: z.string().describe('e.g. "Next-day home pickup"'),
});
export type LogisticsOption = z.infer<typeof LogisticsOptionSchema>;

export const ShipmentSchema = z.object({
  shipmentId: z.string().describe('e.g. SHP-000001'),
  caseId: z.string(),
  returnId: z.string(),

  direction: z.enum(['INBOUND_RETURN', 'OUTBOUND_REPLACEMENT']).default('INBOUND_RETURN'),
  status: ShipmentStatusSchema,
  method: ReturnMethodSchema,

  carrierId: z.string(),
  carrierName: z.string(),
  label: ReturnLabelSchema.nullable().default(null),
  pickup: PickupWindowSchema.nullable().default(null),
  dropOffLocationId: z.string().nullable().default(null),

  originAddress: AddressSchema,
  destinationFacilityId: z.string(),
  packagingKitId: z.string().nullable().default(null),

  weightKg: z.number().nonnegative(),
  distanceKm: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  co2Kg: z.number().nonnegative(),

  /** Chronological, may include projected future events for the UI timeline. */
  trackingEvents: z.array(TrackingEventSchema).default([]),
  estimatedArrivalAt: IsoDateTimeSchema.nullable().default(null),
  /** Populated on EXCEPTION status. */
  exceptionCode: z
    .enum(['NO_CARRIER_COVERAGE', 'OVERSIZED', 'HAZMAT_RESTRICTED', 'ADDRESS_INVALID', 'PICKUP_MISSED', 'LOST'])
    .nullable()
    .default(null),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Shipment = z.infer<typeof ShipmentSchema>;
