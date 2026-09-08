/**
 * SENTIMENT & RETENTION RULES — pure functions.
 *
 * OWNER: <assign>
 * STATUS: wireframe. The lexicon and weights are real but minimal; the scoring
 * functions are marked TODO where the model needs fleshing out. Everything is
 * deterministic — no ML, no network.
 */
import type { CaseContext } from '../../domain/case-context.schema';
import type { ReturnIntent } from '../../domain/return.schema';
import { daysBetween } from '../../core/clock';
import type {
  ChurnRisk,
  ComplaintSeverity,
  CustomerValue,
  RetentionGesture,
  SentimentAnalysis,
} from './sentiment.contract';

/* -------------------------------------------------------------------------- */
/* Lexicon — extend freely; keep weights in [0,1]                              */
/* -------------------------------------------------------------------------- */

export const NEGATIVE_TERMS: Record<string, number> = {
  damaged: 0.6, broken: 0.7, defective: 0.7, cracked: 0.6, useless: 0.8,
  terrible: 0.8, awful: 0.8, unacceptable: 0.9, furious: 1.0, angry: 0.8,
  disappointed: 0.6, frustrated: 0.7, annoyed: 0.5, ridiculous: 0.7,
  'waste of money': 0.8, 'never again': 0.9, 'worst': 0.8, 'poor quality': 0.7,
  disgusted: 0.9, appalled: 0.9, scam: 1.0, 'rip off': 0.9,
};

export const POSITIVE_TERMS: Record<string, number> = {
  thanks: 0.4, thank: 0.4, please: 0.2, appreciate: 0.5, love: 0.6,
  great: 0.5, happy: 0.5, understanding: 0.4, 'no rush': 0.3,
};

export const INTENSIFIERS: Record<string, number> = {
  very: 1.3, extremely: 1.6, incredibly: 1.5, really: 1.2, so: 1.15,
  totally: 1.4, completely: 1.4, absolutely: 1.5, 'beyond': 1.4,
};

/** Phrases that jump severity straight to HIGH/CRITICAL. */
export const THREAT_MARKERS = [
  'cancel my account', 'cancel my subscription', 'close my account',
  'leave a review', 'post about this', 'social media', 'twitter', 'trustpilot',
  'lawyer', 'legal action', 'chargeback', 'dispute the charge',
  'speak to a human', 'speak to a manager', 'talk to someone', 'real person',
  'last time', 'switching to',
];

export const HUMAN_REQUEST_MARKERS = [
  'speak to a human', 'speak to a person', 'talk to someone', 'real person',
  'speak to a manager', 'call me', 'phone me',
];

/* -------------------------------------------------------------------------- */
/* (a) sentiment scoring                                                       */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): add negation handling ("not damaged"), token-level windows for
 * intensifiers, and emoji handling. Current version: substring matching with
 * a global intensifier multiplier — enough to score the demo inputs correctly.
 */
export function analyzeSentiment(intent: ReturnIntent): SentimentAnalysis {
  const text = intent.rawText.toLowerCase();
  const drivers: SentimentAnalysis['drivers'] = [];

  let negative = 0;
  for (const [term, weight] of Object.entries(NEGATIVE_TERMS)) {
    if (text.includes(term)) {
      negative += weight;
      drivers.push({ term, polarity: 'NEGATIVE', weight });
    }
  }

  let positive = 0;
  for (const [term, weight] of Object.entries(POSITIVE_TERMS)) {
    if (text.includes(term)) {
      positive += weight;
      drivers.push({ term, polarity: 'POSITIVE', weight });
    }
  }

  let multiplier = 1;
  for (const [term, factor] of Object.entries(INTENSIFIERS)) {
    if (text.includes(term)) {
      multiplier = Math.max(multiplier, factor);
      drivers.push({ term, polarity: 'INTENSIFIER', weight: factor });
    }
  }

  // Typographic intensity: shouting and exclamation density.
  const exclamations = (intent.rawText.match(/!/g) ?? []).length;
  const capsWords = (intent.rawText.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  const typographic = Math.min(0.5, exclamations * 0.1 + capsWords * 0.15);

  const raw = (positive - negative * multiplier - typographic) / 2;
  const score = Math.max(-1, Math.min(1, raw));
  const intensity = Math.min(1, (negative * multiplier + positive) / 2 + typographic);

  const label =
    score <= -0.6 ? 'VERY_NEGATIVE'
    : score <= -0.2 ? 'NEGATIVE'
    : score < 0.2 ? 'NEUTRAL'
    : score < 0.6 ? 'POSITIVE'
    : 'VERY_POSITIVE';

  return {
    label,
    score: Math.round(score * 100) / 100,
    intensity: Math.round(intensity * 100) / 100,
    emotions: deriveEmotions(text, score, intensity),
    drivers,
    detectedLanguage: 'en',
  };
}

/** TODO(owner): map lexicon hits to a richer emotion taxonomy. */
export function deriveEmotions(text: string, score: number, intensity: number): SentimentAnalysis['emotions'] {
  const emotions: SentimentAnalysis['emotions'] = [];
  if (score < -0.2) emotions.push({ emotion: 'FRUSTRATION', intensity: Math.min(1, intensity) });
  if (/furious|angry|unacceptable|appalled/.test(text)) emotions.push({ emotion: 'ANGER', intensity: Math.min(1, intensity + 0.1) });
  if (/damaged|broken|defective|cracked/.test(text)) emotions.push({ emotion: 'DISAPPOINTMENT', intensity: 0.6 });
  if (/urgent|asap|immediately|need it/.test(text)) emotions.push({ emotion: 'URGENCY', intensity: 0.7 });
  if (/confus|don't understand|unclear|why/.test(text)) emotions.push({ emotion: 'CONFUSION', intensity: 0.5 });
  if (emotions.length === 0) emotions.push({ emotion: 'NEUTRAL', intensity: 0.2 });
  return emotions.sort((a, b) => b.intensity - a.intensity);
}

/* -------------------------------------------------------------------------- */
/* (b) complaint severity                                                      */
/* -------------------------------------------------------------------------- */

/** TODO(owner): tune the escalation ladder against the demo scenarios. */
export function assessSeverity(
  intent: ReturnIntent,
  sentiment: SentimentAnalysis,
  ctx: CaseContext,
): { severity: ComplaintSeverity; threatMarkersFound: string[] } {
  const text = intent.rawText.toLowerCase();
  const threatMarkersFound = THREAT_MARKERS.filter((m) => text.includes(m));
  const unresolvedPrior = ctx.customer.recentInteractions.filter((i) => !i.resolved).length;
  const merchantFault = ['DAMAGED_ON_ARRIVAL', 'DEFECTIVE', 'WRONG_ITEM_SENT'].includes(intent.reason);

  let points = 0;
  if (sentiment.label === 'VERY_NEGATIVE') points += 3;
  else if (sentiment.label === 'NEGATIVE') points += 2;
  if (merchantFault) points += 1;
  if (threatMarkersFound.length > 0) points += 2;
  if (unresolvedPrior >= 2) points += 2;
  else if (unresolvedPrior === 1) points += 1;
  if (sentiment.intensity > 0.7) points += 1;

  const severity: ComplaintSeverity = points >= 6 ? 'CRITICAL' : points >= 4 ? 'HIGH' : points >= 2 ? 'MODERATE' : 'LOW';
  return { severity, threatMarkersFound };
}

/* -------------------------------------------------------------------------- */
/* (c) customer value                                                          */
/* -------------------------------------------------------------------------- */

export function assessCustomerValue(ctx: CaseContext, churnScore: number): CustomerValue {
  const c = ctx.customer;
  const isVip =
    c.lifetimeValueUsd >= ctx.policy.thresholds.vipLifetimeValueUsd ||
    c.flags.includes('VIP') ||
    c.loyaltyTier === 'PLATINUM' ||
    c.loyaltyTier === 'COSMIC_ELITE';
  const isHigh = !isVip && (c.loyaltyTier === 'GOLD' || c.lifetimeValueUsd >= ctx.policy.thresholds.vipLifetimeValueUsd * 0.5);

  // TODO(owner): replace with a real percentile from the customer fixture set.
  const valuePercentile = Math.min(100, Math.round((c.lifetimeValueUsd / 10000) * 100));

  return {
    loyaltyTier: c.loyaltyTier,
    lifetimeValueUsd: c.lifetimeValueUsd,
    tenureMonths: c.tenureMonths,
    lifetimeOrders: c.returnHistory.lifetimeOrders,
    valuePercentile,
    valueBand: isVip ? 'VIP' : isHigh ? 'HIGH' : 'STANDARD',
    revenueAtRiskUsd: Math.round((churnScore / 100) * c.lifetimeValueUsd * 100) / 100,
  };
}

/* -------------------------------------------------------------------------- */
/* (d) churn risk                                                              */
/* -------------------------------------------------------------------------- */

/** Weights sum to 1.0. Tune these — they are the model. */
export const CHURN_WEIGHTS = {
  sentiment: 0.35,
  severity: 0.25,
  unresolvedHistory: 0.15,
  npsSignal: 0.15,
  complaintRecency: 0.1,
} as const;

/** TODO(owner): validate the weighting against the seven demo scenarios. */
export function scoreChurnRisk(
  ctx: CaseContext,
  sentiment: SentimentAnalysis,
  severity: ComplaintSeverity,
): ChurnRisk {
  const c = ctx.customer;
  const drivers: ChurnRisk['drivers'] = [];

  // Each sub-score is 0-100, then weighted.
  const negativity = Math.max(0, -sentiment.score) * 100;
  const severityScore = { LOW: 10, MODERATE: 40, HIGH: 75, CRITICAL: 100 }[severity];
  const unresolved = Math.min(100, c.recentInteractions.filter((i) => !i.resolved).length * 40);
  const npsScore = c.lastNpsScore === null ? 40 : Math.max(0, (6 - c.lastNpsScore) * 20);
  const lastComplaint = c.recentInteractions
    .filter((i) => i.sentimentScore < 0)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const recency = lastComplaint ? Math.max(0, 100 - daysBetween(lastComplaint.occurredAt, ctx.now) * 2) : 0;

  const parts: [keyof typeof CHURN_WEIGHTS, number, string][] = [
    ['sentiment', negativity, `Message sentiment scored ${sentiment.score}`],
    ['severity', severityScore, `Complaint severity is ${severity}`],
    ['unresolvedHistory', unresolved, `${c.recentInteractions.filter((i) => !i.resolved).length} unresolved prior interaction(s)`],
    ['npsSignal', npsScore, c.lastNpsScore === null ? 'No recent NPS response' : `Last NPS score was ${c.lastNpsScore}`],
    ['complaintRecency', recency, lastComplaint ? `Last negative interaction ${daysBetween(lastComplaint.occurredAt, ctx.now)} day(s) ago` : 'No recent negative interactions'],
  ];

  let score = 0;
  for (const [key, value, detail] of parts) {
    const contribution = value * CHURN_WEIGHTS[key];
    score += contribution;
    drivers.push({ factor: key, contribution: Math.round(contribution * 10) / 10, detail });
  }

  // High tiers are stickier — dampen, but they cost more when they do leave.
  const tierDamping = { STANDARD: 1.0, SILVER: 0.95, GOLD: 0.9, PLATINUM: 0.85, COSMIC_ELITE: 0.8 }[c.loyaltyTier];
  score = Math.min(100, Math.round(score * tierDamping));

  return {
    score,
    band: score >= 75 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW',
    drivers,
    churnProbability: Math.round((score / 100) * 0.85 * 100) / 100,
    };
}

/* -------------------------------------------------------------------------- */
/* (e) retention gestures                                                      */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): expand the gesture catalogue and the sizing curve. The demo
 * requires that a GOLD customer with a damaged high-value item is offered
 * 500 bonus points.
 */
export function recommendGestures(
  ctx: CaseContext,
  churn: ChurnRisk,
  severity: ComplaintSeverity,
  value: CustomerValue,
  budgetUsd: number,
): RetentionGesture[] {
  const gestures: RetentionGesture[] = [];
  const multiplier = ctx.policy.tierBenefit.pointsMultiplier;

  // Bonus points: the cheapest high-perceived-value gesture. 100 points ~ $1.
  if (severity !== 'LOW' || churn.band !== 'LOW') {
    const basePoints = severity === 'CRITICAL' ? 1000 : severity === 'HIGH' ? 500 : 250;
    const points = Math.round(basePoints * multiplier);
    gestures.push({
      type: 'BONUS_POINTS',
      value: points,
      unit: 'POINTS',
      estimatedCostUsd: Math.round((points / 100) * 100) / 100,
      expectedChurnReduction: severity === 'CRITICAL' ? 20 : 15,
      priority: 1,
      rationale: `${points} Cosmic Rewards points acknowledge the inconvenience at low cost to the business (${value.loyaltyTier} tier multiplier ${multiplier}x).`,
    });
  }

  // Free expedited shipping on the replacement — high perceived value.
  if (severity === 'HIGH' || severity === 'CRITICAL') {
    gestures.push({
      type: 'FREE_EXPEDITED_SHIPPING',
      value: 0,
      unit: 'NONE',
      estimatedCostUsd: 12,
      expectedChurnReduction: 10,
      priority: 2,
      rationale: 'Expedited delivery of the replacement shortens the time the customer is without the product.',
    });
  }

  // A human call for the highest-risk, highest-value combinations.
  if (severity === 'CRITICAL' || (churn.band === 'CRITICAL' && value.valueBand === 'VIP')) {
    gestures.push({
      type: 'HUMAN_CALLBACK',
      value: 0,
      unit: 'NONE',
      estimatedCostUsd: 18,
      expectedChurnReduction: 25,
      priority: 1,
      rationale: 'A personal call from the retention desk is warranted given the severity and the customer’s value.',
    });
  }

  // Keep only what fits the budget, highest priority first.
  let spent = 0;
  return gestures
    .sort((a, b) => a.priority - b.priority)
    .filter((g) => {
      if (spent + g.estimatedCostUsd > budgetUsd) return false;
      spent += g.estimatedCostUsd;
      return true;
    });
}

/** Budget = tier allowance scaled by severity, capped at 15% of LTV. */
export function computeGoodwillBudget(ctx: CaseContext, severity: ComplaintSeverity): number {
  const base = ctx.policy.tierBenefit.goodwillBudgetUsd;
  const scale = { LOW: 0.25, MODERATE: 0.5, HIGH: 1.0, CRITICAL: 1.5 }[severity];
  const cap = ctx.customer.lifetimeValueUsd * 0.15;
  return Math.round(Math.min(base * scale, cap) * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* (f) social risk                                                             */
/* -------------------------------------------------------------------------- */

/** TODO(owner): incorporate public-review propensity by region/tier. */
export function assessSocialRisk(
  ctx: CaseContext,
  severity: ComplaintSeverity,
  threatMarkers: string[],
): { likelihood: number; priorPublicComplaints: number } {
  const priorPublicComplaints = ctx.customer.recentInteractions.filter((i) => i.escalatedPublicly).length;
  const severityWeight = { LOW: 0.05, MODERATE: 0.2, HIGH: 0.45, CRITICAL: 0.75 }[severity];
  const threatWeight = threatMarkers.some((m) => /review|social|twitter|trustpilot|post about/.test(m)) ? 0.3 : 0;
  const historyWeight = Math.min(0.3, priorPublicComplaints * 0.15);
  return {
    likelihood: Math.round(Math.min(1, severityWeight + threatWeight + historyWeight) * 100) / 100,
    priorPublicComplaints,
  };
}
