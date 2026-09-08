/**
 * LOGISTICS AGENT — implementation shell.
 * Contract, 5-step decision logic and escalation matrix: logistics.contract.ts
 *
 * Remember: this agent proposes OPTIONS. The orchestrator makes the final
 * cost-vs-carbon call after the Sustainability Agent scores them.
 */
import { newId } from '../../core/ids';
import { isoInDays } from '../../core/clock';
import { BaseAgent, escalate } from '../base/base-agent';
import type { AgentExecutionContext, AgentExecutionOutput, DraftEscalation } from '../base/agent.interface';
import type { AgentId } from '../../domain/agent.schema';
import type { Shipment } from '../../domain/shipment.schema';
import {
  LogisticsInputSchema,
  LogisticsOutputSchema,
  type LogisticsInput,
  type LogisticsOutput,
} from './logistics.contract';
import * as rules from './logistics.rules';

export class LogisticsAgent extends BaseAgent<LogisticsInput, LogisticsOutput> {
  readonly id: AgentId = 'logistics';
  readonly stage = 3;
  readonly inputSchema = LogisticsInputSchema;
  readonly outputSchema = LogisticsOutputSchema;

  async execute(input: LogisticsInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<LogisticsOutput>> {
    const { context, resolution } = input;
    const escalations: DraftEscalation[] = [];
    const warnings: AgentExecutionOutput<LogisticsOutput>['warnings'] = [];

    /* -- gate: does anything need to move? -------------------------------- */
    if (!resolution.requiresReturnShipment) {
      const output: LogisticsOutput = {
        required: false,
        skipReason: `A ${resolution.recommended.type.replace(/_/g, ' ').toLowerCase()} needs no physical return.`,
        candidateOptions: [],
        provisionalSelectionId: null,
        finalSelectionId: null,
        selectionBasis: null,
        shipment: null,
        label: null,
        pickup: null,
        dropOffLocationId: null,
        trackingEvents: [],
        outboundShipment: null,
        method: 'NO_RETURN_REQUIRED',
        destinationFacilityId: null,
        packagingKitId: null,
        estimatedCostUsd: 0,
        estimatedTransitDays: 0,
        estimatedCo2Kg: 0,
        estimatedArrivalAt: null,
        convenienceScore: 100,
        carriersEvaluated: [],
        consolidationApplied: false,
        customerFacingSummary: 'No return shipment is needed — keep the item.',
      };
      return {
        output,
        status: 'COMPLETED',
        rationale: `No reverse logistics required: the chosen resolution (${resolution.recommended.type}) leaves the item with the customer. This is also the lowest-carbon outcome available.`,
        confidence: 1,
        inputsUsed: ['resolution.requiresReturnShipment'],
      };
    }

    /* -- STEP 1: filter carriers ------------------------------------------ */
    const verdicts = rules.filterCarriers(context);
    const eligibleIds = new Set(verdicts.filter((v) => v.eligible).map((v) => v.carrierId));
    const eligibleCarriers = context.logisticsCatalog.carriers.filter((c) => eligibleIds.has(c.carrierId));

    if (eligibleCarriers.length === 0) {
      const hazmat = context.product.sustainability.hazmatClass !== 'NONE';
      const oversized = context.logisticsCatalog.carriers.every((c) => context.product.dimensions.weightKg > c.maxWeightKg);
      escalations.push(
        escalate(oversized ? 'OVERSIZED_ITEM' : hazmat ? 'HAZMAT_RESTRICTED' : 'NO_CARRIER_COVERAGE', {
          severity: 'HIGH',
          reason: oversized
            ? 'This item is too large for our standard return carriers, so we will arrange a specialist collection.'
            : hazmat
              ? 'This item contains a battery and needs a ground-only carrier, which is not available at your address.'
              : 'No return carrier currently serves your address, so we will arrange collection manually.',
          blocking: true,
          requiresHuman: true,
          suggestedQueue: 'LOGISTICS_OPS',
          priority: 4,
          suggestedAction: 'Arrange a manual or white-glove collection and update the case.',
          context: { evaluated: verdicts, regionCode: context.regionCode, weightKg: context.product.dimensions.weightKg },
        }),
      );

      return {
        output: {
          required: true,
          skipReason: null,
          candidateOptions: [],
          provisionalSelectionId: null,
          finalSelectionId: null,
          selectionBasis: null,
          shipment: null,
          label: null,
          pickup: null,
          dropOffLocationId: null,
          trackingEvents: [],
          outboundShipment: null,
          method: null,
          destinationFacilityId: null,
          packagingKitId: null,
          estimatedCostUsd: 0,
          estimatedTransitDays: 0,
          estimatedCo2Kg: 0,
          estimatedArrivalAt: null,
          convenienceScore: null,
          carriersEvaluated: verdicts,
          consolidationApplied: false,
          customerFacingSummary: 'We need to arrange a special collection for this item and will confirm the details shortly.',
        },
        rationale: `No carrier can handle this return: ${verdicts.map((v) => `${v.carrierName} — ${v.reason}`).join('; ')}. Routed to logistics operations.`,
        confidence: 0.95,
        escalations,
        inputsUsed: ['context.logisticsCatalog.carriers', 'context.order.shippingAddress', 'context.product.dimensions'],
      };
    }

    /* -- STEP 2/3: build options ------------------------------------------ */
    const candidateOptions = rules.buildOptions(context, eligibleCarriers);
    if (candidateOptions.length === 0) {
      warnings.push({ code: 'NO_OPTIONS_BUILT', message: 'Carriers were eligible but no method produced a viable option.', field: null });
    }

    /* -- STEP 4: provisional selection ------------------------------------ */
    const { option: provisional, strategy, reason } = rules.selectProvisional(candidateOptions, context);

    if (!provisional) {
      escalations.push(
        escalate('PICKUP_UNAVAILABLE', {
          severity: 'MEDIUM',
          reason: 'We could not confirm a collection option automatically.',
          blocking: true,
          requiresHuman: true,
          suggestedQueue: 'LOGISTICS_OPS',
          priority: 3,
        }),
      );
    }

    /* -- STEP 5: materialize artifacts ------------------------------------ */
    let label = null;
    let pickup = null;
    let trackingEvents: LogisticsOutput['trackingEvents'] = [];
    let shipment: Shipment | null = null;
    let dropOffLocationId: string | null = null;

    if (provisional) {
      label = rules.generateLabel(context, provisional);
      pickup = provisional.method === 'HOME_PICKUP' ? rules.schedulePickup(context, provisional) : null;
      dropOffLocationId =
        provisional.method !== 'HOME_PICKUP'
          ? (context.logisticsCatalog.dropOffLocations.find(
              (d) => d.carrierId === provisional.carrierId && d.method === provisional.method,
            )?.locationId ?? null)
          : null;
      trackingEvents = rules.buildTrackingTimeline(context, provisional, pickup);

      shipment = {
        shipmentId: newId('shipment'),
        caseId: input.caseId,
        returnId: '', // stamped by the orchestrator once the Return record exists
        direction: 'INBOUND_RETURN',
        status: pickup ? 'PICKUP_SCHEDULED' : 'LABEL_CREATED',
        method: provisional.method,
        carrierId: provisional.carrierId,
        carrierName: provisional.carrierName,
        label,
        pickup,
        dropOffLocationId,
        originAddress: context.order.shippingAddress,
        destinationFacilityId: provisional.destinationFacilityId,
        packagingKitId: provisional.packagingKitId,
        weightKg: context.product.dimensions.weightKg,
        distanceKm: provisional.distanceKm,
        costUsd: provisional.costUsd,
        co2Kg: provisional.estimatedCo2Kg,
        trackingEvents,
        estimatedArrivalAt: isoInDays(provisional.totalDaysToResolution),
        exceptionCode: null,
        createdAt: context.now,
        updatedAt: context.now,
      };
    }

    /* -- outbound replacement leg ----------------------------------------- */
    // TODO(owner): build a real outbound shipment. Placeholder mirrors the
    // inbound carrier so the demo can show both legs.
    const outboundShipment: Shipment | null =
      resolution.requiresOutboundShipment && shipment
        ? { ...shipment, shipmentId: newId('shipment'), direction: 'OUTBOUND_REPLACEMENT', status: 'LABEL_CREATED', pickup: null, trackingEvents: [] }
        : null;

    /* -- non-blocking notices --------------------------------------------- */
    const hazmatDropped = verdicts.filter((v) => !v.eligible && /battery|hazmat/i.test(v.reason));
    if (hazmatDropped.length > 0) {
      escalations.push(
        escalate('HAZMAT_RESTRICTED', {
          severity: 'LOW',
          reason: 'This item contains a lithium battery, so we selected a ground-only carrier.',
          blocking: false,
          requiresHuman: false,
          priority: 2,
          context: { excludedCarriers: hazmatDropped.map((v) => v.carrierName) },
        }),
      );
    }

    const output: LogisticsOutput = {
      required: true,
      skipReason: null,
      candidateOptions,
      provisionalSelectionId: provisional?.optionId ?? null,
      finalSelectionId: null, // orchestrator writes this after conflict resolution
      selectionBasis: provisional
        ? {
            strategy,
            weights:
              strategy === 'MOST_CONVENIENT'
                ? { ...rules.MERCHANT_FAULT_WEIGHTS }
                : strategy === 'FASTEST'
                  ? { cost: 0.25, speed: 0.55, convenience: 0.2 }
                  : { ...rules.SELECTION_WEIGHTS },
            reason,
          }
        : null,
      shipment,
      label,
      pickup,
      dropOffLocationId,
      trackingEvents,
      outboundShipment,
      method: provisional?.method ?? null,
      destinationFacilityId: provisional?.destinationFacilityId ?? null,
      packagingKitId: provisional?.packagingKitId ?? null,
      estimatedCostUsd: provisional?.costUsd ?? 0,
      estimatedTransitDays: provisional?.totalDaysToResolution ?? 0,
      estimatedCo2Kg: provisional?.estimatedCo2Kg ?? 0,
      estimatedArrivalAt: provisional ? isoInDays(provisional.totalDaysToResolution) : null,
      convenienceScore: provisional?.convenienceScore ?? null,
      carriersEvaluated: verdicts,
      consolidationApplied: pickup?.isConsolidated ?? false,
      customerFacingSummary: provisional
        ? pickup
          ? `${provisional.carrierName} will collect the parcel on ${pickup.scheduledDate} between 09:00 and 13:00. Your label is ready — no printing needed.`
          : `Drop the parcel at ${provisional.customerFacingLabel}. Show the QR code; no printing needed.`
        : 'We are arranging your collection and will confirm shortly.',
    };

    return {
      output,
      rationale: provisional
        ? `Evaluated ${verdicts.length} carrier(s), ${eligibleCarriers.length} eligible, producing ${candidateOptions.length} viable option(s). Provisionally selected ${provisional.customerFacingLabel} at $${provisional.costUsd.toFixed(2)} and ${provisional.totalDaysToResolution} day(s). ${reason}`
        : 'Could not select a return option automatically; routed to logistics operations.',
      confidence: provisional ? 0.91 : 0.5,
      warnings,
      escalations,
      inputsUsed: ['resolution.requiresReturnShipment', 'context.logisticsCatalog', 'context.order.shippingAddress', 'context.product.dimensions'],
    };
  }
}

export const logisticsAgent = new LogisticsAgent();
