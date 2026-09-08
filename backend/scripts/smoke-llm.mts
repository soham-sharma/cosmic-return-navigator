/**
 * Connectivity smoke test for the Claude Agent SDK path.
 *
 * Runs ONE agent against the configured endpoint and reports exactly what
 * happened. Run this before any demo — it isolates "is the model reachable and
 * is forced JSON working" from "is the pipeline correct", which are very
 * different failures with very similar symptoms.
 */
import { runPipeline } from '../src/orchestrator/orchestrator';
import { eligibilityLlmAgent } from '../src/agents/eligibility/eligibility.llm-agent';
import { env } from '../src/config/env';
import { toStrictJsonSchema } from '../src/lib/zod-to-json-schema';
import { llmAgentEnvelopeSchema } from '../src/domain/agent.schema';
import { EligibilityOutputSchema } from '../src/agents/eligibility/eligibility.contract';

const line = (c = '-') => console.log(c.repeat(78));

async function main() {
  line('=');
  console.log('CLAUDE AGENT SDK — CONNECTIVITY SMOKE TEST');
  line('=');
  console.log(`runtime      : ${env.AGENT_RUNTIME}`);
  console.log(`model        : ${env.LLM_MODEL}`);
  console.log(`effort       : ${env.LLM_EFFORT}`);
  console.log(`base URL     : ${env.ANTHROPIC_BASE_URL ?? '(default Anthropic endpoint)'}`);
  console.log(`api key      : ${env.ANTHROPIC_API_KEY ? `${env.ANTHROPIC_API_KEY.slice(0, 8)}…(${env.ANTHROPIC_API_KEY.length} chars)` : 'MISSING'}`);
  console.log(`fallback     : ${env.LLM_FALLBACK_TO_RULES ? 'rules' : 'none (hard fail)'}`);

  const schema = toStrictJsonSchema(llmAgentEnvelopeSchema(EligibilityOutputSchema));
  console.log(`forced schema: ${JSON.stringify(schema).length} bytes, strict=${schema.additionalProperties === false}`);

  // Build a real input by running the deterministic pipeline first.
  line();
  console.log('Building a real case context (rules pipeline)…');
  const seed = await runPipeline(
    "I bought a smartwatch 20 days ago. It arrived damaged and I'd like a return.",
    { customerId: 'CUST-001001', orderId: 'ORD-088213', orderItemId: 'ORD-088213-I1' },
  );
  console.log(`  case ${seed.caseId}, context hydrated: ${Boolean(seed.context)}`);

  line();
  console.log('Calling the Eligibility Agent through the Claude Agent SDK…');
  const startMs = Date.now();

  const result = await eligibilityLlmAgent.run(
    { caseId: seed.caseId, intent: seed.intent!, context: seed.context! },
    { caseId: seed.caseId, traceId: 'smoke-test', now: seed.context!.now },
  );

  const elapsed = Date.now() - startMs;
  line('=');
  console.log(`status         : ${result.status}`);
  console.log(`implementation : ${result.implementation}  <-- 'llm' means the model answered`);
  console.log(`wall clock     : ${elapsed}ms  (agent-reported ${result.durationMs}ms)`);
  console.log(`confidence     : ${result.confidence}`);
  console.log(`inputsUsed     : ${result.inputsUsed.join(', ')}`);

  if (result.warnings.length) {
    console.log('\nwarnings:');
    for (const w of result.warnings) console.log(`  [${w.code}] ${w.message}`);
  }
  if (result.error) console.log(`\nerror: [${result.error.code}] ${result.error.message}`);

  console.log(`\nrationale:\n  ${result.rationale}`);

  if (result.output) {
    console.log(`\ndecision       : ${result.output.decision}`);
    console.log(`score          : ${result.output.eligibilityScore}`);
    console.log(`within window  : ${result.output.window.withinWindow} (${result.output.window.daysElapsed}/${result.output.window.effectiveWindowDays} days)`);
    console.log(`restocking fee : $${result.output.restockingFeeUsd}`);
    console.log(`refundable     : $${result.output.refundableAmountUsd}`);
    console.log(`rules traced   : ${result.output.ruleTrace.length}`);
    console.log(`citation       : ${result.output.policyCitation}`);
  }

  line('=');
  if (result.implementation === 'llm') {
    console.log('RESULT: the Agent SDK path WORKS against this endpoint.');
  } else {
    console.log('RESULT: the model was NOT reached — this output came from the rules fallback.');
    console.log('        See the warning above for the reason.');
    process.exitCode = 1;
  }
  line('=');
}

main().catch((err) => {
  console.error('\nSMOKE TEST THREW:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
