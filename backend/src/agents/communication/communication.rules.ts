/**
 * COMMUNICATION RULES — pure functions.
 *
 * OWNER: <assign>
 * STATUS: wireframe. Channel planning, tone guardrails, template lookup and
 * variable binding are implemented; localization and the full template library
 * are TODO (templates live in mocks/fixtures/notification-templates.json).
 */
import type { CaseContext } from '../../domain/case-context.schema';
import type { Channel } from '../../domain/common.schema';
import type { MessageTone, NotificationTemplate, NotificationTrigger } from '../../domain/notification.schema';
import { addHours } from '../../core/clock';
import type { ChannelPlan } from './communication.contract';

/** Fallback preference order when the customer has no stated preference. */
export const CHANNEL_PRIORITY: Channel[] = ['EMAIL', 'SMS', 'PUSH', 'IN_APP', 'WHATSAPP', 'VOICE'];

/* -------------------------------------------------------------------------- */
/* STEP 1 — channel plan                                                      */
/* -------------------------------------------------------------------------- */

export function planChannels(ctx: CaseContext, urgency: string): ChannelPlan {
  const prefs = ctx.customer.communicationPreferences;
  const allowed = new Set(prefs.allowedChannels);
  const excluded: ChannelPlan['excluded'] = [];

  for (const ch of CHANNEL_PRIORITY) {
    if (!allowed.has(ch)) {
      excluded.push({ channel: ch, reason: 'Customer has not opted in to this channel.' });
      continue;
    }
    if (ch === 'SMS' && !ctx.customer.phone) {
      excluded.push({ channel: ch, reason: 'No phone number on file.' });
      allowed.delete(ch);
    }
    if (ch === 'VOICE' && !ctx.customer.phone) {
      excluded.push({ channel: ch, reason: 'No phone number on file.' });
      allowed.delete(ch);
    }
  }

  const usable = CHANNEL_PRIORITY.filter((c) => allowed.has(c));
  const primary = allowed.has(prefs.preferredChannel) ? prefs.preferredChannel : (usable[0] ?? 'EMAIL');

  // Urgent cases add SMS even when it is not the stated preference.
  const fallbacks = usable.filter((c) => c !== primary);
  if (urgency === 'IMMEDIATE' && allowed.has('SMS') && primary !== 'SMS') fallbacks.unshift('SMS');

  return {
    primary,
    fallbacks,
    excluded,
    quietHoursApplied: false, // set by scheduleSendTime when it actually shifts
    locale: prefs.locale,
  };
}

/* -------------------------------------------------------------------------- */
/* STEP 2 — tone guardrail                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A cheerful message to a furious customer is the single worst failure mode
 * available to this agent, so the guardrail is unconditional.
 */
export function applyToneGuardrail(
  requested: MessageTone,
  severity: string,
): { tone: MessageTone; overrideReason: string | null } {
  if (requested === 'CELEBRATORY' && (severity === 'HIGH' || severity === 'CRITICAL')) {
    return {
      tone: 'REASSURING',
      overrideReason: `Celebratory tone suppressed: complaint severity is ${severity}.`,
    };
  }
  return { tone: requested, overrideReason: null };
}

/* -------------------------------------------------------------------------- */
/* STEP 3 — template lookup                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Progressive relaxation: exact match -> any locale -> any tone -> any channel.
 * Returns null rather than throwing; a missing template is a warning.
 */
export function findTemplate(
  templates: NotificationTemplate[],
  key: { trigger: NotificationTrigger; channel: Channel; tone: MessageTone; locale: string },
): NotificationTemplate | null {
  const candidates = templates.filter((t) => t.trigger === key.trigger);
  return (
    candidates.find((t) => t.channel === key.channel && t.tone === key.tone && t.locale === key.locale) ??
    candidates.find((t) => t.channel === key.channel && t.tone === key.tone) ??
    candidates.find((t) => t.channel === key.channel) ??
    candidates.find((t) => t.tone === key.tone) ??
    candidates[0] ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* STEP 4 — variable binding and rendering                                    */
/* -------------------------------------------------------------------------- */

export type TemplateVars = Record<string, string | number | boolean>;

/**
 * Renders `{{placeholders}}`. Returns the rendered body plus any variables the
 * template needed but did not get — the caller must NEVER ship a message with
 * unresolved placeholders.
 */
export function render(template: string, vars: TemplateVars): { body: string; missing: string[] } {
  const missing: string[] = [];
  const body = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    if (name in vars && vars[name] !== undefined && vars[name] !== null && vars[name] !== '') {
      return String(vars[name]);
    }
    missing.push(name);
    return '';
  });
  // Collapse the whitespace left behind by removed placeholders.
  return { body: body.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim(), missing };
}

/** Truncates SMS/push bodies to the template's declared limit. */
export function enforceLength(body: string, maxLength: number | null): string {
  if (maxLength === null || body.length <= maxLength) return body;
  return `${body.slice(0, Math.max(0, maxLength - 3))}...`;
}

/* -------------------------------------------------------------------------- */
/* STEP 5 — send timing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Shifts a send time out of quiet hours.
 * TODO(owner): do this in the customer's timezone rather than UTC.
 */
export function scheduleSendTime(
  ctx: CaseContext,
  baseIso: string,
  urgent: boolean,
): { sendAt: string; shifted: boolean } {
  const quiet = ctx.customer.communicationPreferences.quietHours;
  if (!quiet || urgent) return { sendAt: baseIso, shifted: false };

  const d = new Date(baseIso);
  const hour = d.getUTCHours();
  const inQuiet =
    quiet.startHour <= quiet.endHour
      ? hour >= quiet.startHour && hour < quiet.endHour
      : hour >= quiet.startHour || hour < quiet.endHour; // window wraps midnight

  if (!inQuiet) return { sendAt: baseIso, shifted: false };

  const shiftedDate = new Date(d);
  shiftedDate.setUTCHours(quiet.endHour, 0, 0, 0);
  if (shiftedDate <= d) shiftedDate.setUTCDate(shiftedDate.getUTCDate() + 1);
  return { sendAt: shiftedDate.toISOString(), shifted: true };
}

/** The follow-up sequence committed to at case creation. */
export function buildFollowUpSchedule(
  ctx: CaseContext,
  opts: { hasPickup: boolean; pickupWindowStart: string | null; transitDays: number; isRefund: boolean; isReplacement: boolean },
): { trigger: NotificationTrigger; offsetHours: number; description: string }[] {
  const seq: { trigger: NotificationTrigger; offsetHours: number; description: string }[] = [];

  if (opts.hasPickup && opts.pickupWindowStart) {
    seq.push({ trigger: 'PICKUP_REMINDER', offsetHours: -12, description: 'Reminder the evening before collection.' });
  }
  seq.push({ trigger: 'IN_TRANSIT', offsetHours: 24, description: 'Confirmation the parcel is on its way.' });
  seq.push({ trigger: 'ITEM_RECEIVED', offsetHours: Math.max(24, opts.transitDays * 24), description: 'Confirmation the item reached our facility.' });
  if (opts.isRefund) seq.push({ trigger: 'REFUND_PROCESSED', offsetHours: Math.max(48, opts.transitDays * 24 + 24), description: 'Refund issued.' });
  if (opts.isReplacement) seq.push({ trigger: 'REPLACEMENT_SHIPPED', offsetHours: 24, description: 'Replacement dispatched with tracking.' });
  seq.push({ trigger: 'CASE_CLOSED', offsetHours: Math.max(72, opts.transitDays * 24 + 48), description: 'Case closed with a satisfaction check.' });

  return seq;
}

export const offsetToIso = (baseIso: string, offsetHours: number): string => addHours(baseIso, offsetHours).toISOString();
