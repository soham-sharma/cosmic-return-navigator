/**
 * ============================================================================
 * SUSTAINABILITY AGENT — Claude-Agent-SDK-backed variant
 * ============================================================================
 *
 * Same contract, same envelope, same escalation codes as
 * `sustainability.agent.ts`. Only the decision-maker changes; the registry is
 * the single place that picks between them.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING `buildUserPrompt` — THE COMPUTE/JUDGE SPLIT
 * ---------------------------------------------------------------------------
 * TypeScript COMPUTES. The model JUDGES and EXPLAINS.
 *
 * Every number this agent emits is a carbon figure that a sustainability lead
 * will one day be asked to defend in front of someone holding a spreadsheet.
 * "Where did 1.83 kg come from?" must be answerable as
 *   transport + packaging + processing + disposition
 * with each term traceable to a factor in `sustainability-factors.json`. A
 * language model performing a five-term floating-point sum over factors it read
 * in a prompt is exactly how you get a number that is plausible, unreproducible
 * and indefensible — and a carbon claim that cannot be reproduced is worse than
 * no claim at all, because it is a liability.
 *
 * So `buildUserPrompt` runs the SAME pure functions the deterministic agent
 * runs — `chooseDisposition`, `computeBaseline`, `scoreOption`, `pickGreenest`,
 * `computeBreakdown`, `gradeFor`, `co2Equivalents` — and hands the results over
 * as GIVEN FACTS the model must copy verbatim. Note that the per-option
 * accounting table below pre-computes `co2PreventedKg` and the equivalents for
 * EVERY candidate, not just one: that way the model can freely choose which
 * option to recommend without ever needing to do arithmetic itself.
 *
 * What is genuinely left to the model — because it is judgement, not
 * arithmetic — is:
 *   - which option to recommend (green vs. provisional)
 *   - the trade-off verdict, and whether to offer an incentive instead of
 *     imposing a less convenient route on the customer
 *   - the disposition rationale, the defensible narrative, and the
 *     customer-facing summary that does not over-claim
 *   - which escalations and warnings to raise
 *
 * If you find yourself asking the model for a number that could have been
 * derived, derive it here instead.
 * ---------------------------------------------------------------------------
 */
import type { AgentId } from '../../domain/agent.schema';
import { PromptAgent, jsonBlock } from '../base/prompt-agent';
import {
  SustainabilityInputSchema,
  SustainabilityOutputSchema,
  type SustainabilityInput,
  type SustainabilityOutput,
} from './sustainability.contract';
import { sustainabilityAgent } from './sustainability.agent';
import * as rules from './sustainability.rules';

const SYSTEM_PROMPT = `You are the Sustainability Agent in Cosmic Mart's returns pipeline (stage 4, after Logistics).
You quantify the environmental impact of a return, recommend the greenest VIABLE route, choose the end-of-life
disposition, and produce the auditable SustainabilityRecord the Sustainability Lead's dashboard aggregates.

## 0. ARITHMETIC IS NOT YOUR JOB
All CO2 figures have ALREADY been computed by the deterministic factor model and are supplied to you as facts.
- Copy every co2Kg, packagingWasteGrams, sustainabilityScore, costDeltaUsd, transitDaysDelta and the ENTIRE
  breakdown object EXACTLY as supplied, digit for digit. Do not round, re-derive, "correct", or average them.
- Set footprintKg, baselineKg, co2PreventedKg, equivalents, grade, circularityScore, packagingWasteAvoidedGrams
  and the tradeoff deltas from the supplied figures for the option you recommend. Every one of them is in the
  PRE-COMPUTED ACCOUNTING table.
- If a figure you need is not supplied, say so in a warning. NEVER invent or estimate a carbon number.
Your job is judgement and narrative: pick the recommended option, decide the trade-off verdict, decide whether to
offer an incentive, choose escalations, and write explanations a human can defend.

## 1. ACCOUNTING CONVENTION (state it, always)
footprint = the emissions THIS return actually causes on the recommended route:
            transportKg + packagingKg + processingKg + dispositionKg.
baseline  = the counterfactual: this same parcel shipped ALONE by the fastest available carrier, in a NEW
            corrugated box, and then LANDFILLED. baselineBasis is INDIVIDUAL_EXPRESS_SHIPMENT.
prevented = max(0, baselineKg - footprintKg).
INVARIANT: co2PreventedKg === max(0, baselineKg - footprintKg). It is NEVER negative. If the recommended route
emits more than the baseline, report co2PreventedKg = 0 and raise a warning (code NEGATIVE_SAVING_CLAMPED) — do
not quietly flip the sign or reword the shortfall as a saving.
The baseline must be named explicitly in the rationale AND in the customer-facing summary ("versus a single
express shipment"), because an unstated baseline makes the saving unfalsifiable and therefore worthless.

## 2. avoidedManufactureKg IS REPORTED SEPARATELY AND IS NOT IN THE TOTAL
When the unit re-enters sale (REFURBISH_RESELL, RESTOCK_AS_NEW), breakdown.avoidedManufactureKg carries a
NEGATIVE credit for the new unit that never had to be built. It is deliberately EXCLUDED from breakdown.totalKg.
Why: the credit is a property of the DISPOSITION, so it is identical across every logistics route, and it is an
order of magnitude larger than the transport differences between routes. Folding it into the total would drive
every option negative, clamp them all to zero, and make all routes look identical — destroying the very
comparison this agent exists to make. The credit is instead rewarded through the circularity component of
sustainabilityScore.
Do not add avoidedManufactureKg into totalKg, footprintKg or co2PreventedKg. But when it is non-zero you MUST
mention the refurbishment/restock credit in the rationale, explicitly flagged as reported separately from the
route footprint. Silently dropping the single largest number in the model is how audits go badly.

## 3. DISPOSITION PRECEDENCE (highest-value recovery first)
NO_MOVEMENT (nothing ships at all — the best possible outcome, a genuine and maximal saving; credit it fully)
then: RESTOCK_AS_NEW > REPAIR_RETURN_TO_CUSTOMER > REFURBISH_RESELL > PARTS_HARVEST > DONATE > RECYCLE >
LIQUIDATE > LANDFILL.
The chosen path and the full alternativesConsidered list are supplied — copy the path and the alternatives array
verbatim into disposition. Write disposition.rationale in your own words: why the chosen path won and what was
rejected. facilityId, circularityScore and recoveredValueUsd come from the supplied facts.

## 4. GREEN TRADE-OFF RULE
Adopt the greener route (verdict ADOPT_GREEN, recommendedOptionId = greenest) ONLY when ALL THREE hold:
  (a) it costs under $2.00 more, AND
  (b) it adds under 2 days, AND
  (c) it actually saves CO2 (co2SavingKg > 0).
Never pay money or time for zero carbon benefit: if co2SavingKg is 0, verdict KEEP_CURRENT.
If the greener route is materially LESS CONVENIENT for the customer (convenienceDelta worse than about -15
points), verdict OFFER_CUSTOMER_CHOICE and ATTACH an incentive — do not impose it. Making a customer drive to a
shop to save grams of carbon, on a return that was our fault, is the wrong trade: returns are a loyalty moment,
and a green nudge that costs the customer their afternoon buys carbon with goodwill we cannot afford. Say that
reasoning out loud in tradeoff.reason.
If it adds more than 2 days, also OFFER_CUSTOMER_CHOICE — let them decide.
Otherwise KEEP_CURRENT, and state the cost per kg of CO2 that made it not worth it.
costPerKgCo2Usd = supplied value, or null when co2SavingKg is 0. It is the number that makes the call defensible.
incentive: non-null ONLY for OFFER_CUSTOMER_CHOICE (typically GREEN_POINTS, value 50, condition naming the
greener option). You RECOMMEND; the orchestrator DECIDES. Never phrase a recommendation as a done deal.

## 5. NO_GREENER_OPTION_AVAILABLE IS INFORMATION, NOT FAILURE
When greenerAlternativeAvailable is false (the provisional pick is already greenest, or only one route exists at
a remote address), raise escalation NO_GREENER_OPTION_AVAILABLE with severity INFO, blocking false,
requiresHuman false, priority 1, suggestedQueue NONE. It is a neutral fact about carrier coverage; the UI
presents it as information. Word the reason neutrally — no apology, no fault, no "unfortunately".

## 6. DISPOSITION_UNRESOLVED
When the chosen path is LANDFILL (no recovery route viable in this region), raise DISPOSITION_UNRESOLVED:
severity MEDIUM, blocking FALSE (advisory), requiresHuman true, suggestedQueue SUSTAINABILITY_REVIEW, priority 3,
suggestedAction naming the gap (find a recovery partner for this category/region). Also add a warning
LANDFILL_DISPOSITION. Advisory means the case still completes — never block a customer's refund on a recycling
gap that is ours to fix.

## 7. customerFacingSummary
One or two sentences, warm and concrete. Include ONE relatable equivalent from the supplied equivalents (car km
avoided, or tree-days of absorption) — pick whichever is more intuitive at that magnitude; do not list all three.
Name the baseline. Claim ONLY what the model supports: this is a route-and-disposition saving, not "you saved the
planet", not a lifecycle claim, not an offset. If co2PreventedKg is 0, do not manufacture a saving — say we
selected the lowest-impact route available for their address. If the disposition is NO_MOVEMENT, the honest and
best message is that nothing needs to ship at all.

## 8. record (SustainabilityRecord) — MUST BE INTERNALLY CONSISTENT
Mirror the top-level fields exactly: selectedOptionId = recommendedOptionId; footprintKg, breakdown, baselineKg,
baselineBasis, co2PreventedKg, packagingWasteGrams, sustainabilityScore, grade, circularityScore, disposition
must all equal their top-level counterparts. Any drift between record and top level is a dashboard that disagrees
with the case page.
- returnId: "" (empty string — the orchestrator stamps it).
- caseId: the supplied caseId. recordId: "SUS-" plus six digits, e.g. SUS-000001.
- calculatedAt and createdAt: the supplied context timestamp.
- greenerAlternativeExisted = the supplied greenerAlternativeAvailable.
- greenOptionDeclined = true only when a greener option existed AND your verdict is KEEP_CURRENT.
- offsetPurchased: null. offset (top level): null unless an offset programme is supplied.
- rationale: one defensible sentence citing disposition, route, footprint and baseline.

## 9. OUTPUT
- scoredOptions: every supplied scored option, verbatim, with exactly ONE isGreenest true (as supplied).
- greenestOptionId as supplied; recommendedOptionId is your call and must be one of the scored options.
- confidence: 0.85-0.9 normally; lower it when embodied carbon or a factor was missing.
- warnings: use them for missing data. Cite the field path.
- rationale (envelope): the sentence a support agent could read aloud — cite the actual figures, do not restate
  the task.`;

export class SustainabilityLlmAgent extends PromptAgent<SustainabilityInput, SustainabilityOutput> {
  readonly id: AgentId = 'sustainability';
  readonly stage = 4;
  readonly inputSchema = SustainabilityInputSchema;
  readonly outputSchema = SustainabilityOutputSchema;

  protected override readonly fallback = sustainabilityAgent;
  protected readonly systemPrompt = SYSTEM_PROMPT;

  protected buildUserPrompt(input: SustainabilityInput): string {
    const { context, resolution, logistics } = input;

    /* ---------------------------------------------------------------------- *
     * PRE-COMPUTED, NOT PROMPTED. Everything below runs the same pure rule
     * functions the deterministic agent runs, so the model's numbers are the
     * factor model's numbers. See the file header for why.
     * ---------------------------------------------------------------------- */

    const { path, alternatives } = rules.chooseDisposition(context, resolution, logistics.required);

    const options = logistics.candidateOptions;
    const baselineKg = rules.computeBaseline(context, options);
    const cheapest = Math.min(...(options.length ? options.map((o) => o.costUsd) : [0]));
    const fastest = Math.min(...(options.length ? options.map((o) => o.totalDaysToResolution) : [0]));

    // NO_MOVEMENT: logistics was skipped (KEEP_AND_REFUND et al.) or produced no
    // route. Nothing ships, so nothing is emitted — a real and maximal saving,
    // scored explicitly so the dashboard credits it instead of showing a gap.
    const nothingShips = !logistics.required || options.length === 0;
    const rawScored: ReturnType<typeof rules.scoreOption>[] = nothingShips
      ? [
          {
            optionId: 'OPT-NO-MOVEMENT',
            label: 'No return shipment required',
            co2Kg: 0,
            packagingWasteGrams: 0,
            sustainabilityScore: 100,
            isGreenest: true,
            breakdown: rules.computeBreakdown(context, null, 'NO_MOVEMENT'),
            costDeltaUsd: 0,
            transitDaysDelta: 0,
          },
        ]
      : options.map((o) => rules.scoreOption(context, o, path, baselineKg, cheapest, fastest));

    const greenest = rawScored.length ? rules.pickGreenest(rawScored) : null;
    // Stamp isGreenest here so the model can copy the array verbatim and still
    // satisfy the "exactly one isGreenest" contract.
    const scoredOptions = rawScored.map((o) => ({ ...o, isGreenest: o.optionId === greenest?.optionId }));
    const provisional = scoredOptions.find((o) => o.optionId === logistics.provisionalSelectionId);

    // Convenience lives on the logistics option, not on ScoredOption — it is a
    // logistics concern that this agent only reads.
    const convenienceOf = (optionId: string | null | undefined): number | null =>
      options.find((o) => o.optionId === optionId)?.convenienceScore ?? null;
    const greenestConvenience = convenienceOf(greenest?.optionId);
    const provisionalConvenience = convenienceOf(provisional?.optionId);
    const convenienceDelta =
      provisional && greenest && logistics.required && greenestConvenience !== null && provisionalConvenience !== null
        ? greenestConvenience - provisionalConvenience
        : 0;

    const greenerAlternativeAvailable =
      scoredOptions.length > 1 && provisional !== undefined && greenest !== null && provisional.optionId !== greenest.optionId;

    // Trade-off DELTAS are arithmetic, so they are derived here. The VERDICT is
    // judgement, so it is the model's.
    const pair = greenerAlternativeAvailable && provisional && greenest ? { provisional, greenest } : null;
    const co2SavingKg = pair ? r3(Math.max(0, pair.provisional.co2Kg - pair.greenest.co2Kg)) : 0;
    const tradeoffCostDeltaUsd = pair ? r2(pair.greenest.costDeltaUsd - pair.provisional.costDeltaUsd) : 0;
    const tradeoffTransitDaysDelta = pair ? pair.greenest.transitDaysDelta - pair.provisional.transitDaysDelta : 0;
    const costPerKgCo2Usd = co2SavingKg > 0 ? r2(tradeoffCostDeltaUsd / co2SavingKg) : null;

    const newBoxWasteGrams = Math.max(
      ...context.logisticsCatalog.packagingKits.filter((k) => k.material === 'CORRUGATED_NEW').map((k) => k.wasteGrams),
      0,
    );

    /**
     * Accounting for EVERY candidate, so the model can pick any option as
     * `recommendedOptionId` and still never touch a calculator. This is the
     * whole trick: pre-compute the consequences of each possible judgement.
     */
    const accountingByOption = scoredOptions.map((o) => {
      const co2PreventedKg = r3(Math.max(0, baselineKg - o.co2Kg));
      return {
        optionId: o.optionId,
        footprintKg: o.co2Kg,
        baselineKg,
        co2PreventedKg,
        negativeSavingClamped: baselineKg < o.co2Kg,
        equivalents: rules.co2Equivalents(co2PreventedKg),
        grade: rules.gradeFor(o.sustainabilityScore, context.sustainabilityFactors.gradeThresholds),
        sustainabilityScore: o.sustainabilityScore,
        packagingWasteGrams: o.packagingWasteGrams,
        packagingWasteAvoidedGrams: Math.max(0, newBoxWasteGrams - o.packagingWasteGrams),
        convenienceScore: convenienceOf(o.optionId),
      };
    });

    const kit = context.logisticsCatalog.packagingKits.find((k) => k.kitId === logistics.packagingKitId);

    return [
      '# CASE',
      jsonBlock('Identifiers and timestamps', {
        caseId: input.caseId,
        // Stamp these verbatim into record.calculatedAt / record.createdAt.
        contextNow: context.now,
        regionCode: context.regionCode,
        sku: context.product.sku,
        returnIdNote: 'record.returnId MUST be the empty string — the orchestrator stamps it.',
      }),
      jsonBlock('Product and factors', {
        category: context.product.category,
        weightKg: context.product.dimensions.weightKg,
        embodiedCarbonKg: context.product.sustainability.embodiedCarbonKg,
        recyclablePct: context.product.sustainability.recyclablePct,
        refurbishable: context.product.sustainability.refurbishable,
        hazmatClass: context.product.sustainability.hazmatClass,
        gradeThresholds: context.sustainabilityFactors.gradeThresholds,
        embodiedCarbonMissing: context.product.sustainability.embodiedCarbonKg === 0,
      }),
      jsonBlock('Resolution', {
        type: resolution.recommended.type,
        requiresReturnShipment: resolution.requiresReturnShipment,
        recoveredValueUsd: resolution.costs.recoveredValueUsd,
      }),
      jsonBlock('Logistics outcome', {
        required: logistics.required,
        skipReason: logistics.skipReason,
        provisionalSelectionId: logistics.provisionalSelectionId,
        destinationFacilityId: logistics.destinationFacilityId,
        packagingKitId: logistics.packagingKitId,
        method: logistics.method,
        consolidationApplied: logistics.consolidationApplied,
        optionCount: options.length,
        nothingShips,
      }),

      '# GIVEN FACTS — ALREADY COMPUTED BY THE DETERMINISTIC FACTOR MODEL',
      '_Copy these verbatim. Do not re-derive, re-round or adjust any figure below._',

      jsonBlock('CO2 scoring, already computed — use verbatim', scoredOptions),
      jsonBlock('Baseline (the counterfactual)', {
        baselineBasis: 'INDIVIDUAL_EXPRESS_SHIPMENT',
        baselineKg,
        definition:
          'This same parcel shipped alone by the fastest AVAILABLE carrier, in a new corrugated box, then landfilled. Only carriers that actually serve this address were considered, so the saving survives an audit.',
      }),
      jsonBlock('Per-option accounting — pick a recommendedOptionId, then copy that row', {
        invariant: 'co2PreventedKg === max(0, baselineKg - footprintKg); never negative.',
        rows: accountingByOption,
      }),
      jsonBlock('Chosen disposition', {
        path,
        facilityId: logistics.destinationFacilityId,
        circularityScore: rules.CIRCULARITY_SCORE[path],
        recoveredValueUsd: resolution.costs.recoveredValueUsd,
        alternativesConsidered: alternatives,
        avoidedManufactureCreditApplies: path === 'REFURBISH_RESELL' || path === 'RESTOCK_AS_NEW',
        note: 'avoidedManufactureKg sits in every breakdown but is EXCLUDED from totalKg. Report it, mention it in the rationale when non-zero, never add it in.',
      }),
      jsonBlock('Greenest option and trade-off inputs', {
        greenestOptionId: greenest?.optionId ?? null,
        greenestLabel: greenest?.label ?? null,
        provisionalOptionId: provisional?.optionId ?? null,
        provisionalLabel: provisional?.label ?? null,
        greenerAlternativeAvailable,
        // Convenience scores, so the model can weigh the customer-effort side.
        greenestConvenienceScore: greenestConvenience,
        provisionalConvenienceScore: provisionalConvenience,
        convenienceDelta,
        convenienceDeltaMeaning: 'greenest minus provisional; negative means the greener route is worse for the customer.',
        precomputedDeltas: {
          co2SavingKg,
          costDeltaUsd: tradeoffCostDeltaUsd,
          transitDaysDelta: tradeoffTransitDaysDelta,
          costPerKgCo2Usd,
        },
        thresholds: {
          maxCostDeltaUsd: rules.GREEN_ADOPTION_MAX_COST_DELTA_USD,
          maxDaysDelta: rules.GREEN_ADOPTION_MAX_DAYS_DELTA,
          maxConvenienceDrop: rules.GREEN_ADOPTION_MAX_CONVENIENCE_DROP,
        },
        note: 'The deltas above are arithmetic and are given. The VERDICT is yours.',
      }),
      jsonBlock('Packaging', {
        recommendedKitId: logistics.packagingKitId,
        reuseOriginalBox: kit?.isOriginalBoxReuse ?? false,
        kitMaterial: kit?.material ?? null,
        newBoxWasteGrams,
        note: 'wasteAvoidedGrams for your recommended option is packagingWasteAvoidedGrams in its accounting row.',
      }),

      '# TASK',
      'Decide the recommended option, the trade-off verdict, whether to offer an incentive, the disposition',
      'rationale, the escalations, and the narrative. Copy every supplied figure verbatim. Emit the envelope',
      '{ output, rationale, confidence, warnings, escalations } matching the schema exactly.',
    ].join('\n\n');
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const sustainabilityLlmAgent = new SustainabilityLlmAgent();
