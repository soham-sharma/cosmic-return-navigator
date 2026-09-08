/**
 * SUSTAINABILITY AGENT — implementation shell.
 * Contract, CO2 model and escalation matrix: sustainability.contract.ts
 */
import { newId } from '../../core/ids';
import { BaseAgent, escalate } from '../base/base-agent';
import type { AgentExecutionContext, AgentExecutionOutput, DraftEscalation } from '../base/agent.interface';
import type { AgentId } from '../../domain/agent.schema';
import type { ScoredOption, SustainabilityRecord } from '../../domain/sustainability.schema';
import {
  SustainabilityInputSchema,
  SustainabilityOutputSchema,
  type SustainabilityInput,
  type SustainabilityOutput,
} from './sustainability.contract';
import * as rules from './sustainability.rules';

export class SustainabilityAgent extends BaseAgent<SustainabilityInput, SustainabilityOutput> {
  readonly id: AgentId = 'sustainability';
  readonly stage = 4;
  readonly inputSchema = SustainabilityInputSchema;
  readonly outputSchema = SustainabilityOutputSchema;

  async execute(
    input: SustainabilityInput,
    ctx: AgentExecutionContext,
  ): Promise<AgentExecutionOutput<SustainabilityOutput>> {
    const { context, resolution, logistics } = input;
    const escalations: DraftEscalation[] = [];
    const warnings: AgentExecutionOutput<SustainabilityOutput>['warnings'] = [];

    if (context.product.sustainability.embodiedCarbonKg === 0) {
      warnings.push({
        code: 'MISSING_EMBODIED_CARBON',
        message: 'No embodied-carbon figure for this SKU; refurbishment credit could not be calculated.',
        field: 'context.product.sustainability.embodiedCarbonKg',
      });
    }

    /* -- disposition ------------------------------------------------------- */
    const { path, alternatives } = rules.chooseDisposition(context, resolution, logistics.required);
    if (path === 'LANDFILL') {
      warnings.push({ code: 'LANDFILL_DISPOSITION', message: 'No recovery path was viable; the unit is routed to landfill.', field: null });
      escalations.push(
        escalate('DISPOSITION_UNRESOLVED', {
          severity: 'MEDIUM',
          reason: 'No recycling, refurbishment or donation route is available for this item in this region.',
          blocking: false,
          requiresHuman: true,
          suggestedQueue: 'SUSTAINABILITY_REVIEW',
          priority: 3,
          suggestedAction: 'Identify a recovery partner for this category in this region.',
          context: { sku: context.product.sku, regionCode: context.regionCode },
        }),
      );
    }

    /* -- score every option ------------------------------------------------ */
    const options = logistics.candidateOptions;
    const baselineKg = rules.computeBaseline(context, options);
    const cheapest = Math.min(...(options.length ? options.map((o) => o.costUsd) : [0]));
    const fastest = Math.min(...(options.length ? options.map((o) => o.totalDaysToResolution) : [0]));

    let scoredOptions: ScoredOption[];
    if (!logistics.required || options.length === 0) {
      // NO_MOVEMENT is a real, and maximal, saving — score it explicitly so the
      // dashboard credits keep-and-refund resolutions properly.
      const breakdown = rules.computeBreakdown(context, null, 'NO_MOVEMENT');
      scoredOptions = [
        {
          optionId: 'OPT-NO-MOVEMENT',
          label: 'No return shipment required',
          co2Kg: 0,
          packagingWasteGrams: 0,
          sustainabilityScore: 100,
          isGreenest: true,
          breakdown,
          costDeltaUsd: 0,
          transitDaysDelta: 0,
        },
      ];
    } else {
      scoredOptions = options.map((o) => rules.scoreOption(context, o, path, baselineKg, cheapest, fastest));
    }

    /* -- identify the greenest and compare to the provisional pick --------- */
    const greenest = rules.pickGreenest(scoredOptions);
    scoredOptions = scoredOptions.map((o) => ({ ...o, isGreenest: o.optionId === greenest.optionId }));

    const provisional = scoredOptions.find((o) => o.optionId === logistics.provisionalSelectionId);

    // Convenience is not in ScoredOption (it is a logistics concern), so look it
    // up from the candidate options the Logistics Agent produced.
    const convenienceOf = (optionId: string | undefined): number =>
      options.find((o) => o.optionId === optionId)?.convenienceScore ?? 0;
    const convenienceDelta =
      provisional && logistics.required ? convenienceOf(greenest.optionId) - convenienceOf(provisional.optionId) : 0;

    const tradeoff = rules.decideTradeoff(greenest, provisional, convenienceDelta);
    const greenerAvailable = scoredOptions.length > 1 && provisional !== undefined && provisional.optionId !== greenest.optionId;

    if (!greenerAvailable) {
      escalations.push(
        escalate('NO_GREENER_OPTION_AVAILABLE', {
          severity: 'INFO',
          // Informational, NOT a failure — the UI must present it neutrally.
          reason:
            scoredOptions.length <= 1
              ? 'Only one return route is available at this address, so there is no greener alternative to offer.'
              : 'The selected route is already the lowest-carbon option available.',
          blocking: false,
          requiresHuman: false,
          priority: 1,
          context: { optionCount: scoredOptions.length },
        }),
      );
    }

    /* -- authoritative footprint of the recommended path ------------------- */
    const recommended = tradeoff.verdict === 'KEEP_CURRENT' && provisional ? provisional : greenest;
    const co2PreventedKg = Math.max(0, Math.round((baselineKg - recommended.co2Kg) * 1000) / 1000);
    if (baselineKg < recommended.co2Kg) {
      warnings.push({
        code: 'NEGATIVE_SAVING_CLAMPED',
        message: 'The selected route emits more than the stated baseline; the prevented figure was clamped to zero.',
        field: null,
      });
    }

    const grade = rules.gradeFor(recommended.sustainabilityScore, context.sustainabilityFactors.gradeThresholds);
    const kit = context.logisticsCatalog.packagingKits.find((k) => k.kitId === logistics.packagingKitId);
    const newBoxWaste = Math.max(
      ...context.logisticsCatalog.packagingKits.filter((k) => k.material === 'CORRUGATED_NEW').map((k) => k.wasteGrams),
      0,
    );

    const record: SustainabilityRecord = {
      recordId: newId('sustainability'),
      caseId: input.caseId,
      returnId: '', // stamped by the orchestrator
      sku: context.product.sku,
      selectedOptionId: recommended.optionId,
      disposition: path,
      footprintKg: recommended.co2Kg,
      breakdown: recommended.breakdown,
      baselineBasis: 'INDIVIDUAL_EXPRESS_SHIPMENT',
      baselineKg,
      co2PreventedKg,
      packagingWasteGrams: recommended.packagingWasteGrams,
      packagingWasteAvoidedGrams: Math.max(0, newBoxWaste - recommended.packagingWasteGrams),
      recoveredValueUsd: resolution.costs.recoveredValueUsd,
      circularityScore: rules.CIRCULARITY_SCORE[path],
      sustainabilityScore: recommended.sustainabilityScore,
      grade,
      greenerAlternativeExisted: greenerAvailable,
      greenOptionDeclined: tradeoff.verdict === 'KEEP_CURRENT' && greenerAvailable,
      offsetPurchased: null,
      rationale: `${path.replace(/_/g, ' ').toLowerCase()} disposition via ${recommended.label}. Footprint ${recommended.co2Kg}kg against a ${baselineKg}kg express-single-shipment baseline.`,
      confidence: 0.88,
      calculatedAt: context.now,
      createdAt: context.now,
    };

    const output: SustainabilityOutput = {
      scoredOptions,
      greenestOptionId: greenest.optionId,
      recommendedOptionId: recommended.optionId,
      greenerAlternativeAvailable: greenerAvailable,
      tradeoff: {
        verdict: tradeoff.verdict,
        costDeltaUsd: tradeoff.costDeltaUsd,
        transitDaysDelta: tradeoff.transitDaysDelta,
        co2SavingKg: tradeoff.co2SavingKg,
        costPerKgCo2Usd: tradeoff.co2SavingKg > 0 ? Math.round((tradeoff.costDeltaUsd / tradeoff.co2SavingKg) * 100) / 100 : null,
        reason: tradeoff.reason,
      },
      footprintKg: recommended.co2Kg,
      breakdown: recommended.breakdown,
      baselineBasis: 'INDIVIDUAL_EXPRESS_SHIPMENT',
      baselineKg,
      co2PreventedKg,
      equivalents: rules.co2Equivalents(co2PreventedKg),
      packagingWasteGrams: recommended.packagingWasteGrams,
      packaging: {
        recommendedKitId: logistics.packagingKitId,
        reuseOriginalBox: kit?.isOriginalBoxReuse ?? false,
        wasteAvoidedGrams: Math.max(0, newBoxWaste - recommended.packagingWasteGrams),
        instructions: kit?.isOriginalBoxReuse
          ? 'Reuse the box your order arrived in — no new packaging needed.'
          : kit?.material === 'NONE'
            ? 'No packaging needed: hand the item over as-is and staff will pack it in bulk.'
            : 'Use any suitable box; recycled material is preferred.',
      },
      disposition: {
        path,
        facilityId: logistics.destinationFacilityId,
        circularityScore: rules.CIRCULARITY_SCORE[path],
        recoveredValueUsd: resolution.costs.recoveredValueUsd,
        alternativesConsidered: alternatives,
        rationale: alternatives.find((a) => a.path === path)?.reason ?? 'Selected as the highest viable recovery path.',
      },
      sustainabilityScore: recommended.sustainabilityScore,
      grade,
      offset: null, // TODO(owner): wire the offset programme fixture
      incentive:
        tradeoff.verdict === 'OFFER_CUSTOMER_CHOICE'
          ? {
              type: 'GREEN_POINTS',
              value: 50,
              condition: `Choose ${greenest.label}`,
              customerFacingCopy: `Pick ${greenest.label} and we'll add 50 green points — it saves ${tradeoff.co2SavingKg}kg of CO2.`,
            }
          : null,
      record,
      customerFacingSummary:
        co2PreventedKg > 0
          ? `This return path saves ${co2PreventedKg}kg of CO2 — about ${rules.co2Equivalents(co2PreventedKg).carKmAvoided}km of driving — compared with a single express shipment.`
          : 'We have selected the lowest-impact return route available for your address.',
    };

    return {
      output,
      rationale: `${recommended.label} emits ${recommended.co2Kg}kg CO2 against a ${baselineKg}kg baseline, preventing ${co2PreventedKg}kg (grade ${grade}). Disposition: ${path.replace(/_/g, ' ').toLowerCase()}. ${tradeoff.reason}`,
      confidence: 0.88,
      warnings,
      escalations,
      inputsUsed: ['logistics.candidateOptions', 'logistics.provisionalSelectionId', 'resolution.recommended.type', 'context.sustainabilityFactors', 'context.product.sustainability'],
    };
  }
}

export const sustainabilityAgent = new SustainabilityAgent();
