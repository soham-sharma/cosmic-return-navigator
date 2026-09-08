/**
 * FINALIZER — stage 6, owned by the orchestrator.
 *
 * Two jobs:
 *   1. PERSIST the business records the agents described (Return, Resolution,
 *      Shipment, SustainabilityRecord, Notifications, Insights). Agents produce
 *      DESCRIPTIONS; only the orchestrator commits them, which is what keeps
 *      agent re-runs side-effect free.
 *   2. PROJECT the seven agent outputs into one flat `FinalOutcome` so the API
 *      and UI never have to re-derive "what happened".
 */
import { clock, addHours } from '../core/clock';
import { newId } from '../core/ids';
import { db } from '../repositories/db';
import type { ReturnCase, FinalOutcome, CaseStatus } from '../domain/case-state.schema';
import type { Return } from '../domain/return.schema';
import type { Resolution } from '../domain/resolution.schema';
import { AGENT_IDS } from '../domain/agent.schema';

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export interface PersistedIds {
  returnId: string | null;
  resolutionId: string | null;
  shipmentId: string | null;
  sustainabilityRecordId: string | null;
  notificationIds: string[];
  insightIds: string[];
}

/**
 * Commits every record described by the agents. Idempotent per case: called
 * once at finalize time.
 */
export function persistRecords(c: ReturnCase): PersistedIds {
  const now = clock.nowIso();
  const ids: PersistedIds = {
    returnId: null,
    resolutionId: null,
    shipmentId: null,
    sustainabilityRecordId: null,
    notificationIds: [],
    insightIds: [],
  };

  const { intent, context } = c;
  const eligibility = c.agentResults.eligibility?.output ?? null;
  const resolutionOut = c.agentResults.resolution?.output ?? null;
  const logisticsOut = c.agentResults.logistics?.output ?? null;
  const sustainabilityOut = c.agentResults.sustainability?.output ?? null;
  const communicationOut = c.agentResults.communication?.output ?? null;
  const insightsOut = c.agentResults.insights?.output ?? null;

  if (!intent || !context) return ids;

  /* -- 1. Return record --------------------------------------------------- */
  const returnRecord: Return = {
    returnId: newId('returnRequest'),
    caseId: c.caseId,
    customerId: context.customer.customerId,
    orderId: context.order.orderId,
    orderItemId: context.orderItem.orderItemId,
    sku: context.product.sku,
    quantity: intent.quantity,
    reason: eligibility?.normalizedReason ?? intent.reason,
    reasonDetail: intent.rawText,
    faultAttribution: eligibility?.faultAttribution ?? intent.faultAttribution,
    reportedCondition: intent.reportedCondition,
    requestedOutcome: intent.requestedOutcome,
    status: deriveReturnStatus(c),
    declaredValueUsd: Math.round(context.orderItem.unitPriceUsd * intent.quantity * 100) / 100,
    regionCode: context.regionCode,
    resolutionId: null,
    shipmentId: null,
    sustainabilityRecordId: null,
    evidenceUrls: [],
    submittedAt: c.createdAt,
    slaDueAt: resolutionOut ? addHours(now, resolutionOut.slaHours).toISOString() : null,
    closedAt: null,
    createdAt: c.createdAt,
    updatedAt: now,
  };
  ids.returnId = returnRecord.returnId;

  /* -- 2. Resolution ------------------------------------------------------ */
  if (resolutionOut) {
    const resolution: Resolution = {
      resolutionId: newId('resolution'),
      caseId: c.caseId,
      returnId: returnRecord.returnId,
      status: resolutionOut.requiresHumanApproval ? 'AWAITING_APPROVAL' : 'APPROVED',
      selected: resolutionOut.recommended,
      alternatives: resolutionOut.alternatives,
      goodwill: resolutionOut.goodwill,
      totalCostUsd: resolutionOut.costs.netCostUsd,
      estimatedRetainedValueUsd: resolutionOut.estimatedRetainedValueUsd,
      requiresHumanApproval: resolutionOut.requiresHumanApproval,
      approvedBy: resolutionOut.requiresHumanApproval ? null : 'ORCHESTRATOR_AUTO',
      approvedAt: resolutionOut.requiresHumanApproval ? null : now,
      overrideReason: null,
      rationale: c.agentResults.resolution?.rationale ?? resolutionOut.internalRationale,
      confidence: c.agentResults.resolution?.confidence ?? 0.9,
      slaDueAt: returnRecord.slaDueAt,
      createdAt: now,
      updatedAt: now,
    };
    db.resolutions.insert(resolution);
    ids.resolutionId = resolution.resolutionId;
    returnRecord.resolutionId = resolution.resolutionId;
  }

  /* -- 3. Shipment -------------------------------------------------------- */
  if (logisticsOut?.shipment) {
    // Stamp the return link the agent could not know at build time.
    const shipment = { ...logisticsOut.shipment, returnId: returnRecord.returnId, updatedAt: now };
    db.shipments.insert(shipment);
    ids.shipmentId = shipment.shipmentId;
    returnRecord.shipmentId = shipment.shipmentId;
  }
  if (logisticsOut?.outboundShipment) {
    db.shipments.insert({ ...logisticsOut.outboundShipment, returnId: returnRecord.returnId, updatedAt: now });
  }

  /* -- 4. Sustainability record ------------------------------------------- */
  if (sustainabilityOut) {
    const record = { ...sustainabilityOut.record, returnId: returnRecord.returnId };
    db.sustainabilityRecords.insert(record);
    ids.sustainabilityRecordId = record.recordId;
    returnRecord.sustainabilityRecordId = record.recordId;
  }

  /* -- 5. Notifications (into the mock outbox) ---------------------------- */
  if (communicationOut) {
    for (const message of communicationOut.messages) {
      // Demo behaviour: immediate messages are marked SENT so the UI shows a
      // populated inbox rather than a queue.
      db.notifications.insert({ ...message, status: 'SENT', sentAt: now });
      ids.notificationIds.push(message.messageId);
    }
  }

  /* -- 6. Insights (create or reinforce) ---------------------------------- */
  if (insightsOut) {
    for (const insight of insightsOut.insights) {
      // Dedupe against open insights with the same (type, sku, region): bump
      // the existing one rather than flooding the board with duplicates.
      const existing = db.insights.findOne(
        (i) =>
          i.type === insight.type &&
          i.sku === insight.sku &&
          i.regionCode === insight.regionCode &&
          i.status !== 'DISMISSED' &&
          i.status !== 'ACTIONED',
      );

      if (existing) {
        db.insights.update(existing.insightId, {
          lastObservedAt: now,
          observationCount: existing.observationCount + 1,
          contributingCaseIds: [...new Set([...existing.contributingCaseIds, c.caseId])],
          // Reinforcement can only raise severity, never lower it.
          severity: severityRank(insight.severity) > severityRank(existing.severity) ? insight.severity : existing.severity,
          priorityScore: Math.max(existing.priorityScore, insight.priorityScore),
          updatedAt: now,
        });
        ids.insightIds.push(existing.insightId);
      } else {
        db.insights.insert({ ...insight, contributingCaseIds: [c.caseId] });
        ids.insightIds.push(insight.insightId);
      }
    }
  }

  db.returns.insert(returnRecord);
  return ids;
}

const SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const severityRank = (s: string) => SEVERITY_ORDER.indexOf(s);

function deriveReturnStatus(c: ReturnCase): Return['status'] {
  const eligibility = c.agentResults.eligibility?.output;
  const resolution = c.agentResults.resolution?.output;
  const logistics = c.agentResults.logistics?.output;

  if (c.escalations.some((e) => e.blocking && e.resolvedAt === null)) return 'ESCALATED';
  if (eligibility?.decision === 'DENIED' && resolution?.recommended.type === 'DENY') return 'REJECTED';
  if (eligibility?.decision === 'MANUAL_REVIEW') return 'UNDER_REVIEW';
  if (resolution && !resolution.requiresReturnShipment) return 'RESOLVED';
  if (logistics?.pickup || logistics?.label) return 'AWAITING_SHIPMENT';
  if (resolution) return 'APPROVED';
  return 'SUBMITTED';
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Flattens the case into the answer to "what happened?".
 * Also decides the terminal `CaseStatus`.
 */
export function buildFinalOutcome(c: ReturnCase): { outcome: FinalOutcome; status: CaseStatus } {
  const eligibility = c.agentResults.eligibility?.output ?? null;
  const resolution = c.agentResults.resolution?.output ?? null;
  const logistics = c.agentResults.logistics?.output ?? null;
  const sustainability = c.agentResults.sustainability?.output ?? null;
  const communication = c.agentResults.communication?.output ?? null;

  const blocking = c.escalations.filter((e) => e.blocking && e.resolvedAt === null);
  const humanInvolved = blocking.length > 0 || (resolution?.requiresHumanApproval ?? false) || c.humanDecisions.length > 0;

  const status: CaseStatus =
    blocking.length > 0
      ? 'ESCALATED'
      : eligibility?.decision === 'DENIED' && resolution?.recommended.type === 'DENY'
        ? 'DENIED'
        : 'COMPLETED';

  const points = resolution?.goodwill.find((g) => g.unit === 'POINTS')?.value ?? null;

  const outcome: FinalOutcome = {
    customerMessage:
      communication?.primaryCustomerResponse ??
      'We have received your return request and a specialist will be in touch shortly.',
    headline:
      communication?.headline ??
      (resolution ? `${resolution.recommended.type.replace(/_/g, ' ').toLowerCase()} for ${c.context?.product.name ?? 'your item'}` : 'Return request received'),

    resolutionType: resolution?.recommended.type ?? (blocking.length > 0 ? 'ESCALATE' : 'PENDING'),
    resolutionSummary: resolution?.customerFacingSummary ?? eligibility?.customerFacingSummary ?? 'Pending review.',
    refundAmountUsd: resolution?.recommended.refundAmountUsd ?? resolution?.recommended.storeCreditAmountUsd ?? null,
    pointsAwarded: points,
    replacementSku: resolution?.recommended.replacementSku ?? null,

    returnMethod: logistics?.method ?? null,
    pickupScheduledFor: logistics?.pickup?.windowStart ?? null,
    trackingNumber: logistics?.label?.trackingNumber ?? null,
    labelUrl: logistics?.label?.labelUrl ?? null,

    co2PreventedKg: sustainability?.co2PreventedKg ?? null,
    sustainabilityGrade: sustainability?.grade ?? null,

    totalCostUsd: resolution?.costs.netCostUsd ?? null,
    slaDueAt: resolution ? addHours(clock.nowIso(), resolution.slaHours).toISOString() : null,

    fullyAutomated: !humanInvolved,
    nextSteps: buildNextSteps(c),
    // Ordered by pipeline stage so the "how we decided" panel reads top to bottom.
    agentRationales: AGENT_IDS.flatMap((id) => {
      const result = c.agentResults[id];
      return result ? [{ agentId: id, rationale: result.rationale }] : [];
    }),
    finalizedAt: clock.nowIso(),
  };

  return { outcome, status };
}

/** Customer-facing checklist. Only actions the customer must actually take. */
function buildNextSteps(c: ReturnCase): string[] {
  const steps: string[] = [];
  const eligibility = c.agentResults.eligibility?.output;
  const logistics = c.agentResults.logistics?.output;
  const resolution = c.agentResults.resolution?.output;
  const sustainability = c.agentResults.sustainability?.output;

  if (c.escalations.some((e) => e.blocking && e.resolvedAt === null)) {
    return ['Nothing to do — a Cosmic specialist is reviewing your case and will contact you.'];
  }

  for (const condition of eligibility?.conditions ?? []) {
    if (condition.code === 'PHOTO_EVIDENCE') steps.push('Upload a photo of the damage.');
    if (condition.code === 'ORIGINAL_PACKAGING') steps.push('Pack the item in its original packaging.');
    if (condition.code === 'ALL_ACCESSORIES') steps.push('Include all accessories in the box.');
  }

  if (logistics?.required === false) {
    steps.push('Keep the item — no need to send anything back.');
  } else if (logistics?.pickup) {
    steps.push(`Leave the parcel out for collection on ${logistics.pickup.scheduledDate} between 09:00 and 13:00.`);
    if (sustainability?.packaging.reuseOriginalBox) steps.push('Reuse the box your order arrived in.');
    if (logistics.label?.requiresPrinting) steps.push('Print and attach the return label.');
    else steps.push('No printing needed — the driver will scan the code from your phone.');
  } else if (logistics?.required) {
    steps.push(logistics.customerFacingSummary);
  }

  if (resolution?.requiresReturnShipment) {
    steps.push(`We will confirm your ${resolution.recommended.type.replace(/_/g, ' ').toLowerCase()} once the item reaches us.`);
  }

  return steps.length ? steps : ['Nothing further is needed from you — we will keep you posted.'];
}
