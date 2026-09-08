/**
 * DATA MODEL: Customer
 *
 * Consumed by the Sentiment & Retention Agent (value/churn signals) and the
 * Eligibility Agent (tier-based window extensions).
 */
import { z } from 'zod';
import {
  AddressSchema,
  ChannelSchema,
  IsoDateTimeSchema,
  LoyaltyTierSchema,
  RegionCodeSchema,
} from './common.schema';

/** Rolling behavioural counters. The Eligibility Agent reads these for fraud
 *  signals; the Sentiment Agent reads them for churn risk. Pre-aggregated in
 *  fixtures because the demo has no real event history to roll up. */
export const CustomerReturnHistorySchema = z.object({
  lifetimeOrders: z.number().int().nonnegative(),
  lifetimeReturns: z.number().int().nonnegative(),
  returnsLast90Days: z.number().int().nonnegative(),
  /** lifetimeReturns / lifetimeOrders, 0-1. */
  returnRate: z.number().min(0).max(1),
  /** Returns later found to be abusive/fraudulent. */
  disputedReturns: z.number().int().nonnegative().default(0),
  lastReturnAt: IsoDateTimeSchema.nullable().default(null),
});
export type CustomerReturnHistory = z.infer<typeof CustomerReturnHistorySchema>;

export const SupportInteractionSchema = z.object({
  interactionId: z.string(),
  occurredAt: IsoDateTimeSchema,
  channel: ChannelSchema,
  topic: z.string(),
  /** -1 (very negative) .. +1 (very positive). */
  sentimentScore: z.number().min(-1).max(1),
  resolved: z.boolean(),
  /** True if the customer complained publicly (social/review) about this. */
  escalatedPublicly: z.boolean().default(false),
});
export type SupportInteraction = z.infer<typeof SupportInteractionSchema>;

export const CommunicationPreferencesSchema = z.object({
  preferredChannel: ChannelSchema.default('EMAIL'),
  allowedChannels: z.array(ChannelSchema).min(1),
  locale: z.string().default('en-US'),
  timezone: z.string().default('America/New_York'),
  /** Local-time window during which non-urgent messages must not be sent. */
  quietHours: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .nullable()
    .default(null),
  marketingOptIn: z.boolean().default(false),
});
export type CommunicationPreferences = z.infer<typeof CommunicationPreferencesSchema>;

export const CustomerSchema = z.object({
  customerId: z.string().describe('e.g. CUST-001001'),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable().default(null),

  loyaltyTier: LoyaltyTierSchema,
  loyaltyPoints: z.number().int().nonnegative().default(0),
  /** Total historical revenue attributable to this customer. */
  lifetimeValueUsd: z.number().nonnegative(),
  /** Months since account creation — a tenure signal for churn scoring. */
  tenureMonths: z.number().int().nonnegative(),
  memberSince: IsoDateTimeSchema,

  regionCode: RegionCodeSchema,
  defaultAddress: AddressSchema,

  returnHistory: CustomerReturnHistorySchema,
  recentInteractions: z.array(SupportInteractionSchema).default([]),
  communicationPreferences: CommunicationPreferencesSchema,

  /** Net Promoter Score from the last survey, if any. */
  lastNpsScore: z.number().int().min(0).max(10).nullable().default(null),
  /** Operational flags set by prior investigations. */
  flags: z
    .array(z.enum(['VIP', 'FRAUD_WATCHLIST', 'CHARGEBACK_HISTORY', 'ACCESSIBILITY_NEEDS', 'B2B']))
    .default([]),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Customer = z.infer<typeof CustomerSchema>;
