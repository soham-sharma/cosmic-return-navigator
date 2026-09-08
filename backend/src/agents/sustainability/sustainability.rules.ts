/**
 * SUSTAINABILITY RULES — pure functions.
 *
 * OWNER: <assign>
 * STATUS: wireframe. The factor model is implemented (it must be, for the CO2
 * numbers to be defensible); disposition routing and the offset model are TODO.
 *
 * All factors come from `context.sustainabilityFactors`, loaded from
 * mocks/fixtures/sustainability-factors.json — never hardcode them here.
 */
import type { CaseContext } from '../../domain/case-context.schema';
import type { LogisticsOption } from '../../domain/shipment.schema';
import type { Co2Breakdown, DispositionPath, ScoredOption } from '../../domain/sustainability.schema';
import type { ResolutionOutput } from '../resolution/resolution.contract';

/** Score composition. Must sum to 1.0. */
export const SCORE_WEIGHTS = { co2: 0.5, packaging: 0.2, circularity: 0.3 } as const;

/** Relative CO2 penalty per disposition path, as a fraction of item weight. */
export const DISPOSITION_CO2_FACTOR: Record<DispositionPath, number> = {
  RESTOCK_AS_NEW: 0.0,
  REFURBISH_RESELL: 0.15,
  REPAIR_RETURN_TO_CUSTOMER: 0.2,
  PARTS_HARVEST: 0.25,
  DONATE: 0.05,
  RECYCLE: 0.3,
  LIQUIDATE: 0.1,
  LANDFILL: 1.0,
  NO_MOVEMENT: 0.0,
};

/** How well each path keeps material in the loop (0-100). */
export const CIRCULARITY_SCORE: Record<DispositionPath, number> = {
  RESTOCK_AS_NEW: 100,
  REFURBISH_RESELL: 90,
  REPAIR_RETURN_TO_CUSTOMER: 95,
  PARTS_HARVEST: 65,
  DONATE: 75,
  RECYCLE: 55,
  LIQUIDATE: 45,
  LANDFILL: 0,
  NO_MOVEMENT: 100,
};

/* -------------------------------------------------------------------------- */
/* Disposition selection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): check facility capabilities per region before committing to a
 * path, and fall through to the next-best when unavailable.
 * Precedence is highest-value-recovery first, per the contract.
 */
export function chooseDisposition(
  ctx: CaseContext,
  resolution: ResolutionOutput,
  logisticsRequired: boolean,
): { path: DispositionPath; alternatives: { path: DispositionPath; viable: boolean; reason: string }[] } {
  const condition = ctx.orderItem.serialNumber ? 'SERIALIZED' : 'STANDARD';
  const p = ctx.product;
  const damaged = ['DAMAGED_ON_ARRIVAL', 'DEFECTIVE'].includes(resolution.recommended.type) === false;

  const candidates: { path: DispositionPath; viable: boolean; reason: string }[] = [
    {
      path: 'NO_MOVEMENT',
      viable: !logisticsRequired,
      reason: !logisticsRequired ? 'Item stays with the customer — zero transport emissions.' : 'A physical return is required.',
    },
    {
      path: 'REPAIR_RETURN_TO_CUSTOMER',
      viable: resolution.recommended.type === 'REPAIR',
      reason: resolution.recommended.type === 'REPAIR' ? 'Repair keeps the original unit in service.' : 'Resolution is not a repair.',
    },
    {
      path: 'RESTOCK_AS_NEW',
      viable: !p.isPerishable && condition === 'STANDARD' && damaged === false ? false : false,
      // TODO(owner): needs the true reported condition; wireframe is conservative.
      reason: 'Restocking requires an unopened, undamaged unit verified at intake.',
    },
    {
      path: 'REFURBISH_RESELL',
      viable: p.sustainability.refurbishable,
      reason: p.sustainability.refurbishable
        ? `Refurbishing avoids ${(p.sustainability.embodiedCarbonKg * ctx.sustainabilityFactors.refurbishAvoidanceRatio).toFixed(1)}kg of new-manufacture CO2.`
        : 'This product is not refurbishable.',
    },
    {
      path: 'PARTS_HARVEST',
      viable: p.category === 'ELECTRONICS' || p.category === 'WEARABLES',
      reason: 'Components can be recovered from electronics and wearables.',
    },
    {
      path: 'RECYCLE',
      viable: p.sustainability.recyclablePct >= 50,
      reason: `${p.sustainability.recyclablePct}% of this product is recyclable.`,
    },
    {
      path: 'DONATE',
      viable: ctx.logisticsCatalog.facilities.some((f) => f.capabilities.includes('DONATE')),
      reason: 'A donation partner operates in this region.',
    },
    { path: 'LIQUIDATE', viable: true, reason: 'Bulk liquidation is always available as a fallback.' },
    { path: 'LANDFILL', viable: true, reason: 'Last resort when no recovery path is viable.' },
  ];

  const chosen = candidates.find((c) => c.viable)?.path ?? 'LANDFILL';
  return { path: chosen, alternatives: candidates };
}

/* -------------------------------------------------------------------------- */
/* CO2 model                                                                   */
/* -------------------------------------------------------------------------- */

/** Authoritative footprint for one logistics option + disposition. */
export function computeBreakdown(
  ctx: CaseContext,
  option: LogisticsOption | null,
  disposition: DispositionPath,
): Co2Breakdown {
  const f = ctx.sustainabilityFactors;
  const weightKg = ctx.product.dimensions.weightKg;

  if (!option) {
    // NO_MOVEMENT: nothing ships, nothing is processed.
    const b: Co2Breakdown = { transportKg: 0, packagingKg: 0, processingKg: 0, dispositionKg: 0, avoidedManufactureKg: 0, totalKg: 0 };
    return b;
  }

  const carrier = ctx.logisticsCatalog.carriers.find((c) => c.carrierId === option.carrierId);
  const kit = ctx.logisticsCatalog.packagingKits.find((k) => k.kitId === option.packagingKitId);
  const facility = ctx.logisticsCatalog.facilities.find((fa) => fa.facilityId === option.destinationFacilityId);
  const consolidated = ctx.logisticsCatalog.consolidationBatchAvailable && option.consolidationEligible && option.method === 'HOME_PICKUP';

  const transportKg =
    weightKg * option.distanceKm * (carrier?.co2PerKgKm ?? f.defaultCo2PerKgKm) * (consolidated ? f.consolidationCo2Multiplier : 1);
  const packagingKg = kit?.co2Kg ?? 0;
  const processingKg = facility?.processingCo2PerItemKg ?? f.processingCo2PerItemKg;
  const dispositionKg =
    disposition === 'LANDFILL'
      ? weightKg * f.landfillCo2PerKgKg
      : weightKg * f.landfillCo2PerKgKg * DISPOSITION_CO2_FACTOR[disposition];
  const avoidedManufactureKg =
    disposition === 'REFURBISH_RESELL' || disposition === 'RESTOCK_AS_NEW'
      ? -(ctx.product.sustainability.embodiedCarbonKg * f.refurbishAvoidanceRatio)
      : 0;

  /**
   * `totalKg` is the ROUTE-ATTRIBUTABLE footprint only:
   *   transport + packaging + processing + disposition
   *
   * `avoidedManufactureKg` is deliberately EXCLUDED from the total. It is a
   * property of the DISPOSITION (refurbishing this unit avoids building a new
   * one), which is identical across every logistics option, and it is an order
   * of magnitude larger than the transport differences. Folding it in would
   * drive every option negative, clamp them all to zero, and make the routes
   * indistinguishable — destroying the comparison this function exists to make.
   *
   * The credit is still reported, separately, and is rewarded through the
   * circularity component of `sustainabilityScore`.
   */
  const totalKg = transportKg + packagingKg + processingKg + dispositionKg;

  return {
    transportKg: r3(transportKg),
    packagingKg: r3(packagingKg),
    processingKg: r3(processingKg),
    dispositionKg: r3(dispositionKg),
    avoidedManufactureKg: r3(avoidedManufactureKg),
    totalKg: r3(Math.max(0, totalKg)),
  };
}

/**
 * The counterfactual: this same parcel, alone, on the fastest carrier, in a new
 * corrugated box, then landfilled. Stating it explicitly is what makes the
 * "CO2 prevented" figure defensible rather than marketing.
 */
export function computeBaseline(ctx: CaseContext, options: LogisticsOption[]): number {
  const f = ctx.sustainabilityFactors;
  const weightKg = ctx.product.dimensions.weightKg;

  // The baseline must be a route that was ACTUALLY AVAILABLE for this case.
  // Using the globally dirtiest carrier would inflate the saving with a carrier
  // that does not even serve the customer's region, which makes the number
  // indefensible the moment anyone checks it.
  const availableCarrierIds = new Set(options.map((o) => o.carrierId));
  const candidateCarriers = ctx.logisticsCatalog.carriers.filter((c) => availableCarrierIds.has(c.carrierId));

  // "Express single shipment": the fastest available option, moved alone (no
  // consolidation discount), in a new box, then landfilled.
  const fastest = [...options].sort((a, b) => a.totalDaysToResolution - b.totalDaysToResolution)[0];
  const expressCarrier =
    candidateCarriers.find((c) => c.carrierId === fastest?.carrierId) ??
    [...candidateCarriers].sort((a, b) => b.co2PerKgKm - a.co2PerKgKm)[0];

  const newBox = [...ctx.logisticsCatalog.packagingKits]
    .filter((k) => k.material === 'CORRUGATED_NEW' && k.maxWeightKg >= weightKg)
    .sort((a, b) => a.co2Kg - b.co2Kg)[0];

  const distanceKm = fastest?.distanceKm ?? 250;

  const transport = weightKg * distanceKm * (expressCarrier?.co2PerKgKm ?? f.defaultCo2PerKgKm);
  const packaging = newBox?.co2Kg ?? 0.4;
  const processing = f.processingCo2PerItemKg;
  const landfill = weightKg * f.landfillCo2PerKgKg;

  return r3(transport + packaging + processing + landfill);
}

/**
 * Picks the genuinely greenest option.
 *
 * Sorting by the rounded composite `sustainabilityScore` is NOT good enough:
 * options that differ by grams tie at integer resolution, making the winner
 * arbitrary. "Greenest" means lowest emissions, so rank by CO2 first, then
 * packaging waste, then cost as a final tiebreak.
 */
export function pickGreenest(scored: ScoredOption[]): ScoredOption {
  return [...scored].sort(
    (a, b) =>
      a.co2Kg - b.co2Kg ||
      a.packagingWasteGrams - b.packagingWasteGrams ||
      a.costDeltaUsd - b.costDeltaUsd ||
      b.sustainabilityScore - a.sustainabilityScore,
  )[0]!;
}

/* -------------------------------------------------------------------------- */
/* Scoring and grading                                                         */
/* -------------------------------------------------------------------------- */

export function scoreOption(
  ctx: CaseContext,
  option: LogisticsOption,
  disposition: DispositionPath,
  baselineKg: number,
  cheapestCostUsd: number,
  fastestDays: number,
): ScoredOption {
  const breakdown = computeBreakdown(ctx, option, disposition);
  const kit = ctx.logisticsCatalog.packagingKits.find((k) => k.kitId === option.packagingKitId);
  const wasteGrams = kit?.wasteGrams ?? 0;

  // CO2 sub-score: how far below the baseline this option lands.
  const co2Score = baselineKg > 0 ? Math.max(0, Math.min(100, ((baselineKg - breakdown.totalKg) / baselineKg) * 100)) : 50;
  // Packaging sub-score: 0g waste = 100, 500g+ = 0.
  const packagingScore = Math.max(0, Math.min(100, 100 - (wasteGrams / 500) * 100));
  const circularityScore = CIRCULARITY_SCORE[disposition];

  const sustainabilityScore = Math.round(
    co2Score * SCORE_WEIGHTS.co2 + packagingScore * SCORE_WEIGHTS.packaging + circularityScore * SCORE_WEIGHTS.circularity,
  );

  return {
    optionId: option.optionId,
    label: option.customerFacingLabel,
    co2Kg: breakdown.totalKg,
    packagingWasteGrams: wasteGrams,
    sustainabilityScore,
    isGreenest: false, // set by the caller once all options are scored
    breakdown,
    costDeltaUsd: r2(option.costUsd - cheapestCostUsd),
    transitDaysDelta: option.totalDaysToResolution - fastestDays,
  };
}

export function gradeFor(score: number, thresholds: { A: number; B: number; C: number; D: number }): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= thresholds.A) return 'A';
  if (score >= thresholds.B) return 'B';
  if (score >= thresholds.C) return 'C';
  if (score >= thresholds.D) return 'D';
  return 'F';
}

/**
 * Decides whether going green is worth it.
 * TODO(owner): move these thresholds into the factors fixture so the
 * sustainability lead can tune them without a code change.
 */
export const GREEN_ADOPTION_MAX_COST_DELTA_USD = 2.0;
export const GREEN_ADOPTION_MAX_DAYS_DELTA = 2;
/**
 * How much customer convenience (0-100) we are willing to give up before the
 * green option stops being something we impose and becomes something we OFFER.
 *
 * WHY THIS EXISTS: the greenest route is often a store drop-off, which moves
 * the effort onto the customer. Silently making someone drive to a shop to save
 * grams of CO2 — on a return that is our fault — contradicts the whole premise
 * that returns are a loyalty moment. Below this threshold we adopt green
 * automatically; above it, the customer decides and we sweeten it with an
 * incentive.
 */
export const GREEN_ADOPTION_MAX_CONVENIENCE_DROP = 15;

export function decideTradeoff(
  greenest: ScoredOption,
  provisional: ScoredOption | undefined,
  /** greenest.convenienceScore - provisional.convenienceScore (negative = worse). */
  convenienceDelta = 0,
): { verdict: 'ADOPT_GREEN' | 'KEEP_CURRENT' | 'OFFER_CUSTOMER_CHOICE'; reason: string; co2SavingKg: number; costDeltaUsd: number; transitDaysDelta: number } {
  if (!provisional || provisional.optionId === greenest.optionId) {
    return {
      verdict: 'KEEP_CURRENT',
      reason: 'The selected option is already the lowest-carbon path available.',
      co2SavingKg: 0,
      costDeltaUsd: 0,
      transitDaysDelta: 0,
    };
  }

  const co2SavingKg = r3(Math.max(0, provisional.co2Kg - greenest.co2Kg));
  const costDeltaUsd = r2(greenest.costDeltaUsd - provisional.costDeltaUsd);
  const daysDelta = greenest.transitDaysDelta - provisional.transitDaysDelta;

  // Never pay money or time for zero carbon benefit. The greenest-by-SCORE
  // option can tie on CO2 (it may win on packaging or circularity instead), and
  // switching in that case would be pure cost with no environmental return.
  if (co2SavingKg <= 0 && (costDeltaUsd > 0 || daysDelta > 0)) {
    return {
      verdict: 'KEEP_CURRENT',
      reason: `The greener-scoring option offers no measurable CO2 saving over the selected route, so switching would add ${costDeltaUsd > 0 ? `$${costDeltaUsd.toFixed(2)}` : 'delay'} for no environmental benefit.`,
      co2SavingKg: 0,
      costDeltaUsd,
      transitDaysDelta: daysDelta,
    };
  }

  // Materially less convenient for the customer -> offer, never impose.
  if (convenienceDelta < -GREEN_ADOPTION_MAX_CONVENIENCE_DROP) {
    return {
      verdict: 'OFFER_CUSTOMER_CHOICE',
      reason: `The greener option saves ${co2SavingKg}kg CO2 but is noticeably less convenient (${Math.abs(convenienceDelta)} points lower), so we offer it rather than impose it.`,
      co2SavingKg,
      costDeltaUsd,
      transitDaysDelta: daysDelta,
    };
  }

  if (costDeltaUsd <= GREEN_ADOPTION_MAX_COST_DELTA_USD && daysDelta <= GREEN_ADOPTION_MAX_DAYS_DELTA) {
    return {
      verdict: 'ADOPT_GREEN',
      reason: `Switching saves ${co2SavingKg}kg CO2 for ${costDeltaUsd <= 0 ? 'no extra cost' : `$${costDeltaUsd.toFixed(2)}`} and ${daysDelta <= 0 ? 'no added delay' : `${daysDelta} extra day(s)`}.`,
      co2SavingKg,
      costDeltaUsd,
      transitDaysDelta: daysDelta,
    };
  }

  if (daysDelta > GREEN_ADOPTION_MAX_DAYS_DELTA) {
    return {
      verdict: 'OFFER_CUSTOMER_CHOICE',
      reason: `The greener option saves ${co2SavingKg}kg CO2 but adds ${daysDelta} day(s) — let the customer decide.`,
      co2SavingKg,
      costDeltaUsd,
      transitDaysDelta: daysDelta,
    };
  }

  return {
    verdict: 'KEEP_CURRENT',
    reason: `The greener option costs $${costDeltaUsd.toFixed(2)} more for only ${co2SavingKg}kg CO2 saved, above our $${GREEN_ADOPTION_MAX_COST_DELTA_USD.toFixed(2)} threshold.`,
    co2SavingKg,
    costDeltaUsd,
    transitDaysDelta: daysDelta,
  };
}

/** Relatable equivalents for the customer-facing message. */
export function co2Equivalents(kg: number) {
  return {
    // ~0.17 kg CO2 per km for an average passenger car.
    carKmAvoided: r2(kg / 0.17),
    // A mature tree absorbs ~0.06 kg CO2/day.
    treeDaysOfAbsorption: r2(kg / 0.06),
    // ~0.008 kg CO2 per smartphone charge.
    smartphoneChargesEquivalent: Math.round(kg / 0.008),
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
