/**
 * Shared primitives used by every other schema.
 *
 * CONVENTION (applies to the whole codebase):
 *   - Zod schema is the single source of truth; the TS type is `z.infer`red.
 *     Never hand-write a parallel interface — it will drift.
 *   - Monetary values are numbers in the currency's major unit (USD dollars),
 *     rounded to 2dp. Good enough for a demo; a real system would use minor
 *     units (cents) as integers.
 *   - All timestamps are ISO-8601 UTC strings.
 */
import { z } from 'zod';

/* ------------------------------- Scalars ---------------------------------- */

export const IsoDateTimeSchema = z.string().datetime({ offset: true }).describe('ISO-8601 UTC timestamp');
export const UsdSchema = z.number().describe('Amount in USD (major unit, 2dp)');
export const ScoreSchema = z.number().min(0).max(100).describe('Normalized score 0-100');
export const UnitScoreSchema = z.number().min(0).max(1).describe('Normalized score 0-1');
export const ConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .describe('Agent self-reported confidence in its own output');

export const CurrencySchema = z.enum(['USD', 'EUR', 'GBP', 'INR', 'JPY']);
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.object({
  amount: z.number(),
  currency: CurrencySchema.default('USD'),
});
export type Money = z.infer<typeof MoneySchema>;

/* ------------------------------- Geography -------------------------------- */

/**
 * Region codes drive consumer-protection rules in the Eligibility Agent.
 * EU/UK carry statutory minimum withdrawal windows that override store policy.
 */
export const RegionCodeSchema = z.enum([
  'NA_US',
  'NA_CA',
  'EU_DE',
  'EU_FR',
  'UK',
  'APAC_IN',
  'APAC_JP',
  'APAC_AU',
]);
export type RegionCode = z.infer<typeof RegionCodeSchema>;

export const AddressSchema = z.object({
  line1: z.string(),
  line2: z.string().nullable().default(null),
  city: z.string(),
  state: z.string().nullable().default(null),
  postalCode: z.string(),
  countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2'),
  regionCode: RegionCodeSchema,
  /** Drives carrier coverage checks in the Logistics Agent. */
  isRemote: z.boolean().default(false),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
});
export type Address = z.infer<typeof AddressSchema>;

/* -------------------------------- Customer -------------------------------- */

/**
 * Cosmic Rewards tiers. Tier unlocks return-window extensions and larger
 * goodwill budgets — the mechanism behind the "retention override" edge case.
 */
export const LoyaltyTierSchema = z.enum(['STANDARD', 'SILVER', 'GOLD', 'PLATINUM', 'COSMIC_ELITE']);
export type LoyaltyTier = z.infer<typeof LoyaltyTierSchema>;

/* ------------------------------- Channels --------------------------------- */

export const ChannelSchema = z.enum(['EMAIL', 'SMS', 'PUSH', 'IN_APP', 'WHATSAPP', 'VOICE']);
export type Channel = z.infer<typeof ChannelSchema>;

/* ------------------------- Explainability primitives ---------------------- */

/**
 * The PRD makes explainability a hard non-functional requirement: "every agent
 * decision includes a human-readable rationale". Agents express their reasoning
 * as a list of `RuleEvaluation`s plus one summary sentence, so the UI can render
 * both a headline and a drill-down.
 */
export const RuleOutcomeSchema = z.enum(['PASS', 'FAIL', 'WAIVED', 'NOT_APPLICABLE', 'WARN']);
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;

export const RuleEvaluationSchema = z.object({
  ruleId: z.string().describe('Stable identifier, e.g. ELG_RETURN_WINDOW'),
  ruleName: z.string().describe('Human-readable rule label for the UI'),
  outcome: RuleOutcomeSchema,
  /** One sentence explaining why this rule produced this outcome. */
  detail: z.string(),
  /** Optional machine-readable inputs the rule looked at (for the drill-down). */
  observed: z.record(z.string(), z.unknown()).optional(),
  /** If WAIVED, what authority waived it. */
  waivedBy: z.enum(['LOYALTY_TIER', 'REGIONAL_LAW', 'DAMAGE_ON_ARRIVAL', 'HUMAN_OVERRIDE']).nullable().default(null),
});
export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;

/* ------------------------------ Pagination -------------------------------- */

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']).default('desc');
