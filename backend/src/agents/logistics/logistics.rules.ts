/**
 * LOGISTICS RULES — pure functions.
 *
 * OWNER: <assign>
 * STATUS: wireframe. Carrier filtering, the cost/CO2 model and option building
 * are implemented at demo depth; distance lookup and facility routing are TODO.
 */
import { newId } from '../../core/ids';
import { addDays, isoInDays } from '../../core/clock';
import type { CaseContext } from '../../domain/case-context.schema';
import type { Carrier, ReturnMethod } from '../../domain/carrier.schema';
import type { LogisticsOption, PickupWindow, ReturnLabel, TrackingEvent } from '../../domain/shipment.schema';
import { isMerchantFault } from '../../domain/return.schema';

/** Provisional selection weights — deliberately NOT carbon-aware. */
export const SELECTION_WEIGHTS = { cost: 0.45, speed: 0.35, convenience: 0.2 } as const;

/* -------------------------------------------------------------------------- */
/* STEP 1 — carrier filtering                                                  */
/* -------------------------------------------------------------------------- */

export interface CarrierVerdict {
  carrierId: string;
  carrierName: string;
  eligible: boolean;
  reason: string;
}

export function filterCarriers(ctx: CaseContext): CarrierVerdict[] {
  const weightKg = ctx.product.dimensions.weightKg;
  const isRemote = ctx.order.shippingAddress.isRemote;
  const hazmat = ctx.product.sustainability.hazmatClass !== 'NONE';

  return ctx.logisticsCatalog.carriers.map((c) => {
    if (!c.servedRegions.includes(ctx.regionCode)) {
      return { carrierId: c.carrierId, carrierName: c.name, eligible: false, reason: `Does not serve ${ctx.regionCode}.` };
    }
    if (isRemote && !c.servesRemoteAddresses) {
      return { carrierId: c.carrierId, carrierName: c.name, eligible: false, reason: 'Does not collect from remote addresses.' };
    }
    if (weightKg > c.maxWeightKg) {
      return { carrierId: c.carrierId, carrierName: c.name, eligible: false, reason: `Parcel is ${weightKg}kg, above the ${c.maxWeightKg}kg limit.` };
    }
    if (hazmat && c.hazmatRestricted) {
      return {
        carrierId: c.carrierId,
        carrierName: c.name,
        eligible: false,
        reason: `Cannot carry ${ctx.product.sustainability.hazmatClass.replace(/_/g, ' ').toLowerCase()} shipments.`,
      };
    }
    return { carrierId: c.carrierId, carrierName: c.name, eligible: true, reason: 'Serves this region and can carry this parcel.' };
  });
}

/* -------------------------------------------------------------------------- */
/* STEP 2 — distance and option construction                                   */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): replace with a haversine calculation using the lat/long on the
 * address and facility fixtures. The placeholder returns a deterministic
 * pseudo-distance so CO2 numbers are stable across runs.
 */
export function estimateDistanceKm(ctx: CaseContext, facilityId: string): number {
  const from = ctx.order.shippingAddress;
  const facility = ctx.logisticsCatalog.facilities.find((f) => f.facilityId === facilityId);
  if (from.latitude !== null && from.longitude !== null && facility?.address.latitude != null && facility.address.longitude != null) {
    return haversineKm(from.latitude, from.longitude, facility.address.latitude, facility.address.longitude);
  }
  // Deterministic fallback keyed off the postal code so the demo is stable.
  const seed = [...`${from.postalCode}${facilityId}`].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return 40 + (seed % 380);
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/**
 * TODO(owner): route by likely disposition (repairable -> REPAIR_CENTER, etc.).
 * Placeholder: the facility the order shipped from, else the first returns hub.
 */
export function selectDestinationFacility(ctx: CaseContext): string {
  const hub = ctx.logisticsCatalog.facilities.find((f) => f.facilityId === ctx.order.fulfillmentFacilityId);
  if (hub) return hub.facilityId;
  const returnsHub = ctx.logisticsCatalog.facilities.find((f) => f.type === 'RETURNS_HUB' || f.type === 'WAREHOUSE');
  return returnsHub?.facilityId ?? ctx.logisticsCatalog.facilities[0]?.facilityId ?? 'FAC-UNKNOWN';
}

/** Picks the packaging kit: reuse the original box whenever possible. */
export function selectPackagingKit(ctx: CaseContext, method: ReturnMethod): string | null {
  const kits = ctx.logisticsCatalog.packagingKits;
  if (method === 'NO_RETURN_REQUIRED') return null;
  // Box-free drop-off needs no packaging at all.
  const boxFree = ctx.logisticsCatalog.dropOffLocations.some((d) => d.offersBoxFreeReturn);
  if (method === 'STORE_DROP_OFF' && boxFree) return kits.find((k) => k.material === 'NONE')?.kitId ?? null;
  const reuse = kits.find((k) => k.isOriginalBoxReuse && k.maxWeightKg >= ctx.product.dimensions.weightKg);
  if (reuse) return reuse.kitId;
  return (
    kits.filter((k) => k.maxWeightKg >= ctx.product.dimensions.weightKg).sort((a, b) => a.wasteGrams - b.wasteGrams)[0]?.kitId ?? null
  );
}

/** Builds one option per (eligible carrier x supported method). */
export function buildOptions(ctx: CaseContext, eligibleCarriers: Carrier[]): LogisticsOption[] {
  const facilityId = selectDestinationFacility(ctx);
  const facility = ctx.logisticsCatalog.facilities.find((f) => f.facilityId === facilityId);
  const distanceKm = estimateDistanceKm(ctx, facilityId);
  const weightKg = ctx.product.dimensions.weightKg;
  const factors = ctx.sustainabilityFactors;
  const options: LogisticsOption[] = [];

  for (const carrier of eligibleCarriers) {
    for (const method of carrier.supportedMethods) {
      if (method === 'NO_RETURN_REQUIRED') continue;

      const kitId = selectPackagingKit(ctx, method);
      const kit = ctx.logisticsCatalog.packagingKits.find((k) => k.kitId === kitId);
      const dropOff = ctx.logisticsCatalog.dropOffLocations.find((d) => d.carrierId === carrier.carrierId && d.method === method);

      // Drop-off methods need a nearby location to be viable.
      if ((method === 'DROP_OFF_POINT' || method === 'LOCKER' || method === 'STORE_DROP_OFF') && !dropOff) continue;

      const consolidated = carrier.supportsConsolidation && ctx.logisticsCatalog.consolidationBatchAvailable && method === 'HOME_PICKUP';

      const costUsd =
        Math.round(
          (carrier.baseCostUsd +
            carrier.perKgCostUsd * weightKg +
            (method === 'HOME_PICKUP' ? carrier.pickupSurchargeUsd : 0) +
            (kit?.costUsd ?? 0) +
            (facility?.processingCostUsd ?? 0)) *
            100,
        ) / 100;

      const transitDays = Math.round((carrier.transitDaysMin + carrier.transitDaysMax) / 2);
      const handoverDelayDays = method === 'HOME_PICKUP' ? carrier.earliestPickupOffsetDays : 0;

      const estimatedCo2Kg =
        Math.round(
          (weightKg * distanceKm * carrier.co2PerKgKm * (consolidated ? factors.consolidationCo2Multiplier : 1) +
            (kit?.co2Kg ?? 0) +
            (facility?.processingCo2PerItemKg ?? factors.processingCo2PerItemKg)) *
            1000,
        ) / 1000;

      options.push({
        optionId: newId('logisticsOption'),
        carrierId: carrier.carrierId,
        carrierName: carrier.name,
        method,
        costUsd,
        transitDays,
        handoverDelayDays,
        totalDaysToResolution: transitDays + handoverDelayDays,
        packagingKitId: kitId,
        destinationFacilityId: facilityId,
        distanceKm,
        consolidationEligible: carrier.supportsConsolidation,
        paperlessLabel: carrier.supportsPaperlessLabel,
        estimatedCo2Kg,
        sustainabilityScore: null, // filled by the Sustainability Agent
        convenienceScore: scoreConvenience(method, dropOff?.distanceKm ?? null, carrier.supportsPaperlessLabel),
        feasible: true,
        infeasibleReason: null,
        customerFacingLabel: describeOption(carrier.name, method, handoverDelayDays, consolidated),
      });
    }
  }

  return options;
}

/** TODO(owner): tune the penalties against user testing. */
export function scoreConvenience(method: ReturnMethod, dropOffDistanceKm: number | null, paperless: boolean): number {
  let score = method === 'HOME_PICKUP' ? 95 : method === 'LOCKER' ? 80 : method === 'STORE_DROP_OFF' ? 70 : 65;
  if (dropOffDistanceKm !== null) score -= Math.min(25, dropOffDistanceKm * 3);
  if (!paperless) score -= 10; // customer has to find a printer
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function describeOption(carrierName: string, method: ReturnMethod, delayDays: number, consolidated: boolean): string {
  const when = delayDays === 0 ? 'Any time' : delayDays === 1 ? 'Next-day' : `In ${delayDays} days`;
  const what =
    method === 'HOME_PICKUP' ? 'home pickup'
    : method === 'STORE_DROP_OFF' ? 'Cosmic Mart store drop-off'
    : method === 'LOCKER' ? 'parcel locker drop-off'
    : 'drop-off point';
  return `${when} ${what} with ${carrierName}${consolidated ? ' (consolidated route)' : ''}`;
}

/* -------------------------------------------------------------------------- */
/* STEP 4 — provisional selection                                              */
/* -------------------------------------------------------------------------- */

/**
 * Weighting when the merchant or carrier caused the return.
 *
 * WHY: sending someone to a locker or a shop because WE shipped them a broken
 * item is the friction the PRD is built to remove. When the fault is ours, the
 * courier comes to the customer — convenience outranks cost and speed. This is
 * also what makes "we scheduled a pickup for tomorrow" the principled outcome
 * rather than a coincidence of the cost model.
 */
export const MERCHANT_FAULT_WEIGHTS = { cost: 0.2, speed: 0.25, convenience: 0.55 } as const;

export function selectProvisional(
  options: LogisticsOption[],
  ctx: CaseContext,
): {
  option: LogisticsOption | null;
  strategy: 'LOWEST_COST' | 'FASTEST' | 'BALANCED' | 'MOST_CONVENIENT';
  reason: string;
} {
  if (options.length === 0) return { option: null, strategy: 'BALANCED', reason: 'No viable options.' };

  const merchantFault = isMerchantFault(ctx.policy.reasonPolicy.reason);
  const priority = ctx.policy.tierBenefit.priorityHandling;

  const { weights, strategy, reason } = merchantFault
    ? {
        weights: MERCHANT_FAULT_WEIGHTS,
        strategy: 'MOST_CONVENIENT' as const,
        reason: `The item ${ctx.policy.reasonPolicy.reason === 'DAMAGED_ON_ARRIVAL' ? 'arrived damaged' : 'was our error'}, so convenience is weighted above cost — we collect from the customer rather than asking them to travel.`,
      }
    : priority
      ? {
          weights: { cost: 0.25, speed: 0.55, convenience: 0.2 },
          strategy: 'FASTEST' as const,
          reason: `${ctx.customer.loyaltyTier} tier includes priority handling, so speed is weighted above cost.`,
        }
      : {
          weights: SELECTION_WEIGHTS,
          strategy: 'BALANCED' as const,
          reason: 'Balanced cost, speed and convenience. Carbon is scored separately by the Sustainability Agent.',
        };

  const maxCost = Math.max(...options.map((o) => o.costUsd), 1);
  const maxDays = Math.max(...options.map((o) => o.totalDaysToResolution), 1);

  function score(o: LogisticsOption): number {
    return (
      (100 - (o.costUsd / maxCost) * 100) * weights.cost +
      (100 - (o.totalDaysToResolution / maxDays) * 100) * weights.speed +
      o.convenienceScore * weights.convenience
    );
  }

  const ranked = [...options].sort((a, b) => score(b) - score(a));
  return { option: ranked[0] ?? null, strategy, reason };
}

/* -------------------------------------------------------------------------- */
/* STEP 5 — materialize the (mocked) artifacts                                 */
/* -------------------------------------------------------------------------- */

export function generateLabel(ctx: CaseContext, option: LogisticsOption): ReturnLabel {
  const labelId = newId('label');
  const carrier = ctx.logisticsCatalog.carriers.find((c) => c.carrierId === option.carrierId);
  // Mock tracking number in a plausible carrier format.
  const trackingNumber = `${option.carrierId.replace('CARR-', '')}${Date.now().toString().slice(-9)}`;

  return {
    labelId,
    trackingNumber,
    carrierId: option.carrierId,
    labelUrl: `/mock-assets/labels/${labelId}.pdf`,
    format: option.paperlessLabel ? 'QR_ONLY' : 'PDF',
    qrCodeData: option.paperlessLabel ? `COSMIC:RETURN:${trackingNumber}` : null,
    requiresPrinting: !option.paperlessLabel,
    createdAt: ctx.now,
    expiresAt: isoInDays(21),
  };
}

/**
 * Next available pickup window, skipping Sundays.
 * TODO(owner): honour carrier capacity and the customer's timezone properly.
 */
export function schedulePickup(ctx: CaseContext, option: LogisticsOption): PickupWindow {
  let date = addDays(ctx.now, Math.max(1, option.handoverDelayDays));
  if (date.getUTCDay() === 0) date = addDays(date, 1); // no Sunday collections

  const windowStart = new Date(date);
  windowStart.setUTCHours(9, 0, 0, 0);
  const windowEnd = new Date(date);
  windowEnd.setUTCHours(13, 0, 0, 0);

  return {
    pickupId: newId('pickup'),
    scheduledDate: date.toISOString().slice(0, 10),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    address: ctx.order.shippingAddress,
    instructions: null,
    isConsolidated: ctx.logisticsCatalog.consolidationBatchAvailable && option.consolidationEligible,
    confirmationCode: `PKP-${Math.floor(Math.random() * 900000 + 100000)}`,
  };
}

/**
 * Seeds the tracking timeline: real events now, projected events flagged so the
 * UI can grey them out.
 */
export function buildTrackingTimeline(ctx: CaseContext, option: LogisticsOption, pickup: PickupWindow | null): TrackingEvent[] {
  const events: TrackingEvent[] = [
    {
      eventId: newId('event'),
      occurredAt: ctx.now,
      status: 'LABEL_CREATED',
      location: `${ctx.order.shippingAddress.city}, ${ctx.order.shippingAddress.countryCode}`,
      description: 'Return label created and sent to the customer.',
      isProjected: false,
    },
  ];

  if (pickup) {
    events.push({
      eventId: newId('event'),
      occurredAt: ctx.now,
      status: 'PICKUP_SCHEDULED',
      location: `${ctx.order.shippingAddress.city}, ${ctx.order.shippingAddress.countryCode}`,
      description: `Pickup scheduled for ${pickup.scheduledDate} between 09:00 and 13:00${pickup.isConsolidated ? ' on a consolidated route' : ''}.`,
      isProjected: false,
    });
    events.push({
      eventId: newId('event'),
      occurredAt: pickup.windowStart,
      status: 'PICKED_UP',
      location: `${ctx.order.shippingAddress.city}, ${ctx.order.shippingAddress.countryCode}`,
      description: 'Parcel collected from the customer.',
      isProjected: true,
    });
  }

  events.push(
    {
      eventId: newId('event'),
      occurredAt: isoInDays(option.handoverDelayDays + 1),
      status: 'IN_TRANSIT',
      location: 'In transit',
      description: `On the way to the returns facility with ${option.carrierName}.`,
      isProjected: true,
    },
    {
      eventId: newId('event'),
      occurredAt: isoInDays(option.totalDaysToResolution),
      status: 'AT_FACILITY',
      location: option.destinationFacilityId,
      description: 'Arrived at the returns facility for inspection.',
      isProjected: true,
    },
  );

  return events;
}
