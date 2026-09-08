/**
 * REFERENCE DATA: Carriers, facilities, drop-off locations, packaging kits.
 *
 * Static-ish reference data loaded from fixtures. The Logistics Agent selects
 * from these; the Sustainability Agent scores them using `co2PerKgKm`.
 */
import { z } from 'zod';
import { AddressSchema, RegionCodeSchema } from './common.schema';

export const ReturnMethodSchema = z.enum([
  /** Courier collects from the customer's address. */
  'HOME_PICKUP',
  /** Customer drops at a partner/parcel shop. */
  'DROP_OFF_POINT',
  /** Customer drops at a Cosmic Mart store — usually the greenest option. */
  'STORE_DROP_OFF',
  /** Automated parcel locker. */
  'LOCKER',
  /** Customer keeps the item; no movement at all (greenest by definition). */
  'NO_RETURN_REQUIRED',
]);
export type ReturnMethod = z.infer<typeof ReturnMethodSchema>;

export const CarrierSchema = z.object({
  carrierId: z.string().describe('e.g. CARR-NOVA'),
  name: z.string(),
  supportedMethods: z.array(ReturnMethodSchema).min(1),
  servedRegions: z.array(RegionCodeSchema).min(1),
  /** True if the carrier reaches addresses flagged `isRemote`. */
  servesRemoteAddresses: z.boolean().default(true),

  /* --- cost model (simple linear mock) --- */
  baseCostUsd: z.number().nonnegative(),
  perKgCostUsd: z.number().nonnegative(),
  pickupSurchargeUsd: z.number().nonnegative().default(0),

  /* --- service model --- */
  transitDaysMin: z.number().int().positive(),
  transitDaysMax: z.number().int().positive(),
  /** Earliest pickup offset in days (0 = same day, 1 = next day). */
  earliestPickupOffsetDays: z.number().int().nonnegative().default(1),
  onTimePct: z.number().min(0).max(100).default(95),
  maxWeightKg: z.number().positive(),

  /* --- sustainability model --- */
  co2PerKgKm: z.number().nonnegative().describe('kg CO2e per kg of parcel per km'),
  /** Electric/cargo-bike fleets earn the green badge in the UI. */
  isLowEmission: z.boolean().default(false),
  /** Can batch this return with others going the same way. */
  supportsConsolidation: z.boolean().default(false),
  /** Accepts label-free / QR-code returns (no printed paper). */
  supportsPaperlessLabel: z.boolean().default(true),
  /** Carriers that cannot move lithium batteries by air. */
  hazmatRestricted: z.boolean().default(false),
});
export type Carrier = z.infer<typeof CarrierSchema>;

export const FacilityTypeSchema = z.enum([
  'WAREHOUSE',
  'RETURNS_HUB',
  'REPAIR_CENTER',
  'REFURB_CENTER',
  'RECYCLING_CENTER',
  'DONATION_PARTNER',
  'LIQUIDATION_PARTNER',
  'RETAIL_STORE',
]);
export type FacilityType = z.infer<typeof FacilityTypeSchema>;

export const FacilitySchema = z.object({
  facilityId: z.string().describe('e.g. FAC-NJ-01'),
  name: z.string(),
  type: FacilityTypeSchema,
  address: AddressSchema,
  /** Dispositions this facility can perform, used by the Sustainability Agent. */
  capabilities: z.array(z.enum(['RESTOCK', 'INSPECT', 'REPAIR', 'REFURBISH', 'RECYCLE', 'DONATE', 'LIQUIDATE'])),
  /** Grid mix / operational footprint of processing one item here. */
  processingCo2PerItemKg: z.number().nonnegative().default(0.1),
  /** Cost to intake and inspect one returned unit. */
  processingCostUsd: z.number().nonnegative().default(4),
  acceptsWalkIn: z.boolean().default(false),
  operatingHours: z.string().default('Mon-Sat 09:00-19:00'),
});
export type Facility = z.infer<typeof FacilitySchema>;

/** Third-party drop-off point (parcel shop / locker). */
export const DropOffLocationSchema = z.object({
  locationId: z.string(),
  name: z.string(),
  carrierId: z.string(),
  method: ReturnMethodSchema,
  address: AddressSchema,
  distanceKm: z.number().nonnegative(),
  operatingHours: z.string(),
  acceptsPackaging: z.boolean().default(true),
  /** Box-free returns: staff scans a QR code and packs in bulk. */
  offersBoxFreeReturn: z.boolean().default(false),
});
export type DropOffLocation = z.infer<typeof DropOffLocationSchema>;

/** Packaging options, scored for waste by the Sustainability Agent. */
export const PackagingKitSchema = z.object({
  kitId: z.string().describe('e.g. PKG-REUSE-S'),
  name: z.string(),
  material: z.enum(['CORRUGATED_NEW', 'CORRUGATED_RECYCLED', 'REUSABLE_MAILER', 'POLY_MAILER', 'NONE']),
  /** Waste attributable to a single use of this kit. */
  wasteGrams: z.number().nonnegative(),
  co2Kg: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  reusableCycles: z.number().int().nonnegative().default(0),
  maxWeightKg: z.number().positive(),
  /** True when the customer reuses the box the item arrived in. */
  isOriginalBoxReuse: z.boolean().default(false),
});
export type PackagingKit = z.infer<typeof PackagingKitSchema>;
