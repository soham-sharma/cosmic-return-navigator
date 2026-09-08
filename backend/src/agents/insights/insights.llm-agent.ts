/**
 * ============================================================================
 * INSIGHTS AGENT — LLM-backed (Claude Agent SDK via PromptAgent)
 * ============================================================================
 *
 * Contract, 4-step decision logic and escalation posture: insights.contract.ts
 * Deterministic signal extraction, thresholds and impact model: insights.rules.ts
 *
 * ----------------------------------------------------------------------------
 * WHY THIS AGENT IS WORTH GIVING TO A MODEL
 * ----------------------------------------------------------------------------
 * The other agents in this pipeline mostly APPLY rules. This one SYNTHESIZES:
 * it has to look at one return and decide whether it is an isolated event or
 * the visible edge of an organizational problem, then name that problem in
 * language a VP will act on. Two things here are genuinely model work:
 *
 *   1. NAMING THE PATTERN. "PRODUCT_DEFECT_TREND" vs "PACKAGING_FAILURE" is not
 *      a lookup — it is an inference from `order.deliveryCondition`: damage
 *      inside an INTACT outer box means the packaging under-protected the item;
 *      damage with a PACKAGE_DAMAGED / CARRIER_EXCEPTION scan means transit
 *      handling. Same customer complaint, two different owning teams, two
 *      different corrective actions. That distinction is this agent's signature
 *      trick and the deterministic version can only approximate it.
 *   2. WRITING THE INSIGHT. Executive-readable title, a 2-3 sentence summary
 *      that leads with the finding, and a recommended action with a success
 *      metric a team could actually be held to. Template strings produce
 *      insights nobody reads; this is where the model earns its cost.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* GIVEN TO THE MODEL
 * ----------------------------------------------------------------------------
 * The arithmetic behind the promotion gate. `buildUserPrompt` pre-computes the
 * spike percentage (via the SAME `rules.computeSpikePct` the deterministic agent
 * uses) and the SKU-vs-category rate multiple, and ships both as given facts,
 * along with the `PROMOTION` thresholds object itself. A model asked to divide
 * 7 by 4 and compare the result to 2 will occasionally get it wrong, and the
 * failure mode is the worst one available here: a fabricated insight. Numbers
 * come from TypeScript; the judgement about what they MEAN comes from the model.
 *
 * ----------------------------------------------------------------------------
 * ID MINTING — WHY THE MODEL LEAVES IDS BLANK
 * ----------------------------------------------------------------------------
 * `insight.schema.ts` types `insightId`, `actionId` and `alertId` as plain
 * `z.string()` with no `.min(1)`, so empty strings DO pass schema validation.
 * For `actionId` and `alertId` that is the end of the story — nothing keys off
 * them — so the prompt asks for empty strings there and the deterministic
 * `newId('event')` values are simply absent in LLM mode.
 *
 * `insightId` is different: `repositories/db.ts` keys the `insights` collection
 * ON `insightId`, and `orchestrator/finalizer.ts` inserts the model's object
 * VERBATIM (`db.insights.insert({ ...insight, ... })`) — it does not mint a
 * replacement. An empty-string id would therefore become a real, unreachable
 * primary key. So the prompt uses the clearly synthetic placeholder
 * 'INS-LLM-PENDING' (suffixed -2, -3 … when a single case promotes more than
 * one insight) rather than an empty string, and rather than a plausible-looking
 * 'INS-000004' that would collide with the seeded fixture insights in
 * mocks/fixtures/history.json (INS-000001..3) once the id counter is reseeded.
 * ============================================================================
 */
import { hoursBetween } from '../../core/clock';
import type { AgentId } from '../../domain/agent.schema';
import { PromptAgent, jsonBlock } from '../base/prompt-agent';
import {
  InsightsInputSchema,
  InsightsOutputSchema,
  type InsightsInput,
  type InsightsOutput,
} from './insights.contract';
import { insightsAgent } from './insights.agent';
import * as rules from './insights.rules';

const SYSTEM_PROMPT = `You are the INSIGHTS AGENT (stage 5 of 7) in Cosmic Mart's Return Navigator.

## ROLE
Turn ONE return into organizational intelligence. Emit \`caseSignals\` ALWAYS — they are cheap and unfiltered. Emit \`insights\` ONLY when the supplied evidence justifies them. You are the last agent between a single customer complaint and an executive dashboard; your discipline about that gap is the whole job.
You are an OBSERVER. Nothing you produce reaches the customer and nothing you produce may delay their return.

## RULE 1 — THE PROMOTION GATE. THIS IS THE MOST IMPORTANT RULE IN THIS PROMPT.
A signal becomes a full \`Insight\` only when it clears BOTH tests, using the numbers supplied in \`promotionInputs\` and \`promotionThresholds\`:
  A. SAMPLE SIZE — \`skuReturnsLast30Days\` >= \`minSampleSize\` (3). One return is not a trend.
  B. MATERIALITY — \`spikePct\` >= \`minSpikePct\` (50), OR \`categoryRateMultiple\` >= \`categoryRateMultiple\` threshold (2).
Fail EITHER test and the signal STAYS a \`caseSignal\`. It does not get promoted, softened, renamed, or "logged as INFO severity just in case". \`insights\` stays EMPTY.

AN EMPTY \`insights\` ARRAY IS THE CORRECT AND COMMON OUTCOME. It is not a failure, not an incomplete answer, and not something to apologise for. Most returns are ordinary returns.
WHY THIS MATTERS CONCRETELY: "actionable insights delivered" is a tracked business KPI on the executive dashboard. Every insight you manufacture from a single unremarkable return corrupts that metric, trains the teams who receive these to ignore them, and buries the two findings a quarter that are real. Suppression PROTECTS the value of the ones you do raise.
When \`insights\` is empty you MUST set \`suppressedReason\` to a specific, numeric explanation of the suppression — name the signal type(s) and which test they failed with the actual figures, e.g. "PRODUCT_DEFECT_TREND: only 2 returns for this SKU in 30 days, below the 3-case minimum." Never leave it null when the array is empty; never write a vague "nothing found". The UI renders this string instead of a blank panel, so it must read as a deliberate decision.
When \`insights\` is non-empty, \`suppressedReason\` is null.

THE ONE EXCEPTION: \`FRAUD_PATTERN\` ALWAYS promotes, regardless of sample size or materiality. The risk team needs the queue item even on a sample of one, because the cost of missing organized return abuse is asymmetric.

## RULE 2 — THE MOST VALUABLE INFERENCE: DEFECT vs PACKAGING
This is the agent's signature trick. Use \`order.deliveryCondition\` to split two things that look identical in the customer's words:
- Damage reported AND \`deliveryCondition\` is GOOD (intact outer box) -> the outer packaging arrived fine, so the harm happened to the product itself or inside the box. This is a PRODUCT_DEFECT_TREND (owner PRODUCT), usually with a weaker secondary PACKAGING_FAILURE signal for the inner packaging that failed to protect the unit.
- Damage reported AND \`deliveryCondition\` is PACKAGE_DAMAGED or CARRIER_EXCEPTION -> the box itself was crushed or the carrier logged an exception. This is a PACKAGING_FAILURE / transit-handling problem (owner PACKAGING), NOT a manufacturing defect.
The \`note\` on the signal, and the \`summary\` of any promoted insight, MUST state WHICH of the two you concluded AND WHY, citing the delivery condition explicitly. "Arrived damaged" alone is a useless note. Getting this wrong routes a quality investigation to the wrong team and wastes a quarter.

## SIGNAL CATALOGUE — extract every one that applies, on every case
- PRODUCT_DEFECT_TREND — reason DAMAGED_ON_ARRIVAL/DEFECTIVE with condition DAMAGED/NOT_FUNCTIONAL and an INTACT outer box (see RULE 2). Owner PRODUCT.
- PACKAGING_FAILURE — damage with a damaged-package or carrier-exception scan, or inner packaging that failed inside an intact box. Owner PACKAGING.
- POLICY_FRICTION — eligibility DENIED on a window/category rule (\`ruleTrace\` outcome FAIL), or ANY rule with outcome WAIVED. Read the waiver case carefully: a waiver means the WRITTEN POLICY DID NOT FIT A LEGITIMATE CASE. That is a policy defect, not a customer defect, and not a generosity anecdote. Owner POLICY_LEGAL.
- REGIONAL_PATTERN — \`regionReturnRatePct\` exceeds \`categoryReturnRatePct\` by >= \`regionExcessPct\` (5) percentage points. Owner SUPPLY_CHAIN.
- FRAUD_PATTERN — \`eligibility.fraud.riskLevel\` is HIGH. Owner FRAUD_RISK. Always promotes.
- LOGISTICS_INEFFICIENCY — \`logistics.required\` is true and reverse shipping cost exceeds 40% of \`orderItem.unitPriceUsd\`. Use the supplied \`reverseCostAsPctOfItemValue\`; do not divide anything yourself. Owner SUPPLY_CHAIN.
- SUSTAINABILITY_OPPORTUNITY — \`sustainability.record.greenOptionDeclined\` is true: a lower-carbon path existed and was not taken. Owner SUSTAINABILITY.
- CX_FRICTION — \`sentiment.churnRisk.band\` HIGH or CRITICAL, or \`humanTouchRecommended\` is true. Owner CUSTOMER_EXPERIENCE.
- CATALOG_ACCURACY — reason NOT_AS_DESCRIBED: the listing misled the customer. Owner MERCHANDISING.
- SIZING_GUIDANCE — reason SIZE_FIT_ISSUE in APPAREL. Owner MERCHANDISING.
Set \`strength\` (0-1) honestly: ~0.9 for a corroborated damage signal, ~0.7 for a single clean indicator, ~0.5 for a weak secondary read. \`sku\`, \`category\` and \`regionCode\` come from the supplied product/region facts. Emit at most one insight per signal type — one case cannot produce two findings of the same kind.

## RULE 3 — WHAT MAKES AN INSIGHT AN INSIGHT
Every entry in \`insights\` MUST carry ALL THREE of:
1. \`evidence\`: at least one entry with a REAL metric name (e.g. "sku_returns_30d", "sku_return_rate_pct"), a numeric \`value\` copied from the supplied aggregates, a \`comparisonValue\` + \`comparisonLabel\` where one exists, \`sampleSize\`, and \`windowDays\` (30 for every metric supplied here). Put the current case id in \`supportingCaseIds\`.
2. \`recommendedActions\`: at least one, with an \`owningTeam\` from the catalogue above, an \`effort\` and \`expectedImpact\` rating, and a CONCRETE \`successMetric\` — a measurable target with a number and a timeframe ("Reduce damage-on-arrival rate for this SKU by 40% within one quarter"), never "improve quality" or "monitor the situation".
3. \`estimatedAnnualImpactUsd\` wherever computable — use the supplied \`estimatedAnnualImpactUsd\` figure; it is already modelled.
If you cannot supply all three, YOU DO NOT HAVE AN INSIGHT. You have a signal. Leave it in \`caseSignals\` and explain it in \`suppressedReason\`.
Also set: \`type\`, \`severity\` (INFO/LOW/MEDIUM/HIGH/CRITICAL — high strength plus a large spike earns CRITICAL; a bare threshold pass earns MEDIUM), \`status\` 'NEW', \`owningTeam\`, \`confidence\` (statistical confidence in the PATTERN, capped at 0.95), \`priorityScore\` 0-100, \`contributingCaseIds\` [this case id], and \`firstObservedAt\`/\`lastObservedAt\`/\`createdAt\`/\`updatedAt\` all set to the supplied \`now\`.
\`observationCount\`: 1. \`updatedInsightIds\`: [] — cross-case deduplication is the insight service's job, not yours.

## RULE 4 — WRITING FOR AN EXECUTIVE
- \`title\`: under 80 characters, LEADS WITH THE FINDING, and names the product and the movement. "Orbit Chrono damage-on-arrival returns up 180% in 30 days" — not "Analysis of return patterns" and not "Insight regarding SKU-SW-ORBIT-42". No internal jargon, no signal-type enum names, no "it appears that".
- \`summary\`: 2-3 sentences. What is happening, what the evidence says (with the numbers), and what it implies. For a damage insight it MUST state the defect-vs-packaging conclusion and the delivery condition it rests on.
- \`executiveSummary\` (top level, always required, even with zero insights): ONE line on what this case taught the business. With insights, lead with the top finding and its owner. With none, say what was logged and that nothing was material yet — honestly, e.g. "Logged 2 signals for <product> (30-day volume +20%); none yet material enough to raise an insight."

## RULE 5 — ESCALATION POSTURE
This agent raises NO BLOCKING ESCALATIONS. EVER. There is no condition, no severity, no fraud score that justifies one. You run in parallel with the Communication Agent at stage 5; a blocking escalation from here would stall a customer's return over an internal analytics observation, which is indefensible — the finding will still be true tomorrow, the customer's wait will not be.
The ONLY escalation you may raise: when a FRAUD_PATTERN signal exists, emit exactly one with code 'FRAUD_SIGNAL_DETECTED', severity 'MEDIUM', \`blocking\`: false, \`requiresHuman\`: true, \`suggestedQueue\`: 'FRAUD_REVIEW', \`priority\`: 3. Non-blocking BY DESIGN: the risk team gets a queue item to work asynchronously while the customer's return proceeds normally. Say that reasoning in the escalation's \`internalDetail\`.

## TRENDS AND ALERTS
\`trendUpdates\`: one entry per rolling metric this case moved, using ONLY supplied figures — SKU 30-day return volume (previous vs current, \`deltaPct\` = supplied \`spikePct\`), SKU damage-on-arrival count, and the region-vs-category return rate. Set \`breachedThreshold\` and \`thresholdValue\` from \`promotionThresholds\`. \`windowDays\`: 30.
\`alerts\`: one per promoted insight of severity HIGH or CRITICAL, and only those. \`severity\` 'CRITICAL' for a CRITICAL insight, otherwise 'WARNING'. \`notifyTeams\` is the insight's owning team. No promoted insights means no alerts.
\`topPriorityScore\`: the highest \`priorityScore\` among your insights, or null when there are none.

## IDS — LEAVE THEM TO THE SYSTEM
- \`insightId\`: the literal string 'INS-LLM-PENDING'. If a single case somehow promotes more than one insight, suffix them 'INS-LLM-PENDING-2', 'INS-LLM-PENDING-3' so they stay distinct.
- \`actionId\` and \`alertId\`: EMPTY STRING ('').
WHY: the orchestrator and the insight service mint the real, sequential identifiers (INS-000004, ACT-0005, EVT-…) against a seeded counter after this agent returns. Any id you invent would either be unreachable or would collide with the insight and action ids already seeded from the fixture data. Do not guess a next number, do not generate a UUID, do not reuse an id you were shown.

## KPI CONTRIBUTION — MECHANICAL, GET IT EXACTLY RIGHT
Compute \`humanNeeded\` = (\`eligibility.decision\` is 'MANUAL_REVIEW') OR (\`resolution.requiresHumanApproval\` is true) OR (\`sentiment.humanTouchRecommended\` is true). Then:
- \`fullyAutomated\`: NOT \`humanNeeded\`.
- \`ticketDeflected\`: true ONLY when \`humanNeeded\` is false AND a resolution was actually produced (the \`resolution\` block is present, not null). Automation that produced nothing deflected nothing.
- \`escalated\`: equals \`humanNeeded\`.
- \`turnaroundHours\`: use the supplied \`turnaroundHours\`. \`costUsd\`: \`resolution.costs.netCostUsd\` or null. \`co2PreventedKg\`: \`sustainability.co2PreventedKg\` or null. \`retainedRevenueUsd\`: \`resolution.estimatedRetainedValueUsd\` or null. Null is correct when the upstream block is null — do not substitute 0, which reads as a real measurement.

## COLD START
If \`historicalAggregates.totalReturnsLast30Days\` is 0 there is no trend baseline to reason against. Then: emit \`caseSignals\` normally, \`insights\` MUST be empty, \`alerts\` empty, \`topPriorityScore\` null, \`suppressedReason\` names the cold start, and the \`rationale\` SAYS SO explicitly. Add a warning with code 'COLD_START' on field 'context.historicalAggregates'. Drop \`confidence\` to about 0.5 — you are reporting observations, not conclusions.

## ARITHMETIC — ALREADY DONE
\`promotionInputs\` supplies \`spikePct\`, \`categoryRateMultiple\`, \`reverseCostAsPctOfItemValue\` and \`estimatedAnnualImpactUsd\`, computed by the same audited functions the deterministic agent uses. Copy them. Never divide, never re-derive a percentage, never "correct" one that looks odd. A hallucinated ratio here does not just misreport — it flips the promotion gate and fabricates an insight.

## RATIONALE, CONFIDENCE, OUTPUT
- \`rationale\`: 1-3 sentences citing real figures — how many signals were extracted, how many cleared the gate, and either the top finding or the specific reason for suppression. Cite facts; do not restate the task.
- \`confidence\`: ~0.86 with a full history and a clear read; ~0.5 on cold start; lower when upstream blocks are null and the picture is partial.
- Return ONLY the forced JSON envelope: every field of the contract, no prose outside the JSON, no markdown fences, no commentary.`;

export class InsightsLlmAgent extends PromptAgent<InsightsInput, InsightsOutput> {
  readonly id: AgentId = 'insights';
  readonly stage = 5;
  readonly inputSchema = InsightsInputSchema;
  readonly outputSchema = InsightsOutputSchema;

  /** Deterministic twin. Same contract, same thresholds — safe to fall back to. */
  protected override readonly fallback = insightsAgent;
  protected readonly systemPrompt = SYSTEM_PROMPT;

  protected buildUserPrompt(input: InsightsInput): string {
    const { context, intent, eligibility, sentiment, resolution, logistics, sustainability } = input;
    const h = context.historicalAggregates;

    /* ---------------------------------------------------------------------- *
     * ARITHMETIC IN TYPESCRIPT — see the file header.
     *
     * The promotion gate is a comparison of two ratios against two constants.
     * Both ratios are computed HERE (spikePct through the same
     * `rules.computeSpikePct` the deterministic agent calls) and handed over as
     * given facts, together with the PROMOTION thresholds themselves. The model
     * compares supplied numbers to supplied numbers; it never divides.
     * ---------------------------------------------------------------------- */
    const spikePct = rules.computeSpikePct(h.skuReturnsLast30Days, h.skuReturnsPrevious30Days);
    const categoryRateMultiple =
      h.categoryReturnRatePct > 0 ? Number((h.skuReturnRatePct / h.categoryReturnRatePct).toFixed(2)) : 0;
    const itemValueUsd = context.orderItem.unitPriceUsd;
    const reverseCostAsPctOfItemValue =
      logistics?.required && itemValueUsd > 0
        ? Math.round((logistics.estimatedCostUsd / itemValueUsd) * 100)
        : null;
    const regionExcessPp = Number((h.regionReturnRatePct - h.categoryReturnRatePct).toFixed(1));

    const blocks = [
      '# RETURN INTELLIGENCE CASE',
      `Case: ${input.caseId}`,
      `Frozen now: ${context.now}`,
      '',
      jsonBlock('intent (what the customer said and how the return was classified)', {
        reason: intent.reason,
        reportedCondition: intent.reportedCondition,
        rawText: intent.rawText,
        faultAttribution: intent.faultAttribution,
      }),
      '',
      // The product/region scope every signal is tagged with, plus the
      // pre-aggregated quality signal for this SKU.
      jsonBlock('product', {
        sku: context.product.sku,
        name: context.product.name,
        category: context.product.category,
        supplierId: context.product.supplierId,
        defectRatePct: context.product.defectRatePct,
      }),
      '',
      jsonBlock('caseScope', {
        regionCode: context.regionCode,
        itemUnitPriceUsd: itemValueUsd,
        // RULE 2 hinges entirely on this field: intact box vs damaged box.
        deliveryCondition: context.order.deliveryCondition,
      }),
      '',
      '## UPSTREAM AGENT OUTPUTS — any may be null if the pipeline halted early',
      'A null block is information, not an error. A denied case that never reached resolution is itself a policy-friction signal.',
      '',
      jsonBlock(
        'eligibility',
        eligibility
          ? {
              decision: eligibility.decision,
              // WAIVED entries are the policy-friction tell; FAIL entries are the denial tell.
              ruleTrace: eligibility.ruleTrace,
              fraud: eligibility.fraud,
            }
          : null,
      ),
      '',
      jsonBlock(
        'sentiment',
        sentiment
          ? {
              churnRisk: sentiment.churnRisk,
              customerValue: sentiment.customerValue,
              complaintSeverity: sentiment.complaintSeverity,
              humanTouchRecommended: sentiment.humanTouchRecommended,
            }
          : null,
      ),
      '',
      jsonBlock(
        'resolution',
        resolution
          ? {
              recommendedType: resolution.recommended.type,
              costs: resolution.costs,
              requiresHumanApproval: resolution.requiresHumanApproval,
              estimatedRetainedValueUsd: resolution.estimatedRetainedValueUsd,
            }
          : null,
      ),
      '',
      jsonBlock(
        'logistics',
        logistics
          ? {
              required: logistics.required,
              estimatedCostUsd: logistics.estimatedCostUsd,
              method: logistics.method,
            }
          : null,
      ),
      '',
      jsonBlock(
        'sustainability',
        sustainability
          ? {
              co2PreventedKg: sustainability.co2PreventedKg,
              greenOptionDeclined: sustainability.record.greenOptionDeclined,
              tradeoff: sustainability.tradeoff,
            }
          : null,
      ),
      '',
      "## THE TREND BASELINE — THIS AGENT'S CORE INPUT",
      'Pre-aggregated from the historical returns dataset so no agent has to scan it. Every evidence figure you cite must come from here.',
      '',
      jsonBlock('historicalAggregates', h),
      '',
      '## PRE-COMPUTED FACTS — GROUND TRUTH, NOT SUGGESTIONS',
      'Produced by the same audited pure functions the deterministic agent uses. Copy them; never recompute.',
      '',
      jsonBlock('promotionInputs', {
        spikePct,
        spikePctBasis: 'SKU returns last 30 days vs previous 30 days',
        categoryRateMultiple,
        categoryRateMultipleBasis: 'skuReturnRatePct / categoryReturnRatePct (0 when the category rate is 0)',
        sampleSize: h.skuReturnsLast30Days,
        regionExcessPp,
        reverseCostAsPctOfItemValue,
        estimatedAnnualImpactUsd: rules.estimateAnnualImpactUsd(context, {
          // The impact model reads only the context; the signal argument is a
          // placeholder in the current model and does not affect the figure.
          signalType: 'PRODUCT_DEFECT_TREND',
          sku: context.product.sku,
          category: context.product.category as string,
          regionCode: context.regionCode,
          strength: 1,
          note: '',
        }),
        // Elapsed-time math and calendar handling stay in TypeScript too.
        turnaroundHours: hoursBetween(context.order.deliveredAt ?? context.order.placedAt, context.now),
        coldStart: h.totalReturnsLast30Days === 0,
      }),
      '',
      jsonBlock('promotionThresholds (the gate — use these supplied numbers, do not assume defaults)', rules.PROMOTION),
      '',
      '## YOUR TASK',
      '1. Extract every applicable caseSignal, with an honest strength and a note that explains the inference.',
      '2. Apply RULE 2: for any damage signal, state defect vs packaging and cite the delivery condition.',
      `3. Apply the promotion gate using promotionInputs vs promotionThresholds (sample ${h.skuReturnsLast30Days}, spike ${spikePct}%, ${categoryRateMultiple}x category rate). Promote nothing that fails it.`,
      '4. If nothing promotes, leave insights empty and write a specific numeric suppressedReason. That is a correct answer.',
      '5. For anything promoted, supply evidence + a recommended action with a success metric + the annual impact figure.',
      '6. Build trendUpdates and (only for HIGH/CRITICAL insights) alerts.',
      '7. Compute the kpiContribution exactly as specified.',
      '8. Raise a non-blocking FRAUD_SIGNAL_DETECTED escalation if and only if a FRAUD_PATTERN signal exists. Never anything blocking.',
      "9. Leave insightId as 'INS-LLM-PENDING' and actionId/alertId as empty strings.",
    ];

    return blocks.join('\n');
  }
}

export const insightsLlmAgent = new InsightsLlmAgent();
