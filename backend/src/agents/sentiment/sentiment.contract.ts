

/**
 * ============================================================================
 * AGENT CONTRACT 2/7 — SENTIMENT & RETENTION AGENT
 * ============================================================================
 *
 * PURPOSE
 *   Understand how the customer FEELS and how much they are WORTH, then size
 *   the right retention response. Combines language sentiment, complaint
 *   severity, loyalty tier and lifetime value into a churn-risk score and a
 *   concrete, budgeted set of recommended gestures.
 *
 * PIPELINE POSITION
 *   Stage 1, runs IN PARALLEL with the Eligibility Agent.
 *   DELIBERATE DESIGN CHOICE: this agent must NOT see the eligibility decision.
 *   Emotion and customer value are facts about the customer, not consequences
 *   of the policy outcome — coupling them would let a denial bias the sentiment
 *   read (and would serialize two independent computations for no reason).
 *   Downstream: Resolution Planning (gesture budget) and Communication (tone).
 *
 * DECISION LOGIC (simulated — lexicon + weighted scoring, no ML training)
 *   a) SENTIMENT SCORE
 *      Lexicon match over `intent.rawText`: weighted negative terms
 *      ("damaged", "broken", "furious", "unacceptable", "never again"),
 *      positive terms, intensifiers ("very", "extremely"), negation handling,
 *      ALL-CAPS and "!"/"?" density as intensity multipliers.
 *      -> score in [-1, +1], label bucketed at -0.6 / -0.2 / +0.2.
 *
 *   b) COMPLAINT SEVERITY
 *      Escalates on: merchant-fault reason (damage/defect) + negative tone +
 *      explicit threat markers ("cancel my account", "post a review",
 *      "lawyer", "chargeback") + repeat unresolved interactions in history.
 *      -> LOW | MODERATE | HIGH | CRITICAL
 *
 *   c) CUSTOMER VALUE BAND
 *      lifetimeValueUsd vs thresholds.vipLifetimeValueUsd, loyaltyTier,
 *      tenureMonths, order frequency -> STANDARD | HIGH | VIP.
 *
 *   d) CHURN RISK (0-100, weighted sum — tune the weights in sentiment.rules)
 *        35%  sentiment negativity
 *        25%  complaint severity
 *        15%  unresolved prior interactions (recentInteractions where !resolved)
 *        15%  declining NPS / low lastNpsScore
 *        10%  recency of the last complaint
 *      Then a tier modifier: high tiers churn less readily but cost more when
 *      they do, so the *financial* exposure = churnRisk x lifetimeValue.
 *
 *   e) RETENTION GESTURES
 *      Warranted when churnScore >= thresholds.retentionInterventionChurnScore
 *      OR severity is HIGH/CRITICAL OR fault is MERCHANT.
 *      Budget = tierBenefit.goodwillBudgetUsd, scaled by severity, hard-capped
 *      so a gesture never exceeds a sane fraction of lifetime value.
 *      Gestures are RECOMMENDATIONS only — the Resolution Planning Agent owns
 *      the final grant decision and the cost trade-off.
 *
 *   f) SOCIAL RISK
 *      Cosmic Mart's problem statement is public sentiment, so we explicitly
 *      model publicComplaintLikelihood from escalatedPublicly history +
 *      severity + tier. HIGH feeds a PUBLIC_COMPLAINT_RISK escalation so the
 *      retention desk can pre-empt a bad review.
 *
 * ESCALATION / EDGE CASES
 *
 *   EXACTLY ONE escalation from this agent is blocking:
 *     CRITICAL_SENTIMENT      severity CRITICAL -> BLOCKING, RETENTION_DESK.
 *                             A furious customer gets a human, always.
 *
 *   Everything else is advisory:
 *     VIP_RETENTION_OVERRIDE  VIP band + negative sentiment. Authorizes
 *                             above-policy generosity. This is the PRD's
 *                             "high-value customer with a low-value item" case.
 *     PUBLIC_COMPLAINT_RISK   flags brand exposure for the retention desk.
 *     HUMAN_AGENT_REQUESTED   the customer asked for a person. Advisory, NOT
 *                             blocking: the pipeline should still produce a
 *                             resolution so the human who calls has something
 *                             to offer, rather than starting from nothing.
 *     MISSING_REQUIRED_DATA   rawText empty/unusable -> neutral fallback plus a
 *                             warning; the agent must still return a result.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { LoyaltyTierSchema, ScoreSchema, UnitScoreSchema } from '../../domain/common.schema';
import { ReturnIntentSchema } from '../../domain/return.schema';

/* --------------------------------- INPUT ---------------------------------- */

export const SentimentInputSchema = z.object({
  caseId: z.string(),
  intent: ReturnIntentSchema,
  context: CaseContextSchema,
});
export type SentimentInput = z.infer<typeof SentimentInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

export const SentimentLabelSchema = z.enum(['VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE']);
export type SentimentLabel = z.infer<typeof SentimentLabelSchema>;

export const EmotionSchema = z.enum([
  'FRUSTRATION',
  'ANGER',
  'DISAPPOINTMENT',
  'ANXIETY',
  'CONFUSION',
  'URGENCY',
  'RESIGNATION',
  'NEUTRAL',
  'SATISFACTION',
]);
export type Emotion = z.infer<typeof EmotionSchema>;

export const ComplaintSeveritySchema = z.enum(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);
export type ComplaintSeverity = z.infer<typeof ComplaintSeveritySchema>;

export const RiskBandSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskBand = z.infer<typeof RiskBandSchema>;

export const SentimentAnalysisSchema = z.object({
  label: SentimentLabelSchema,
  /** -1 (very negative) .. +1 (very positive). */
  score: z.number().min(-1).max(1),
  /** 0-1 emotional intensity, independent of polarity. */
  intensity: UnitScoreSchema,
  /** Ranked emotions with strengths — powers the UI emotion chips. */
  emotions: z.array(z.object({ emotion: EmotionSchema, intensity: UnitScoreSchema })).default([]),
  /** Lexicon hits that drove the score. Explainability: the UI highlights
   *  these spans in the customer's own words. */
  drivers: z
    .array(z.object({ term: z.string(), polarity: z.enum(['NEGATIVE', 'POSITIVE', 'INTENSIFIER']), weight: z.number() }))
    .default([]),
  detectedLanguage: z.string().default('en'),
});
export type SentimentAnalysis = z.infer<typeof SentimentAnalysisSchema>;

export const CustomerValueSchema = z.object({
  loyaltyTier: LoyaltyTierSchema,
  lifetimeValueUsd: z.number().nonnegative(),
  tenureMonths: z.number().int().nonnegative(),
  lifetimeOrders: z.number().int().nonnegative(),
  /** LTV percentile within the customer base (mocked from fixtures). */
  valuePercentile: ScoreSchema,
  valueBand: z.enum(['STANDARD', 'HIGH', 'VIP']),
  /** churnScore/100 * lifetimeValueUsd — the money genuinely at risk. */
  revenueAtRiskUsd: z.number().nonnegative(),
});
export type CustomerValue = z.infer<typeof CustomerValueSchema>;

export const ChurnRiskSchema = z.object({
  score: ScoreSchema,
  band: RiskBandSchema,
  /** Named contributors with their weighted point contributions, so the score
   *  is fully decomposable in the UI. */
  drivers: z.array(z.object({ factor: z.string(), contribution: z.number(), detail: z.string() })).default([]),
  /** Rough probability of no repeat purchase in the next 12 months. */
  churnProbability: UnitScoreSchema,
});
export type ChurnRisk = z.infer<typeof ChurnRiskSchema>;

/** A suggested gesture. NOT yet granted — Resolution Planning decides. */
export const RetentionGestureSchema = z.object({
  type: z.enum([
    'BONUS_POINTS',
    'DISCOUNT_CODE',
    'FREE_EXPEDITED_SHIPPING',
    'APOLOGY_CREDIT',
    'TIER_UPGRADE',
    'EXTENDED_WARRANTY',
    'HUMAN_CALLBACK',
    'UPGRADED_RESOLUTION',
  ]),
  value: z.number().nonnegative(),
  unit: z.enum(['POINTS', 'PERCENT', 'USD', 'MONTHS', 'NONE']),
  /** Business cost, normalized to USD, so the resolution cost model can add it. */
  estimatedCostUsd: z.number().nonnegative(),
  /** Expected churn-score reduction if granted (0-100 points). */
  expectedChurnReduction: z.number().min(0).max(100),
  priority: z.number().int().min(1).max(5),
  rationale: z.string(),
});
export type RetentionGesture = z.infer<typeof RetentionGestureSchema>;

export const RetentionOpportunitySchema = z.object({
  /** True when the business SHOULD spend something to keep this customer. */
  warranted: z.boolean(),
  recommendedGestures: z.array(RetentionGestureSchema).default([]),
  /** Hard ceiling from tier benefits, scaled by severity. Resolution Planning
   *  must not exceed this without a human approval. */
  maxGoodwillBudgetUsd: z.number().nonnegative(),
  /** 0-3 nudge applied to resolution scoring weights: higher means "favour
   *  satisfaction over cost". */
  satisfactionWeightBoost: z.number().min(0).max(3),
  /** True when the agent recommends upgrading the resolution tier itself
   *  (e.g. replacement instead of refund). */
  recommendUpgradedResolution: z.boolean().default(false),
  targetCsat: z.number().min(0).max(5).nullable().default(null),
});
export type RetentionOpportunity = z.infer<typeof RetentionOpportunitySchema>;

export const SentimentOutputSchema = z.object({
  sentiment: SentimentAnalysisSchema,
  complaintSeverity: ComplaintSeveritySchema,
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'IMMEDIATE']),

  customerValue: CustomerValueSchema,
  churnRisk: ChurnRiskSchema,
  retention: RetentionOpportunitySchema,

  /** Brand-exposure model — Cosmic Mart's core stated problem. */
  socialRisk: z.object({
    publicComplaintLikelihood: UnitScoreSchema,
    band: RiskBandSchema,
    priorPublicComplaints: z.number().int().nonnegative(),
    rationale: z.string(),
  }),

  /** Tone instruction consumed directly by the Communication Agent, so tone
   *  selection lives with the agent that measured the emotion. */
  recommendedTone: z.enum(['EMPATHETIC', 'APOLOGETIC', 'NEUTRAL_INFORMATIVE', 'REASSURING', 'CELEBRATORY']),
  /** True when the customer asked for a human, or severity demands one. */
  humanTouchRecommended: z.boolean(),
  /** Short internal brief for a support agent picking this up. */
  supportBriefing: z.string(),
});
export type SentimentOutput = z.infer<typeof SentimentOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const SentimentResultSchema = agentResultSchema(SentimentOutputSchema);
export type SentimentResult = z.infer<typeof SentimentResultSchema>;
