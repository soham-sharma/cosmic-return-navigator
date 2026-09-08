/**
 * CLAUDE AGENT SDK PARITY TESTS.
 *
 * These run with NO API KEY and make NO model calls, yet still verify the parts
 * of the LLM path that actually break in practice:
 *
 *   1. Both implementations of each agent satisfy the identical contract.
 *   2. The forced JSON Schema generates for all seven agents and is strict.
 *   3. THE IMPORTANT ONE — the schema we constrain the model with actually
 *      accepts real agent output. A schema that forces a shape nothing can
 *      satisfy would fail only at demo time, against a live model, with a
 *      confusing validation error. This catches it in CI for free.
 *   4. The fallback-to-rules path works when the model is unreachable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_IDS, llmAgentEnvelopeSchema, type AgentId } from '../src/domain/agent.schema';
import { getAgentImplementation, implementationFor } from '../src/agents/base/registry';
import { toStrictJsonSchema } from '../src/lib/zod-to-json-schema';
import { runPipeline } from '../src/orchestrator/orchestrator';
import { resetDb } from '../src/repositories/db';
import { resetStore } from '../src/orchestrator/state-store';
import { eligibilityLlmAgent } from '../src/agents/eligibility/eligibility.llm-agent';
import { sentimentLlmAgent } from '../src/agents/sentiment/sentiment.llm-agent';

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
describe('implementation parity', () => {
  it.each(AGENT_IDS)('%s has both a rules and an LLM implementation', (agentId) => {
    const rules = getAgentImplementation(agentId, 'rules');
    const llm = getAgentImplementation(agentId, 'llm');

    expect(rules).toBeDefined();
    expect(llm).toBeDefined();
  });

  it.each(AGENT_IDS)('%s: both implementations agree on id, stage and schemas', (agentId) => {
    const rules = getAgentImplementation(agentId, 'rules');
    const llm = getAgentImplementation(agentId, 'llm');

    expect(llm.id).toBe(rules.id);
    expect(llm.id).toBe(agentId);
    // Same pipeline stage — otherwise swapping an implementation would silently
    // reorder the pipeline.
    expect(llm.stage).toBe(rules.stage);
    // The SAME schema object, not merely an equivalent one. Sharing the
    // reference is what guarantees the two can never drift apart.
    expect(llm.inputSchema).toBe(rules.inputSchema);
    expect(llm.outputSchema).toBe(rules.outputSchema);
  });

  it('defaults to rules everywhere when AGENT_RUNTIME is unset in tests', () => {
    for (const agentId of AGENT_IDS) {
      expect(implementationFor(agentId)).toBe('rules');
    }
  });
});

/* ========================================================================== */
describe('forced JSON Schema generation', () => {
  it.each(AGENT_IDS)('%s: produces a strict schema for the Agent SDK', (agentId) => {
    const agent = getAgentImplementation(agentId, 'llm');
    const envelope = llmAgentEnvelopeSchema(agent.outputSchema);

    const schema = toStrictJsonSchema(envelope) as Record<string, unknown>;

    expect(schema.type).toBe('object');
    // The three fields with no default must be required. `warnings` and
    // `escalations` default to [], so under `io: 'input'` they are correctly
    // optional — the model may omit them and Zod fills the empty arrays.
    expect(schema.required).toEqual(expect.arrayContaining(['output', 'rationale', 'confidence']));
    // `$schema` must be stripped — the SDK wants a bare schema object.
    expect(schema.$schema).toBeUndefined();

    const properties = schema.properties as Record<string, unknown>;
    expect(properties.output).toBeDefined();
  });

  it.each(AGENT_IDS)('%s: schema is JSON-serializable (it crosses a process boundary)', (agentId) => {
    const agent = getAgentImplementation(agentId, 'llm');
    const schema = toStrictJsonSchema(llmAgentEnvelopeSchema(agent.outputSchema));

    // The Agent SDK sends this to a subprocess, so anything non-serializable
    // (a function, a cycle, undefined) would fail at call time.
    expect(() => JSON.stringify(schema)).not.toThrow();
    const round = JSON.parse(JSON.stringify(schema));
    expect(round).toEqual(schema);
  });
});

/* ========================================================================== */
describe('the forced schema accepts real agent output', () => {
  /**
   * The highest-value test here. It runs the deterministic pipeline, then feeds
   * each agent's REAL output back through the envelope schema the model is
   * constrained by. If a schema is over-strict, this fails in CI rather than
   * mid-demo against a live model.
   */
  it('every agent output validates against its own forced envelope schema', async () => {
    const result = await runPipeline(PRIMARY.text, PRIMARY);
    const checked: AgentId[] = [];

    for (const agentId of AGENT_IDS) {
      const run = result.agentResults[agentId];
      if (!run?.output) continue;

      const agent = getAgentImplementation(agentId, 'llm');
      const envelope = llmAgentEnvelopeSchema(agent.outputSchema);

      const parsed = envelope.safeParse({
        output: run.output,
        rationale: run.rationale,
        confidence: run.confidence,
        warnings: run.warnings,
        escalations: run.escalations,
      });

      if (!parsed.success) {
        throw new Error(
          `${agentId}: real output rejected by the schema used to force the model.\n` +
            JSON.stringify(parsed.error.issues.slice(0, 6), null, 2),
        );
      }
      checked.push(agentId);
    }

    // Guard against the test silently passing because nothing ran.
    expect(checked.length).toBeGreaterThanOrEqual(6);
  });
});

/* ========================================================================== */
describe('fallback when the model is unreachable', () => {
  /**
   * No ANTHROPIC_API_KEY is set in the test env, so `runStructuredQuery` throws
   * `LlmUnavailableError` immediately. With LLM_FALLBACK_TO_RULES on (the
   * default), the agent must still produce a usable result — this is what keeps
   * a live demo alive when the wifi is not.
   */
  it('eligibility falls back to rules and says so', async () => {
    const rulesRun = await runPipeline(PRIMARY.text, PRIMARY);
    const input = {
      caseId: rulesRun.caseId,
      intent: rulesRun.intent!,
      context: rulesRun.context!,
    };

    const result = await eligibilityLlmAgent.run(input, {
      caseId: rulesRun.caseId,
      traceId: 'test-trace',
      now: rulesRun.context!.now,
    });

    // A usable answer, not a failure.
    expect(result.status).not.toBe('FAILED');
    expect(result.output).not.toBeNull();
    expect(result.output!.decision).toMatch(/^APPROVED/);

    // And it must be HONEST about who decided — never claim the model ran.
    const fellBack = result.warnings.some((w) => w.code === 'LLM_UNAVAILABLE_FALLBACK');
    expect(fellBack).toBe(true);
    expect(result.rationale).toMatch(/deterministic rules/i);
  });

  it('sentiment falls back to rules and says so', async () => {
    const rulesRun = await runPipeline(PRIMARY.text, PRIMARY);
    const result = await sentimentLlmAgent.run(
      { caseId: rulesRun.caseId, intent: rulesRun.intent!, context: rulesRun.context! },
      { caseId: rulesRun.caseId, traceId: 'test-trace', now: rulesRun.context!.now },
    );

    expect(result.status).not.toBe('FAILED');
    expect(result.output).not.toBeNull();
    expect(result.output!.customerValue.loyaltyTier).toBe('GOLD');
    expect(result.warnings.some((w) => w.code === 'LLM_UNAVAILABLE_FALLBACK')).toBe(true);
  });
});
