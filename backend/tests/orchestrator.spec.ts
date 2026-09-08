/**
 * ORCHESTRATION TESTS — the wireframe's guard rails.
 *
 * These assert the CONTRACT, not the tuning. They should keep passing as each
 * owner replaces their rule stubs with real logic; if one starts failing, either
 * the logic broke a contract or the contract genuinely changed (in which case
 * update the test and the contract doc together).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runPipeline } from '../src/orchestrator/orchestrator';
import { parseIntent } from '../src/orchestrator/intent-parser';
import { PIPELINE, TOTAL_STAGES } from '../src/orchestrator/pipeline.config';
import { AGENT_IDS, TERMINAL_AGENT_STATUSES } from '../src/domain/agent.schema';
import { ReturnCaseSchema } from '../src/domain/case-state.schema';
import { db, resetDb } from '../src/repositories/db';
import { resetStore } from '../src/orchestrator/state-store';

const PRIMARY = {
  text: "I bought a smartwatch 20 days ago. It arrived damaged and I'd like a return.",
  customerId: 'CUST-001001',
  orderId: 'ORD-088213',
  orderItemId: 'ORD-088213-I1',
};

beforeEach(() => {
  resetDb();
  resetStore();
});

/* ========================================================================== */
describe('fixtures', () => {
  it('load and validate at boot', () => {
    expect(db.customers.count()).toBeGreaterThan(0);
    expect(db.orders.count()).toBeGreaterThan(0);
    expect(db.products.count()).toBeGreaterThan(0);
    expect(db.scenarios.count()).toBe(7);
  });

  it('every scenario points at a real customer, order and order item', () => {
    for (const s of db.scenarios.all()) {
      const order = db.orders.get(s.orderId);
      expect(order, `${s.scenarioId}: order ${s.orderId}`).toBeDefined();
      expect(db.customers.get(s.customerId), `${s.scenarioId}: customer`).toBeDefined();
      expect(order!.customerId).toBe(s.customerId);
      expect(order!.items.some((i) => i.orderItemId === s.orderItemId), `${s.scenarioId}: item`).toBe(true);
    }
  });

  it('every order item references a product in the catalogue', () => {
    for (const order of db.orders.all()) {
      for (const item of order.items) {
        expect(db.products.get(item.sku), `${order.orderId} -> ${item.sku}`).toBeDefined();
      }
    }
  });

  it('every product category has a policy entry', () => {
    const covered = new Set(db.policy.categories.map((c) => c.category));
    for (const p of db.products.all()) {
      expect(covered.has(p.category), `category ${p.category}`).toBe(true);
    }
  });
});

/* ========================================================================== */
describe('intent parser', () => {
  it('extracts reason, product and relative purchase age from the demo phrasing', () => {
    const { intent } = parseIntent(PRIMARY.text, { customerId: PRIMARY.customerId });

    expect(intent.reason).toBe('DAMAGED_ON_ARRIVAL');
    expect(intent.faultAttribution).toBe('MERCHANT');
    expect(intent.productMention).toBe('smartwatch');
    expect(intent.purchaseAgeDaysStated).toBe(20);
    expect(intent.parseConfidence).toBeGreaterThanOrEqual(0.5);
  });

  it('resolves the order whose age best matches the stated phrase', () => {
    const { order, orderItem } = parseIntent(PRIMARY.text, { customerId: PRIMARY.customerId });
    expect(order?.orderId).toBe('ORD-088213');
    expect(orderItem?.sku).toBe('SKU-SW-ORBIT-42');
  });

  it('flags low confidence and missing fields for unusable input', () => {
    const { intent } = parseIntent('hello there');
    expect(intent.parseConfidence).toBeLessThan(0.5);
    expect(intent.missingFields).toContain('reason');
  });

  it('distinguishes change-of-mind from damage', () => {
    const { intent } = parseIntent("I've changed my mind about the t-shirts", { customerId: 'CUST-001002' });
    expect(intent.reason).toBe('CHANGE_OF_MIND');
    expect(intent.faultAttribution).toBe('CUSTOMER');
  });
});

/* ========================================================================== */
describe('pipeline configuration', () => {
  it('covers all seven agents exactly once', () => {
    const configured = PIPELINE.flatMap((s) => s.agents);
    expect(configured.sort()).toEqual([...AGENT_IDS].sort());
    expect(new Set(configured).size).toBe(AGENT_IDS.length);
  });

  it('has stage 1 and stage 5 parallel, the rest sequential', () => {
    const parallel = PIPELINE.filter((s) => s.mode === 'PARALLEL').map((s) => s.stage);
    expect(parallel).toEqual([1, 5]);
  });

  it('never places an agent before its dependency', () => {
    const stageOf = (id: string) => PIPELINE.find((s) => s.agents.includes(id as never))!.stage;

    // Declared dependency graph from the agent contracts.
    const deps: Record<string, string[]> = {
      eligibility: [],
      sentiment: [],
      resolution: ['eligibility', 'sentiment'],
      logistics: ['resolution'],
      sustainability: ['resolution', 'logistics'],
      communication: ['eligibility', 'sentiment'],
      insights: [],
    };

    for (const [agent, requires] of Object.entries(deps)) {
      for (const dep of requires) {
        expect(stageOf(dep), `${agent} depends on ${dep}`).toBeLessThan(stageOf(agent));
      }
    }
  });
});

/* ========================================================================== */
describe('primary demo scenario — damaged smartwatch', () => {
  it('completes the full pipeline without human intervention', async () => {
    const result = await runPipeline(PRIMARY.text, PRIMARY);

    expect(result.status).toBe('COMPLETED');
    expect(result.currentStage).toBe(TOTAL_STAGES);
    expect(result.finalOutcome).not.toBeNull();
    expect(result.finalOutcome!.fullyAutomated).toBe(true);
  });

  it('runs all seven agents to a terminal status', async () => {
    const result = await runPipeline(PRIMARY.text, PRIMARY);

    for (const agentId of AGENT_IDS) {
      const run = result.agentResults[agentId];
      expect(run, `${agentId} did not run`).toBeDefined();
      expect(TERMINAL_AGENT_STATUSES).toContain(run!.status);
    }
    expect(result.agentRuns).toHaveLength(AGENT_IDS.length);
  });

  it('produces the PRD outcome: replacement + 500 points + next-day pickup', async () => {
    const { finalOutcome } = await runPipeline(PRIMARY.text, PRIMARY);

    expect(finalOutcome!.resolutionType).toBe('REPLACEMENT');
    expect(finalOutcome!.pointsAwarded).toBe(500);
    // Home pickup must survive the green override: the greenest route is a
    // store drop-off, but imposing that on a customer whose item arrived
    // damaged is the wrong trade. See GREEN_ADOPTION_MAX_CONVENIENCE_DROP.
    expect(finalOutcome!.returnMethod).toBe('HOME_PICKUP');
    expect(finalOutcome!.pickupScheduledFor).not.toBeNull();
    expect(finalOutcome!.trackingNumber).not.toBeNull();
  });

  it('offers the greener route instead of imposing a less convenient one', async () => {
    const { agentResults } = await runPipeline(PRIMARY.text, PRIMARY);
    const s = agentResults.sustainability!.output!;

    expect(s.tradeoff.verdict).toBe('OFFER_CUSTOMER_CHOICE');
    // An offer must come with something the customer can act on.
    expect(s.incentive).not.toBeNull();
    expect(s.incentive!.customerFacingCopy.length).toBeGreaterThan(10);
  });

  it("the customer message names the resolution, the pickup and the goodwill", async () => {
    const { finalOutcome } = await runPipeline(PRIMARY.text, PRIMARY);
    const message = finalOutcome!.customerMessage;

    expect(message).toMatch(/replacement/i);
    expect(message).toMatch(/pickup/i);
    expect(message).toMatch(/500 Cosmic Rewards points/i);
    // No unrendered template placeholders may ever reach a customer.
    expect(message).not.toMatch(/\{\{/);
  });

  it('approves within the window because damage extends it', async () => {
    const { agentResults } = await runPipeline(PRIMARY.text, PRIMARY);
    const eligibility = agentResults.eligibility!.output!;

    expect(eligibility.decision).toMatch(/^APPROVED/);
    expect(eligibility.window.withinWindow).toBe(true);
    // Delivered 2026-08-22T16:45Z, frozen now 2026-09-08T10:15Z = 16 whole days.
    expect(eligibility.window.daysElapsed).toBe(16);
    // 30 base (wearables) + 15 GOLD tier + 15 damage extension.
    expect(eligibility.window.effectiveWindowDays).toBe(60);
    expect(eligibility.restockingFeeUsd).toBe(0); // waived on merchant fault
  });

  it('reads the customer as negative and high-value, and funds a gesture', async () => {
    const { agentResults } = await runPipeline(PRIMARY.text, PRIMARY);
    const sentiment = agentResults.sentiment!.output!;

    expect(sentiment.sentiment.score).toBeLessThan(0);
    expect(sentiment.customerValue.loyaltyTier).toBe('GOLD');
    expect(sentiment.retention.warranted).toBe(true);
    expect(sentiment.retention.maxGoodwillBudgetUsd).toBeGreaterThan(0);
  });

  it('reports a defensible CO2 saving against a stated baseline', async () => {
    const { agentResults } = await runPipeline(PRIMARY.text, PRIMARY);
    const s = agentResults.sustainability!.output!;

    expect(s.baselineBasis).toBe('INDIVIDUAL_EXPRESS_SHIPMENT');
    expect(s.baselineKg).toBeGreaterThan(0);
    expect(s.co2PreventedKg).toBe(Math.max(0, Math.round((s.baselineKg - s.footprintKg) * 1000) / 1000));
    // Never a negative saving.
    expect(s.co2PreventedKg).toBeGreaterThanOrEqual(0);
  });

  it('discriminates between logistics options rather than scoring them all alike', async () => {
    const { agentResults } = await runPipeline(PRIMARY.text, PRIMARY);
    const scored = agentResults.sustainability!.output!.scoredOptions;

    expect(scored.length).toBeGreaterThan(1);
    // Exactly one option is flagged greenest.
    expect(scored.filter((o) => o.isGreenest)).toHaveLength(1);
    // The footprints must not all collapse to an identical value — that would
    // mean the CO2 model cannot tell the routes apart.
    expect(new Set(scored.map((o) => o.co2Kg)).size).toBeGreaterThan(1);
  });

  it('excludes air carriers because the watch has a lithium battery', async () => {
    const { agentResults } = await runPipeline(PRIMARY.text, PRIMARY);
    const evaluated = agentResults.logistics!.output!.carriersEvaluated;

    const nova = evaluated.find((c) => c.carrierId === 'CARR-NOVA');
    expect(nova?.eligible).toBe(false);
    expect(nova?.reason).toMatch(/lithium/i);
  });

  it('records every agent rationale for the explainability panel', async () => {
    const { finalOutcome } = await runPipeline(PRIMARY.text, PRIMARY);

    expect(finalOutcome!.agentRationales).toHaveLength(AGENT_IDS.length);
    for (const { rationale } of finalOutcome!.agentRationales) {
      expect(rationale.length).toBeGreaterThan(10);
    }
  });

  it('is deterministic — the same input twice yields the same outcome', async () => {
    const a = await runPipeline(PRIMARY.text, PRIMARY);
    const b = await runPipeline(PRIMARY.text, PRIMARY);

    expect(b.finalOutcome!.resolutionType).toBe(a.finalOutcome!.resolutionType);
    expect(b.finalOutcome!.pointsAwarded).toBe(a.finalOutcome!.pointsAwarded);
    expect(b.finalOutcome!.co2PreventedKg).toBe(a.finalOutcome!.co2PreventedKg);
    expect(b.agentResults.eligibility!.output!.decision).toBe(a.agentResults.eligibility!.output!.decision);
  });

  it('conforms to the ReturnCase schema', async () => {
    const result = await runPipeline(PRIMARY.text, PRIMARY);
    const parsed = ReturnCaseSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(`ReturnCase failed validation: ${JSON.stringify(parsed.error.issues.slice(0, 5), null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it('persists the business records the agents described', async () => {
    const result = await runPipeline(PRIMARY.text, PRIMARY);

    expect(result.returnId).not.toBeNull();
    expect(result.resolutionId).not.toBeNull();
    expect(result.shipmentId).not.toBeNull();
    expect(result.sustainabilityRecordId).not.toBeNull();
    expect(result.notificationIds.length).toBeGreaterThan(0);

    expect(db.returns.get(result.returnId!)).toBeDefined();
    // Cross-links must be stamped, not left blank.
    expect(db.shipments.get(result.shipmentId!)!.returnId).toBe(result.returnId);
    expect(db.sustainabilityRecords.get(result.sustainabilityRecordId!)!.returnId).toBe(result.returnId);
  });

  it('emits an ordered, gap-free trace', async () => {
    const { trace } = await runPipeline(PRIMARY.text, PRIMARY);

    expect(trace.length).toBeGreaterThan(10);
    expect(trace.map((e) => e.sequence)).toEqual(trace.map((_, i) => i));
    expect(trace[0]!.type).toBe('CASE_CREATED');
    expect(trace.at(-1)!.type).toBe('CASE_FINALIZED');
  });
});

/* ========================================================================== */
describe('edge-case scenarios (PRD section 10)', () => {
  it('denies a change-of-mind return outside the window', async () => {
    const s = db.scenarios.get('SCN-OUTSIDE-WINDOW')!;
    const result = await runPipeline(s.input, s);
    const eligibility = result.agentResults.eligibility!.output!;

    expect(eligibility.decision).toBe('DENIED');
    expect(eligibility.window.withinWindow).toBe(false);
    // A denial must still explain itself and cite the policy.
    expect(eligibility.policyCitation.length).toBeGreaterThan(0);
    expect(result.agentResults.communication!.output!.primaryCustomerResponse).not.toMatch(/\{\{/);
  });

  it('denies a perishable item by category, whatever the window', async () => {
    const s = db.scenarios.get('SCN-PERISHABLE')!;
    const { agentResults } = await runPipeline(s.input, s);
    const eligibility = agentResults.eligibility!.output!;

    expect(eligibility.decision).toBe('DENIED');
    const rule = eligibility.ruleTrace.find((r) => r.ruleId === 'ELG_CATEGORY_RETURNABLE');
    expect(rule?.outcome).toBe('FAIL');
  });

  it('halts for human review on a fraud signal', async () => {
    const s = db.scenarios.get('SCN-FRAUD-SIGNAL')!;
    const result = await runPipeline(s.input, s);

    expect(result.agentResults.eligibility!.output!.decision).toBe('MANUAL_REVIEW');
    expect(result.status).toBe('AWAITING_HUMAN_REVIEW');
    expect(result.escalations.some((e) => e.code === 'FRAUD_SIGNAL_DETECTED' && e.blocking)).toBe(true);
    // The customer must still hear something — silence is the failure mode.
    expect(result.agentResults.communication?.output?.primaryCustomerResponse).toBeTruthy();
  });

  it('avoids shipping a low-value item back for a VIP', async () => {
    const s = db.scenarios.get('SCN-VIP-LOW-VALUE')!;
    const { agentResults } = await runPipeline(s.input, s);

    expect(agentResults.resolution!.output!.recommended.type).toBe('KEEP_AND_REFUND');
    expect(agentResults.logistics!.output!.required).toBe(false);
    expect(agentResults.logistics!.status).toBe('COMPLETED');
    // Nothing moves, so this is the best possible environmental outcome.
    expect(agentResults.sustainability!.output!.disposition.path).toBe('NO_MOVEMENT');
    expect(agentResults.sustainability!.output!.grade).toBe('A');
  });

  it('applies EU statutory rules and cites the directive', async () => {
    const s = db.scenarios.get('SCN-EU-STATUTORY')!;
    const { agentResults } = await runPipeline(s.input, s);
    const eligibility = agentResults.eligibility!.output!;

    expect(eligibility.decision).toMatch(/^APPROVED/);
    // Restocking fees are prohibited inside the withdrawal window.
    expect(eligibility.restockingFeeUsd).toBe(0);
    expect(eligibility.policyCitation).toMatch(/Germany/i);
  });

  it('reports "no greener option" as a neutral fact for a remote address', async () => {
    const s = db.scenarios.get('SCN-NO-GREEN-OPTION')!;
    const { agentResults } = await runPipeline(s.input, s);
    const sustainability = agentResults.sustainability!.output!;

    expect(sustainability.greenerAlternativeAvailable).toBe(false);
    const escalation = agentResults.sustainability!.escalations.find(
      (e) => e.code === 'NO_GREENER_OPTION_AVAILABLE',
    );
    // Informational only — it must never block the customer's return.
    expect(escalation?.blocking).toBe(false);
    expect(escalation?.severity).toBe('INFO');
  });

  it('blames packaging, not the product, when the delivery scan showed damage', async () => {
    const s = db.scenarios.get('SCN-NO-GREEN-OPTION')!;
    const { agentResults } = await runPipeline(s.input, s);
    const signals = agentResults.insights!.output!.caseSignals;

    expect(signals.some((sig) => sig.signalType === 'PACKAGING_FAILURE')).toBe(true);
  });

  it('asks a clarifying question instead of guessing on unusable input', async () => {
    const result = await runPipeline('hi');

    expect(result.status).toBe('AWAITING_CLARIFICATION');
    // No agent should have run on a guess.
    expect(Object.keys(result.agentResults)).toHaveLength(0);
  });
});

/* ========================================================================== */
describe('every scenario runs to a terminal state', () => {
  it.each(db.scenarios.all().map((s) => [s.scenarioId, s] as const))('%s', async (_id, scenario) => {
    const result = await runPipeline(scenario.input, scenario);

    expect(['COMPLETED', 'ESCALATED', 'DENIED', 'AWAITING_HUMAN_REVIEW']).toContain(result.status);
    // No agent may be left stuck showing a spinner in the UI.
    expect(result.agentRuns.every((r) => r.status !== 'RUNNING' && r.status !== 'PENDING')).toBe(true);
    // Every agent that ran must have supplied a rationale.
    for (const run of result.agentRuns) {
      expect(run.rationale, `${run.agentId} rationale`).toBeTruthy();
    }
  });
});
