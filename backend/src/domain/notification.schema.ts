/**
 * DATA MODEL: Notification / Message
 *
 * Produced by the Communication Agent. Nothing is actually sent — messages are
 * written to an in-memory outbox that the demo UI renders as an inbox.
 */
import { z } from 'zod';
import { ChannelSchema, IsoDateTimeSchema } from './common.schema';

/** Lifecycle moments the customer is proactively told about. Mirrors the PRD:
 *  "request received, resolution approved, pickup scheduled, refund processed,
 *  item shipped". */
export const NotificationTriggerSchema = z.enum([
  'REQUEST_RECEIVED',
  'CLARIFICATION_NEEDED',
  'RESOLUTION_APPROVED',
  'RESOLUTION_DENIED',
  'AWAITING_HUMAN_REVIEW',
  'LABEL_READY',
  'PICKUP_SCHEDULED',
  'PICKUP_REMINDER',
  'IN_TRANSIT',
  'ITEM_RECEIVED',
  'REFUND_PROCESSED',
  'REPLACEMENT_SHIPPED',
  'GOODWILL_GRANTED',
  'SUSTAINABILITY_SUMMARY',
  'CASE_CLOSED',
]);
export type NotificationTrigger = z.infer<typeof NotificationTriggerSchema>;

/** Tone is selected from the Sentiment Agent's output — an angry customer must
 *  never receive a cheerful template. */
export const MessageToneSchema = z.enum(['EMPATHETIC', 'APOLOGETIC', 'NEUTRAL_INFORMATIVE', 'REASSURING', 'CELEBRATORY']);
export type MessageTone = z.infer<typeof MessageToneSchema>;

export const MessageStatusSchema = z.enum(['DRAFT', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const NotificationTemplateSchema = z.object({
  templateId: z.string().describe('e.g. TPL_RESOLUTION_APPROVED_EMPATHETIC'),
  trigger: NotificationTriggerSchema,
  channel: ChannelSchema,
  tone: MessageToneSchema,
  locale: z.string().default('en-US'),
  subject: z.string().nullable().default(null),
  /** Handlebars-ish `{{variable}}` placeholders. */
  bodyTemplate: z.string(),
  /** Variables the template requires; validated before render. */
  requiredVariables: z.array(z.string()).default([]),
  maxLength: z.number().int().positive().nullable().default(null).describe('SMS limit etc.'),
});
export type NotificationTemplate = z.infer<typeof NotificationTemplateSchema>;

export const NotificationSchema = z.object({
  messageId: z.string().describe('e.g. MSG-000001'),
  caseId: z.string(),
  customerId: z.string(),

  trigger: NotificationTriggerSchema,
  channel: ChannelSchema,
  tone: MessageToneSchema,
  templateId: z.string(),
  locale: z.string().default('en-US'),

  subject: z.string().nullable().default(null),
  /** Fully rendered, ready-to-display body. */
  body: z.string(),
  /** Values substituted into the template — kept for audit/debug. */
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),

  status: MessageStatusSchema,
  /** Future-dated for scheduled nudges (e.g. pickup reminder). */
  scheduledFor: IsoDateTimeSchema,
  sentAt: IsoDateTimeSchema.nullable().default(null),
  /** Set when suppressed, e.g. "quiet hours" or "channel not opted in". */
  suppressionReason: z.string().nullable().default(null),

  /** Deep link the customer taps. */
  actionUrl: z.string().nullable().default(null),
  actionLabel: z.string().nullable().default(null),

  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;
