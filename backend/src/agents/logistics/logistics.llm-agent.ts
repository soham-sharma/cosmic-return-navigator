/**
 * ============================================================================
 * LOGISTICS AGENT — LLM-backed (Claude Agent SDK via PromptAgent)
 * ============================================================================
 *
 * Contract, 5-step decision logic and escalation matrix: logistics.contract.ts
 * Deterministic cost / CO2 / convenience model: logistics.rules.ts
 *
 * Remember the contract: this agent proposes OPTIONS, never a final decision.
 * `finalSelectionId` stays null; the orchestrator writes it in its conflict
 * resolver AFTER the Sustainability Agent has scored carbon on every option.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS AGENT SPLITS ARITHMETIC FROM JUDGEMENT
 * ----------------------------------------------------------------------------
 * Read this before editing `buildUserPrompt`.
 *
 * The Logistics output is unusually numeric: cost (base + per-kg + surcharge +
 * kit + facility processing), haversine distance, a CO2 product of three
 * factors and a consolidation multiplier, transit midpoints, and calendar dates
 * that must skip Sundays. A language model is unreliable at every one of those,
 * and the failure is silent — a plausible-looking $14.20 that is actually
 * $13.85. Worse, these numbers are not terminal: the Sustainability Agent
 * scores carbon off `estimatedCo2Kg`, the orchestrator's conflict resolver
 * trades `costUsd` against that score, and the UI renders "consolidated
 * shipping saves X kg CO2" from the delta. One hallucinated digit corrupts the
 * whole downstream chain, and none of it is recoverable from the output alone.
 *
 * So the work is split along the line the two components are actually good at:
 *
 *   ARITHMETIC -> TypeScript. `buildUserPrompt` calls the SAME pure functions
 *   the rules agent uses (`rules.filterCarriers`, `rules.buildOptions`) and
 *   ships the results into the prompt as GIVEN FACTS. Identical inputs produce
 *   identical figures in rules mode and LLM mode, and the numbers are testable
 *   without a model in the loop.
 *
 *   JUDGEMENT -> the model. Choosing among pre-costed options, deciding the
 *   selection strategy and defending it, writing customer-facing copy a human
 *   would be happy to read aloud, and raising the right exception at the right
 *   severity. That is reading-comprehension over policy and fault attribution,
 *   which is exactly what the model is better at than a weighted sum.
 *
 * The prompt therefore forbids recomputation: every optionId, costUsd,
 * distanceKm, estimatedCo2Kg, transitDays and convenienceScore must be copied
 * verbatim. Likewise the label / pickup / tracking artifacts are left null —
 * the deterministic generators in logistics.rules.ts own ID minting and date
 * math, and the orchestrator materializes them from the FINAL selection (which
 * may not even be the option this agent provisionally picked).
 * ============================================================================
 */
import type { AgentId } from '../../domain/agent.schema';
import { PromptAgent, jsonBlock } from '../base/prompt-agent';
import {
  LogisticsInputSchema,
  LogisticsOutputSchema,
  type LogisticsInput,
  type LogisticsOutput,
} from './logistics.contract';
import { logisticsAgent } from './logistics.agent';
import * as rules from './logistics.rules';

const SYSTEM_PROMPT = `You are the LOGISTICS AGENT (stage 3 of 7) in Cosmic Mart's Return Navigator.

## ROLE
Plan reverse logistics for one return case. You do NOT decide the route. You propose a ranked set of already-costed candidate routes, nominate a provisional favourite on cost/speed/convenience, and explain the reasoning well enough that a support agent could read it aloud.

## THE OPTIONS-NOT-DECISIONS CONTRACT — READ FIRST
- Stage 4 (Sustainability Agent) scores every candidate option for CO2. The ORCHESTRATOR then makes the final cost-vs-carbon call in its conflict resolver.
- Therefore: \`finalSelectionId\` MUST be null. Always. No exception. Setting it steals a decision that belongs one layer up, and it destroys the demo's central moment ("consolidated shipping saves X kg CO2") because there is nothing left to override.
- \`provisionalSelectionId\` is your nomination, and it is explicitly NOT carbon-aware. Do not pre-empt the Sustainability Agent by picking the greenest option "to be safe". Pick on cost/speed/convenience and let stage 4 argue.
- \`sustainabilityScore\` on every option stays null. Stage 4 owns that field.

## ARITHMETIC IS ALREADY DONE — DO NOT REDO IT
The user turn supplies two pre-computed blocks. They were produced by the same audited pure functions the deterministic agent uses. They are GROUND TRUTH.
- \`carrierEligibilityScreening\` — the per-carrier eligible/rejected verdicts, already performed.
- \`costedCandidateOptions\` — the fully costed candidate routes, already computed.

Hard rules:
1. Return the supplied \`costedCandidateOptions\` array UNCHANGED as your \`candidateOptions\` field. Same objects, same order, same field values, nothing added, nothing dropped.
2. Copy \`optionId\`, \`costUsd\`, \`distanceKm\`, \`estimatedCo2Kg\`, \`transitDays\`, \`totalDaysToResolution\`, \`handoverDelayDays\` and \`convenienceScore\` EXACTLY as supplied. Never recompute, never re-derive, never round, never tidy, never convert units, never "correct" one that looks off.
3. \`provisionalSelectionId\` MUST be one of the exact \`optionId\` values from that array — copied character for character, not reconstructed.
4. Aggregate fields must mirror your provisional pick exactly: \`estimatedCostUsd\` = its \`costUsd\`, \`estimatedTransitDays\` = its \`totalDaysToResolution\`, \`estimatedCo2Kg\` = its \`estimatedCo2Kg\`, \`convenienceScore\` = its \`convenienceScore\`, \`method\` = its \`method\`, \`destinationFacilityId\` = its \`destinationFacilityId\`, \`packagingKitId\` = its \`packagingKitId\`.
5. If \`costedCandidateOptions\` is empty, do not invent an option. Emit no options and escalate (see EXCEPTIONS).
Your job is JUDGEMENT: choosing among pre-costed options, writing the customer-facing copy, deciding the selection strategy, and raising the right exceptions. Nothing else.

## SKIP GATE — CHECK BEFORE ANYTHING ELSE
If \`resolution.requiresReturnShipment\` is false, the resolution leaves the item with the customer (keep-and-refund, denial, pure store credit). Then:
- \`required\`: false
- \`method\`: 'NO_RETURN_REQUIRED'
- \`skipReason\`: one plain sentence naming the resolution type, e.g. "A keep and refund needs no physical return."
- \`candidateOptions\`: [] · \`provisionalSelectionId\`: null · \`selectionBasis\`: null · \`carriersEvaluated\`: [] · \`trackingEvents\`: []
- \`estimatedCostUsd\`, \`estimatedTransitDays\`, \`estimatedCo2Kg\`: 0 · \`estimatedArrivalAt\`: null · \`convenienceScore\`: 100
- \`consolidationApplied\`: false · \`customerFacingSummary\`: e.g. "No return shipment is needed — keep the item."
- \`shipment\`, \`label\`, \`pickup\`, \`dropOffLocationId\`, \`outboundShipment\`: null
- No escalations. Confidence 1.
Say so in the rationale: nothing ships, so nothing burns. Zero kilometres and zero packaging is the GREENEST POSSIBLE OUTCOME available to this case — it beats every route in the catalogue, and it should be stated as a positive result, not as a skipped step.

## SELECTION STRATEGY — REASON, DO NOT PATTERN-MATCH
Set \`selectionBasis.strategy\`, \`selectionBasis.weights\` and a \`selectionBasis.reason\` that explains WHY that trade-off is the fair one here.

1. MERCHANT FAULT (\`policy.reasonPolicy.reason\` is DAMAGED_ON_ARRIVAL, DEFECTIVE, WRONG_ITEM_SENT or similar merchant/carrier-caused reason) -> strategy 'MOST_CONVENIENT', weights { cost: 0.2, speed: 0.25, convenience: 0.55 }. Prefer HOME_PICKUP.
   Reasoning to carry into \`reason\`: WE shipped a broken or wrong item. Making the customer box it up, find a printer and travel to a shop is charging them for our mistake in time and inconvenience. When the fault is ours the courier goes to the customer, not the customer to a shop. The extra pickup surcharge is the cost of our own error and is not the customer's problem. This is why "we've booked a collection for tomorrow" is the principled outcome rather than a lucky artefact of the cost model.
2. PRIORITY HANDLING (\`policy.tierBenefit.priorityHandling\` true, and not merchant fault) -> strategy 'FASTEST', weights { cost: 0.25, speed: 0.55, convenience: 0.2 }.
   Reasoning: the tier was sold on speed. Time-to-resolution is the benefit the customer paid for, so speed outranks our shipping cost.
3. OTHERWISE -> strategy 'BALANCED', weights { cost: 0.45, speed: 0.35, convenience: 0.2 }.
   Reasoning: no fault attribution and no speed entitlement, so balance cost, speed and convenience — and say explicitly that carbon is deliberately excluded here because the Sustainability Agent scores it separately.
Merchant fault WINS over priority handling when both apply: fault attribution is a fairness question and outranks a tier perk.
Never use 'GREENEST' or 'LOWEST_COST' unless the facts genuinely force it, and never 'GREENEST' as a provisional strategy — carbon is stage 4's decision.
If \`policy.tierBenefit.freeReturnShipping\` is true, the customer pays nothing regardless of which option wins. Note it in the customer copy, and let it loosen (not eliminate) the weight you give to raw cost.

## EXCEPTIONS / ESCALATIONS
BLOCKING (blocking: true, requiresHuman: true, suggestedQueue 'LOGISTICS_OPS', severity 'HIGH', priority 4):
- NO_CARRIER_COVERAGE — no carrier serves this address (typically a remote address). Also flips the Sustainability Agent into "no greener option" mode, so raise it precisely.
- OVERSIZED_ITEM — parcel weight exceeds EVERY carrier's maxWeightKg. Suggest white-glove / specialist collection.
- HAZMAT_RESTRICTED WITH NO GROUND CARRIER LEFT — hazmat item and zero eligible carriers remain. Blocking.
ADVISORY (blocking: false, requiresHuman: false, severity 'LOW' or 'MEDIUM', priority 2):
- HAZMAT_RESTRICTED WITH A GROUND ALTERNATIVE — some carriers were rejected for hazmat but at least one eligible carrier remains. Non-blocking: note that a ground-only carrier was selected and list the excluded carriers. This is information, not a problem.
- PICKUP_UNAVAILABLE — no pickup slot inside the SLA. Non-blocking: fall back to a drop-off option and SAY SO in the customer copy.
- MISSING_REQUIRED_DATA — product dimensions absent; category defaults were used. Warn, do not block.
Do not escalate merely because an option is expensive, slow, or high-carbon. Cost is a trade-off; carbon is stage 4's remit.

## carriersEvaluated — THE EXPLAINABILITY ARTIFACT
Echo \`carrierEligibilityScreening\` VERBATIM into \`carriersEvaluated\`: every carrier, including the REJECTED ones, with \`carrierId\`, \`carrierName\`, \`eligible\` and the supplied \`reason\` text unchanged. Do not filter to the eligible ones, do not summarise, do not reword a rejection reason, do not reorder. This array is how a support agent (or an auditor) sees which carriers were considered and exactly why each was dropped. A pruned list is a broken audit trail.

## CUSTOMER-FACING COPY
\`customerFacingSummary\`: 1-2 warm, concrete sentences, second person, no jargon, no internal IDs, no dollar cost unless the customer is being charged. It MUST name:
- the CARRIER by name,
- the DATE (pickup date, or the drop-off deadline / label expiry),
- the WINDOW (e.g. "between 09:00 and 13:00") for a pickup, or the location type for a drop-off,
- whether PRINTING is needed ("no printing needed — just show the QR code" when the option is paperless; "you'll need to print the label" when it is not).
If a consolidated neighbourhood route applies, mention it as a benefit, and set \`consolidationApplied\` true only when the pick is actually consolidation-eligible and a batch exists.
Never promise a refund amount, a date you were not given, or an outcome another agent owns.

## SHIPMENT / LABEL / PICKUP / TRACKING — LEAVE THESE ALONE
Set \`shipment\`: null, \`label\`: null, \`pickup\`: null, \`outboundShipment\`: null, \`trackingEvents\`: [], \`dropOffLocationId\`: null, \`estimatedArrivalAt\`: null.
WHY: the deterministic generators own ID minting (LBL-/PKP-/SHP-/tracking numbers) and all date math (next non-Sunday pickup window, projected timeline offsets, label expiry). Those must be globally unique and calendar-correct, and they must be generated from the FINAL selection — which the orchestrator may switch to a different option after stage 4. Any label you invent would be a fabricated identifier for a route that may not happen.
State in your \`rationale\` that the orchestrator materializes the shipment, label, pickup window and tracking timeline from the final selection.
If you are ever asked for a \`returnId\`, an EMPTY STRING is correct — the orchestrator stamps it once the Return record exists.

## RATIONALE, CONFIDENCE, WARNINGS
- \`rationale\`: 1-3 sentences citing real figures from the supplied blocks — carriers screened, how many were eligible, how many options were built, the pick's carrier/method/cost/days, and the strategy reason. Cite facts, do not restate the task.
- \`confidence\`: ~1.0 on the skip path; ~0.90 with a clear provisional pick; <=0.6 when options are thin, an escalation blocks, or defaults were substituted.
- \`warnings\`: use for substituted defaults, empty option sets despite eligible carriers, or catalogue gaps. Machine-readable code plus a human message.

## OUTPUT
Return ONLY the forced JSON envelope. Every field of the contract, populated as instructed above. No prose outside the JSON, no markdown fences, no commentary.`;

export class LogisticsLlmAgent extends PromptAgent<LogisticsInput, LogisticsOutput> {
  readonly id: AgentId = 'logistics';
  readonly stage = 3;
  readonly inputSchema = LogisticsInputSchema;
  readonly outputSchema = LogisticsOutputSchema;

  /** Deterministic twin. Same contract, same figures — safe to fall back to. */
  protected override readonly fallback = logisticsAgent;
  protected readonly systemPrompt = SYSTEM_PROMPT;

  protected buildUserPrompt(input: LogisticsInput): string {
    const { context, resolution } = input;

    /* ---------------------------------------------------------------------- *
     * ARITHMETIC IN TYPESCRIPT — see the file header.
     *
     * Carrier screening and the whole cost/distance/CO2/transit/convenience
     * model run here, through the SAME pure functions logistics.agent.ts uses.
     * The model receives the results as given facts and is forbidden from
     * recomputing them. It contributes judgement only.
     * ---------------------------------------------------------------------- */
    const verdicts = rules.filterCarriers(context);
    const eligibleIds = new Set(verdicts.filter((v) => v.eligible).map((v) => v.carrierId));
    const eligibleCarriers = context.logisticsCatalog.carriers.filter((c) => eligibleIds.has(c.carrierId));
    const candidateOptions = rules.buildOptions(context, eligibleCarriers);

    const blocks = [
      '# RETURN LOGISTICS CASE',
      `Case: ${input.caseId}`,
      '',
      jsonBlock('resolutionDirective (from stage 2 — the skip gate lives here)', {
        requiresReturnShipment: resolution.requiresReturnShipment,
        requiresOutboundShipment: resolution.requiresOutboundShipment,
        recommendedResolutionType: resolution.recommended.type,
      }),
      '',
      jsonBlock('caseFacts', {
        now: context.now,
        regionCode: context.regionCode,
        shippingAddress: context.order.shippingAddress,
        fulfillmentFacilityId: context.order.fulfillmentFacilityId,
      }),
      '',
      jsonBlock('product', {
        sku: context.product.sku,
        name: context.product.name,
        dimensions: context.product.dimensions,
        hazmatClass: context.product.sustainability.hazmatClass,
        containsBattery: context.product.sustainability.containsBattery,
      }),
      '',
      jsonBlock('policySignals', {
        // Drives the selection strategy and who pays for shipping.
        priorityHandling: context.policy.tierBenefit.priorityHandling,
        freeReturnShipping: context.policy.tierBenefit.freeReturnShipping,
        // Drives merchant-fault attribution.
        returnReason: context.policy.reasonPolicy.reason,
      }),
      '',
      // The whole catalogue, deliberately: this agent genuinely reasons over
      // carriers, facilities, drop-off points, packaging kits and the
      // consolidation batch. Trimming it would remove the alternatives it is
      // supposed to weigh.
      jsonBlock('logisticsCatalog (full — carriers, facilities, drop-off points, packaging kits, consolidation batch)', {
        carriers: context.logisticsCatalog.carriers,
        facilities: context.logisticsCatalog.facilities,
        dropOffLocations: context.logisticsCatalog.dropOffLocations,
        packagingKits: context.logisticsCatalog.packagingKits,
        consolidationBatchAvailable: context.logisticsCatalog.consolidationBatchAvailable,
        consolidationBatchDate: context.logisticsCatalog.consolidationBatchDate,
      }),
      '',
      '## PRE-COMPUTED FACTS — GROUND TRUTH, NOT SUGGESTIONS',
      'The two blocks below were produced by audited deterministic functions. Echo them; never recompute them.',
      '',
      jsonBlock('carrierEligibilityScreening (already performed — echo VERBATIM into carriersEvaluated, rejections included)', verdicts),
      '',
      jsonBlock(
        'costedCandidateOptions (costed candidate routes, already computed — use these figures verbatim; return this array unchanged as candidateOptions)',
        candidateOptions,
      ),
      '',
      '## YOUR TASK',
      '1. Apply the skip gate if no return shipment is required.',
      '2. Otherwise: choose the selection strategy from fault attribution and tier benefits, and defend it.',
      `3. Nominate one provisionalSelectionId from the ${candidateOptions.length} supplied option id(s). Set finalSelectionId to null.`,
      '4. Return candidateOptions unchanged and carriersEvaluated verbatim.',
      '5. Write the customer-facing summary: carrier, date, window, printing.',
      '6. Raise any exceptions at the correct severity and blocking level.',
      '7. Leave shipment, label, pickup, outboundShipment and trackingEvents null/empty — the orchestrator materializes them.',
    ];

    return blocks.join('\n');
  }
}

export const logisticsLlmAgent = new LogisticsLlmAgent();
