/**
 * ============================================================================
 * AGENT CONTRACT 5/7 — COMMUNICATION AGENT
 * ============================================================================
 * (Numbered 5 in the PRD; runs at pipeline stage 5 — see note below.)
 *
 * PURPOSE
 *   Keep the customer informed proactively, in the right tone, on the right
 *   channel, at the right time. Renders the immediate confirmation message and
 *   schedules the follow-up sequence (pickup reminder, in-transit, received,
 *   refund processed). Also owns the human-handoff briefing when a case needs
 *   a person.
 *
 * PIPELINE POSITION
 *   Stage 5, runs IN PARALLEL with the Insights Agent.
 *   Both depend on everything upstream and on nothing from each other, so they
 *   fan out. This agent runs AFTER sustainability so it can quote the CO2
 *   saving in the confirmation message (a PRD demo beat) and after the
 *   orchestrator's conflict resolution so it never promises a logistics option
 *   that was overridden.
 *
 * DECISION LOGIC (simulated — template selection + variable binding)
 *   STEP 1: CHANNEL PLAN
 *     primary   = customer.communicationPreferences.preferredChannel, if it is
 *                 in allowedChannels; else the first allowed channel.
 *     fallbacks = remaining allowedChannels, ordered EMAIL > SMS > PUSH > IN_APP.
 *     Urgency IMMEDIATE adds SMS even if it is not preferred.
 *     NO_REACHABLE_CHANNEL when allowedChannels is empty or contact details
 *     are missing.
 *   STEP 2: TONE
 *     Taken verbatim from `sentiment.recommendedTone`. Tone selection belongs
 *     to the agent that measured the emotion; this agent must not re-derive it.
 *     Guardrail: CELEBRATORY is FORBIDDEN when complaintSeverity is HIGH or
 *     CRITICAL, regardless of what was requested — downgrade to REASSURING.
 *   STEP 3: TEMPLATE SELECTION
 *     Key = (trigger, channel, tone, locale). Fall back by relaxing locale,
 *     then tone, then channel. A missing template is a WARNING, never a crash:
 *     emit a plain-text default and flag it.
 *   STEP 4: VARIABLE BINDING
 *     Bind from the case: customer first name, product name, resolution
 *     summary, refund/points amounts, pickup window, tracking number, SLA,
 *     CO2 saved. Every `requiredVariables` entry must resolve or the message
 *     is downgraded to a template that needs fewer variables. Never ship a
 *     message containing an unresolved `{{placeholder}}` — validate before
 *     queueing.
 *   STEP 5: SEND-TIME / QUIET HOURS
 *     Immediate messages send now. Scheduled nudges shift out of
 *     preferences.quietHours. Marketing-adjacent content (green incentive) is
 *     suppressed unless marketingOptIn.
 *   STEP 6: THE PRIMARY RESPONSE
 *     `primaryCustomerResponse` is the single string the demo UI shows as the
 *     assistant's reply. It must state the resolution, the logistics action and
 *     any goodwill in one breath — the PRD's target line is:
 *     "We've approved your replacement, scheduled a pickup for tomorrow, and
 *      added 500 Cosmic Rewards points for the inconvenience."
 *
 * ESCALATION / EDGE CASES
 *   HUMAN_AGENT_REQUESTED  sentiment.humanTouchRecommended or an explicit ask
 *                          -> emits `humanHandoff` with a pre-written briefing
 *                          and routes to the queue sentiment suggested.
 *                          Blocking only if nothing was resolvable automatically.
 *   NO_REACHABLE_CHANNEL   no usable channel -> blocking, TIER1_SUPPORT, so a
 *                          human phones the customer.
 *   MISSING_REQUIRED_DATA  template variables unresolvable -> non-blocking
 *                          warning + simplified message.
 *   Denied / escalated cases: this agent still runs and must produce an
 *   empathetic explanation with the policy citation and next steps. Silence is
 *   the failure mode Cosmic Mart is already being criticized for.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { ChannelSchema, IsoDateTimeSchema } from '../../domain/common.schema';
import { HumanQueueSchema } from '../../domain/agent.schema';
import { MessageToneSchema, NotificationSchema, NotificationTriggerSchema } from '../../domain/notification.schema';
import { EligibilityOutputSchema } from '../eligibility/eligibility.contract';
import { SentimentOutputSchema } from '../sentiment/sentiment.contract';
import { ResolutionOutputSchema } from '../resolution/resolution.contract';
import { LogisticsOutputSchema } from '../logistics/logistics.contract';
import { SustainabilityOutputSchema } from '../sustainability/sustainability.contract';

/* --------------------------------- INPUT ---------------------------------- */

export const CommunicationInputSchema = z.object({
  caseId: z.string(),
  context: CaseContextSchema,
  eligibility: EligibilityOutputSchema,
  sentiment: SentimentOutputSchema,
  /** Null when the pipeline halted before Resolution ran. The agent must still
   *  produce an acknowledgement message in that case. */
  resolution: ResolutionOutputSchema.nullable(),
  logistics: LogisticsOutputSchema.nullable(),
  sustainability: SustainabilityOutputSchema.nullable(),
  /** True when the orchestrator is halting for human review. */
  pipelineHalted: z.boolean().default(false),
});
export type CommunicationInput = z.infer<typeof CommunicationInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

export const ChannelPlanSchema = z.object({
  primary: ChannelSchema,
  fallbacks: z.array(ChannelSchema).default([]),
  /** Channels excluded, with reasons (not opted in, no phone on file). */
  excluded: z.array(z.object({ channel: ChannelSchema, reason: z.string() })).default([]),
  quietHoursApplied: z.boolean().default(false),
  locale: z.string().default('en-US'),
});
export type ChannelPlan = z.infer<typeof ChannelPlanSchema>;

/** A future notification the system commits to sending. */
export const ScheduledNotificationSchema = z.object({
  trigger: NotificationTriggerSchema,
  channel: ChannelSchema,
  templateId: z.string(),
  /** Absolute send time, already quiet-hours adjusted. */
  scheduledFor: IsoDateTimeSchema,
  /** Event that cancels this notification if it happens first. */
  cancelOn: z.array(NotificationTriggerSchema).default([]),
  description: z.string(),
});
export type ScheduledNotification = z.infer<typeof ScheduledNotificationSchema>;

export const HumanHandoffSchema = z.object({
  required: z.boolean(),
  queue: HumanQueueSchema,
  priority: z.number().int().min(1).max(5),
  /** Pre-written context so the human does not re-interview the customer. */
  briefing: z.string(),
  /** Bullet list of what the agents already established. */
  keyFacts: z.array(z.string()).default([]),
  suggestedOpeningLine: z.string().nullable().default(null),
  slaMinutes: z.number().int().positive().nullable().default(null),
});
export type HumanHandoff = z.infer<typeof HumanHandoffSchema>;

export const CommunicationOutputSchema = z.object({
  /** Messages queued for immediate delivery (already rendered). */
  messages: z.array(NotificationSchema).default([]),
  /** The follow-up sequence committed to. */
  scheduled: z.array(ScheduledNotificationSchema).default([]),
  channelPlan: ChannelPlanSchema,
  toneUsed: MessageToneSchema,
  /** Set when the requested tone was overridden by the severity guardrail. */
  toneOverrideReason: z.string().nullable().default(null),

  /**
   * THE headline string the demo UI renders as the assistant's reply.
   * Must be complete and self-contained — resolution + logistics + goodwill.
   */
  primaryCustomerResponse: z.string().min(1),
  /** Short subject/summary for the case list. */
  headline: z.string(),
  /** Optional follow-up question when the case needs customer input. */
  clarifyingQuestion: z.string().nullable().default(null),

  humanHandoff: HumanHandoffSchema.nullable().default(null),

  /** Templates that could not be found — surfaced so content owners can fix. */
  missingTemplates: z.array(z.string()).default([]),
  /** Total messages the customer will receive across the case lifecycle. */
  totalPlannedTouchpoints: z.number().int().nonnegative(),
});
export type CommunicationOutput = z.infer<typeof CommunicationOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const CommunicationResultSchema = agentResultSchema(CommunicationOutputSchema);
export type CommunicationResult = z.infer<typeof CommunicationResultSchema>;
