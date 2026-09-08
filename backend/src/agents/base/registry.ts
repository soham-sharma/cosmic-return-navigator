/**
 * AGENT REGISTRY — the single place agents are wired up.
 *
 * Every agent exists in TWO interchangeable implementations behind one contract:
 *
 *   RULES  `<agent>.agent.ts`      deterministic TypeScript. No network, no
 *                                  cost, sub-millisecond, byte-reproducible.
 *                                  Backs the test suite and the offline demo.
 *   LLM    `<agent>.llm-agent.ts`  a Claude Agent SDK call with a forced JSON
 *                                  schema derived from the same Zod contract.
 *
 * `AGENT_RUNTIME` / `LLM_AGENTS` decide which one each agent uses. Because both
 * extend `BaseAgent` and satisfy the identical contract, the orchestrator, the
 * API layer, the state store and the frontend cannot tell the difference — the
 * choice is genuinely a configuration concern, which is what makes the PRD's
 * "agents independently replaceable" requirement real rather than aspirational.
 *
 * Adding an eighth agent means touching this file and `pipeline.config.ts`, and
 * nothing else.
 */
import { AGENT_IDS, AGENT_METADATA, type AgentId } from '../../domain/agent.schema';
import { env, usesLlm } from '../../config/env';
import { logger } from '../../core/logger';
import { notFound } from '../../core/errors';

/* --- rules implementations --- */
import { eligibilityAgent } from '../eligibility/eligibility.agent';
import { sentimentAgent } from '../sentiment/sentiment.agent';
import { resolutionAgent } from '../resolution/resolution.agent';
import { logisticsAgent } from '../logistics/logistics.agent';
import { CommunicationAgent } from '../communication/communication.agent';
import { sustainabilityAgent } from '../sustainability/sustainability.agent';
import { insightsAgent } from '../insights/insights.agent';

/* --- Claude Agent SDK implementations --- */
import { eligibilityLlmAgent } from '../eligibility/eligibility.llm-agent';
import { sentimentLlmAgent } from '../sentiment/sentiment.llm-agent';
import { resolutionLlmAgent } from '../resolution/resolution.llm-agent';
import { logisticsLlmAgent } from '../logistics/logistics.llm-agent';
import { communicationLlmAgent } from '../communication/communication.llm-agent';
import { sustainabilityLlmAgent } from '../sustainability/sustainability.llm-agent';
import { insightsLlmAgent } from '../insights/insights.llm-agent';

import { db } from '../../repositories/db';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAgent = {
  id: AgentId;
  name: string;
  version: string;
  stage: number;
  inputSchema: any;
  outputSchema: any;
  execute(input: any, ctx: any): Promise<any>;
  run(input: any, ctx: { caseId: string; runId?: string; traceId: string; now: string }): Promise<any>;
};

/**
 * The rules Communication Agent needs the notification-template library, which
 * lives in the mock database. Constructed lazily so fixtures load first.
 */
let rulesCommunication: CommunicationAgent | null = null;
function getRulesCommunicationAgent(): CommunicationAgent {
  if (!rulesCommunication) rulesCommunication = new CommunicationAgent(db.notificationTemplates.all());
  return rulesCommunication;
}

const RULES_AGENTS: Record<AgentId, () => AnyAgent> = {
  eligibility: () => eligibilityAgent as unknown as AnyAgent,
  sentiment: () => sentimentAgent as unknown as AnyAgent,
  resolution: () => resolutionAgent as unknown as AnyAgent,
  logistics: () => logisticsAgent as unknown as AnyAgent,
  communication: () => getRulesCommunicationAgent() as unknown as AnyAgent,
  sustainability: () => sustainabilityAgent as unknown as AnyAgent,
  insights: () => insightsAgent as unknown as AnyAgent,
};

const LLM_AGENTS: Record<AgentId, () => AnyAgent> = {
  eligibility: () => eligibilityLlmAgent as unknown as AnyAgent,
  sentiment: () => sentimentLlmAgent as unknown as AnyAgent,
  resolution: () => resolutionLlmAgent as unknown as AnyAgent,
  logistics: () => logisticsLlmAgent as unknown as AnyAgent,
  communication: () => communicationLlmAgent as unknown as AnyAgent,
  sustainability: () => sustainabilityLlmAgent as unknown as AnyAgent,
  insights: () => insightsLlmAgent as unknown as AnyAgent,
};

/** Which implementation is serving a given agent right now. */
export type AgentImplementation = 'rules' | 'llm';

export function implementationFor(id: AgentId): AgentImplementation {
  // No key means no model call is possible; report rules so the UI and the
  // /agents catalogue tell the truth rather than what was configured.
  if (usesLlm(id) && env.hasCredential) return 'llm';
  return 'rules';
}

export function getAgent(id: AgentId): AnyAgent {
  if (!AGENT_IDS.includes(id)) throw notFound('Agent', id);
  return implementationFor(id) === 'llm' ? LLM_AGENTS[id]() : RULES_AGENTS[id]();
}

/** Explicitly fetch one implementation — used by tests and the compare endpoint. */
export function getAgentImplementation(id: AgentId, implementation: AgentImplementation): AnyAgent {
  if (!AGENT_IDS.includes(id)) throw notFound('Agent', id);
  return implementation === 'llm' ? LLM_AGENTS[id]() : RULES_AGENTS[id]();
}

/** Reset cached instances — used by `POST /demo/reset`. */
export function resetRegistry(): void {
  rulesCommunication = null;
}

/**
 * Catalogue for `GET /agents`, so the frontend can render the agent panel
 * without hardcoding names, purposes, stages — or which implementation is live.
 */
export function listAgents() {
  return AGENT_IDS.map((id) => {
    const implementation = implementationFor(id);
    const agent = getAgent(id);
    return {
      agentId: id,
      ...AGENT_METADATA[id],
      version: agent.version,
      stage: agent.stage,
      implementation,
      /** True when configuration asked for the LLM but no key is available. */
      llmRequestedButUnavailable: usesLlm(id) && !env.hasCredential,
      model: implementation === 'llm' ? env.LLM_MODEL : null,
    };
  });
}

/** One-line startup summary so it is obvious what is actually running. */
export function logRuntimeSummary(): void {
  const llm = AGENT_IDS.filter((id) => implementationFor(id) === 'llm');
  logger.info('[registry] Agent implementations resolved', {
    runtime: env.AGENT_RUNTIME,
    llmAgents: llm.length ? llm.join(',') : '(none)',
    rulesAgents: AGENT_IDS.filter((id) => implementationFor(id) === 'rules').join(','),
    model: llm.length ? env.LLM_MODEL : null,
    effort: llm.length ? env.LLM_EFFORT : null,
    fallbackToRules: env.LLM_FALLBACK_TO_RULES,
  });
}
