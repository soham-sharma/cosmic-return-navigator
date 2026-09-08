/**
 * ============================================================================
 * PIPELINE CONFIGURATION — the agent execution plan
 * ============================================================================
 *
 * Declarative, so the sequencing decisions are readable in one screen and the
 * frontend can fetch the same shape to draw the pipeline diagram.
 *
 *   STAGE 0  intake            (orchestrator: parse intent, hydrate context)
 *   STAGE 1  PARALLEL          eligibility  ||  sentiment
 *   STAGE 2  sequential        resolution
 *   STAGE 3  sequential        logistics            (skippable)
 *   STAGE 4  sequential        sustainability
 *   STAGE 4b orchestrator      conflict resolution  (cost vs carbon)
 *   STAGE 5  PARALLEL          communication  ||  insights
 *   STAGE 6  orchestrator      finalize
 *
 * WHY THIS SHAPE
 *
 *   Stage 1 is parallel because eligibility (policy facts) and sentiment
 *   (customer facts) share no inputs. Running them together halves the visible
 *   latency and, more importantly, stops the policy outcome from biasing the
 *   sentiment read.
 *
 *   Stages 2-4 are strictly sequential because each genuinely consumes the
 *   previous one's output: resolution needs to know what is permitted and how
 *   generous to be; logistics needs to know whether anything moves; and
 *   sustainability scores the concrete options logistics produced.
 *
 *   Stage 5 is parallel because communication and insights are both pure
 *   consumers — neither reads the other.
 *
 *   The conflict resolution step sits between 4 and 5 deliberately: it must run
 *   after sustainability has scored the options (so there is a real trade-off
 *   to decide) and before communication (so we never promise the customer an
 *   option that was then overridden).
 * ============================================================================
 */
import type { AgentId } from '../domain/agent.schema';

export interface StageDefinition {
  stage: number;
  name: string;
  /** Agents in this stage. More than one means they run concurrently. */
  agents: AgentId[];
  mode: 'PARALLEL' | 'SEQUENTIAL';
  /** Human-readable label for the UI. */
  description: string;
  /**
   * Agents whose FAILURE does not abort the pipeline. Insights is optional by
   * design — analytics must never break a customer's return.
   */
  optionalAgents?: AgentId[];
  /**
   * If true, a blocking escalation raised in this stage halts the pipeline at
   * the end of the stage. Stage 5 is false: by then the customer outcome is
   * already decided and we still want the message sent.
   */
  haltOnBlockingEscalation: boolean;
}

export const PIPELINE: StageDefinition[] = [
  {
    stage: 1,
    name: 'Assess',
    agents: ['eligibility', 'sentiment'],
    mode: 'PARALLEL',
    description: 'Validate the return against policy while reading customer sentiment and value.',
    haltOnBlockingEscalation: true,
  },
  {
    stage: 2,
    name: 'Decide',
    agents: ['resolution'],
    mode: 'SEQUENTIAL',
    description: 'Choose the optimal resolution across satisfaction, cost and retention.',
    haltOnBlockingEscalation: true,
  },
  {
    stage: 3,
    name: 'Plan logistics',
    agents: ['logistics'],
    mode: 'SEQUENTIAL',
    description: 'Enumerate return routes, generate the label and book the collection.',
    haltOnBlockingEscalation: true,
  },
  {
    stage: 4,
    name: 'Score impact',
    agents: ['sustainability'],
    mode: 'SEQUENTIAL',
    description: 'Quantify CO2 per route, choose the disposition, recommend the greenest viable path.',
    haltOnBlockingEscalation: false,
  },
  {
    stage: 5,
    name: 'Communicate & learn',
    agents: ['communication', 'insights'],
    mode: 'PARALLEL',
    description: 'Tell the customer what happens next and turn the case into business intelligence.',
    optionalAgents: ['insights'],
    // By this point the outcome is settled; never suppress the customer message.
    haltOnBlockingEscalation: false,
  },
];

/** Total stages including the orchestrator's own intake (0) and finalize (6). */
export const TOTAL_STAGES = 6;

/** Stage at which the orchestrator resolves cost-vs-carbon conflicts. */
export const CONFLICT_RESOLUTION_AFTER_STAGE = 4;

export function stageForAgent(agentId: AgentId): number {
  return PIPELINE.find((s) => s.agents.includes(agentId))?.stage ?? 0;
}

export function isOptional(stage: StageDefinition, agentId: AgentId): boolean {
  return stage.optionalAgents?.includes(agentId) ?? false;
}

/** Serializable plan for `GET /meta/pipeline` — the frontend draws from this. */
export function describePipeline() {
  return {
    totalStages: TOTAL_STAGES,
    conflictResolutionAfterStage: CONFLICT_RESOLUTION_AFTER_STAGE,
    stages: [
      { stage: 0, name: 'Intake', agents: [], mode: 'SEQUENTIAL', description: 'Normalize free text into a structured return intent and hydrate the shared context.', owner: 'orchestrator' },
      ...PIPELINE.map((s) => ({ ...s, owner: 'agents' })),
      { stage: 6, name: 'Finalize', agents: [], mode: 'SEQUENTIAL', description: 'Aggregate agent outputs into the final customer outcome and persist all records.', owner: 'orchestrator' },
    ],
  };
}
