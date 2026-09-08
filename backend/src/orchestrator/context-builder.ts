/**
 * CONTEXT BUILDER — stage 0, owned by the orchestrator.
 *
 * Hydrates the frozen `CaseContext` that all seven agents share. Runs exactly
 * once per pipeline, does every lookup up front, and pre-resolves the policy
 * slice so no agent has to re-implement "find the rule that applies".
 *
 * The result is treated as immutable for the rest of the run.
 */
import { clock } from '../core/clock';
import { AppError } from '../core/errors';
import { db } from '../repositories/db';
import type { CaseContext, LogisticsCatalog, ResolvedPolicy } from '../domain/case-context.schema';
import type { Customer } from '../domain/customer.schema';
import type { Order, OrderItem } from '../domain/order.schema';
import type { ReturnIntent } from '../domain/return.schema';
import type { CategoryPolicy, ReasonPolicy, RegionalRule, TierBenefit } from '../domain/policy.schema';
import type { Inventory } from '../domain/product.schema';

export function buildContext(intent: ReturnIntent, customer: Customer, order: Order, orderItem: OrderItem): CaseContext {
  const product = db.products.get(orderItem.sku);
  if (!product) {
    // Data-integrity problem, not a customer error — surface it as unresolvable
    // rather than letting agents run against a phantom product.
    throw new AppError('ORDER_NOT_RESOLVED', `Product '${orderItem.sku}' is missing from the catalogue.`, {
      details: { sku: orderItem.sku, orderItemId: orderItem.orderItemId },
    });
  }

  const regionCode = order.shippingAddress.regionCode;

  return {
    now: clock.nowIso(),
    regionCode,
    customer,
    order,
    orderItem,
    product,
    inventory: resolveInventory(orderItem.sku),
    policy: resolvePolicy(intent, customer, product.category, regionCode, product.returnWindowDaysOverride),
    logisticsCatalog: buildLogisticsCatalog(order, regionCode),
    sustainabilityFactors: db.sustainabilityFactors,
    historicalAggregates: resolveAggregates(orderItem.sku, regionCode),
  };
}

/* -------------------------------------------------------------------------- */
/* Policy resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Picks the applicable category / tier / regional / reason rules and computes
 * the effective return window, keeping a derivation trail so the Eligibility
 * Agent can show its arithmetic.
 *
 * EFFECTIVE WINDOW = max(
 *   categoryWindow (or SKU override) + tierExtension + reasonExtension,
 *   statutoryWindow  (unless the category is statutorily exempt)
 * )
 */
function resolvePolicy(
  intent: ReturnIntent,
  customer: Customer,
  category: string,
  regionCode: string,
  skuWindowOverride: number | null,
): ResolvedPolicy {
  const p = db.policy;

  const categoryPolicy: CategoryPolicy =
    p.categories.find((c) => c.category === category) ??
    ({
      category: category as CategoryPolicy['category'],
      returnWindowDays: p.defaultReturnWindowDays,
      returnable: true,
      restockingFeePct: 0,
      requiresOriginalPackaging: false,
      requiresInspection: false,
      requiresProofOfDamage: false,
      nonReturnableReason: null,
    } satisfies CategoryPolicy);

  const tierBenefit: TierBenefit =
    p.tierBenefits.find((t) => t.tier === customer.loyaltyTier) ??
    ({ tier: customer.loyaltyTier, windowExtensionDays: 0, freeReturnShipping: false, restockingFeeWaived: false, goodwillBudgetUsd: 0, priorityHandling: false, pointsMultiplier: 1 } satisfies TierBenefit);

  const regionalRule: RegionalRule =
    p.regionalRules.find((r) => r.regionCode === regionCode) ??
    ({
      regionCode: regionCode as RegionalRule['regionCode'],
      regionName: regionCode,
      statutoryWindowDays: 0,
      statutoryReference: 'No statutory return right on record; store policy governs.',
      merchantPaysReturnShippingOnFault: true,
      restockingFeeProhibited: false,
      refundDeadlineDays: 14,
      exemptCategories: [],
      currency: 'USD',
    } satisfies RegionalRule);

  const reasonPolicy: ReasonPolicy =
    p.reasonPolicies.find((r) => r.reason === intent.reason) ??
    ({ reason: intent.reason, windowExtensionDays: 0, feesWaived: false, merchantPaysShipping: false, requiresEvidence: false, allowsInstantResolution: false } satisfies ReasonPolicy);

  /* --- window derivation --- */
  const baseDays = skuWindowOverride ?? categoryPolicy.returnWindowDays;
  const storeTotal = baseDays + tierBenefit.windowExtensionDays + reasonPolicy.windowExtensionDays;
  const statutoryApplies = !regionalRule.exemptCategories.includes(categoryPolicy.category);
  const statutoryDays = statutoryApplies ? regionalRule.statutoryWindowDays : 0;
  const effectiveReturnWindowDays = Math.max(storeTotal, statutoryDays);

  const windowDerivation = [
    { source: skuWindowOverride !== null ? `SKU override` : `${categoryPolicy.category} category policy`, days: baseDays, applied: true },
    { source: `${customer.loyaltyTier} tier extension`, days: tierBenefit.windowExtensionDays, applied: tierBenefit.windowExtensionDays > 0 },
    { source: `${intent.reason} reason extension`, days: reasonPolicy.windowExtensionDays, applied: reasonPolicy.windowExtensionDays > 0 },
    {
      source: `${regionalRule.regionName} statutory minimum`,
      days: statutoryDays,
      // Only "applied" when the statute actually beat store policy.
      applied: statutoryApplies && statutoryDays > storeTotal,
    },
  ];

  return {
    policyId: p.policyId,
    policyVersion: p.version,
    categoryPolicy,
    tierBenefit,
    regionalRule,
    reasonPolicy,
    thresholds: p.thresholds,
    effectiveReturnWindowDays,
    windowDerivation,
  };
}

/* -------------------------------------------------------------------------- */
/* Logistics catalogue                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Pre-filters carriers/facilities/drop-offs to the customer's region and sorts
 * by distance, so the Logistics Agent works from a small, relevant set.
 */
function buildLogisticsCatalog(order: Order, regionCode: string): LogisticsCatalog {
  const postalCode = order.shippingAddress.postalCode;
  const batchDate = db.consolidationSchedule[postalCode] ?? null;

  return {
    carriers: db.carriers.find((c) => c.servedRegions.includes(regionCode as never)),
    // Facility list starts with the order's origin — usually the nearest hub.
    facilities: db.facilities
      .all()
      .sort((a, b) =>
        a.facilityId === order.fulfillmentFacilityId ? -1 : b.facilityId === order.fulfillmentFacilityId ? 1 : 0,
      ),
    dropOffLocations: db.dropOffLocations
      .find((d) => d.address.postalCode === postalCode || d.address.city === order.shippingAddress.city)
      .sort((a, b) => a.distanceKm - b.distanceKm),
    packagingKits: db.packagingKits.all(),
    consolidationBatchAvailable: batchDate !== null,
    consolidationBatchDate: batchDate,
  };
}

/* -------------------------------------------------------------------------- */
/* Inventory and history                                                       */
/* -------------------------------------------------------------------------- */

function resolveInventory(sku: string): Inventory {
  return (
    db.inventory.get(sku) ?? {
      sku,
      availableUnits: 0,
      refurbishedUnits: 0,
      restockEtaDays: null,
      fulfillmentFacilityId: db.facilities.all()[0]?.facilityId ?? 'FAC-UNKNOWN',
    }
  );
}

/** Cold-start safe: returns zeros when a SKU has no history, which the Insights
 *  Agent detects and reports rather than guessing. */
function resolveAggregates(sku: string, regionCode: string): CaseContext['historicalAggregates'] {
  const agg = db.skuAggregates[sku];
  const regionRate = db.regionReturnRatePct[regionCode] ?? 0;

  if (!agg) {
    return {
      skuReturnsLast30Days: 0,
      skuDamagedOnArrivalLast30Days: 0,
      skuReturnRatePct: 0,
      categoryReturnRatePct: 0,
      regionReturnRatePct: regionRate,
      skuReturnsPrevious30Days: 0,
      totalReturnsLast30Days: 0,
    };
  }

  return { ...agg, regionReturnRatePct: regionRate };
}
