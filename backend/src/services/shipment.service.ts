/**
 * SHIPMENT SERVICE — mocked carrier tracking.
 *
 * OWNER: <assign — pairs with the Logistics Agent owner>
 *
 * The Logistics Agent seeds a tracking timeline with a couple of real events
 * plus several PROJECTED ones. `advanceShipment` promotes the next projected
 * event to actual, which is what lets a presenter walk a parcel through its
 * whole journey on stage without waiting days.
 */
import { clock } from '../core/clock';
import { newId } from '../core/ids';
import { AppError, notFound } from '../core/errors';
import { db } from '../repositories/db';
import type { Shipment, ShipmentStatus, TrackingEvent } from '../domain/shipment.schema';
import { appendTrace, tryGetCase } from '../orchestrator/state-store';

/** Normal forward progression of a return shipment. */
const STATUS_ORDER: ShipmentStatus[] = [
  'LABEL_CREATED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'AT_FACILITY',
  'DELIVERED',
];

export function getShipment(shipmentId: string): Shipment {
  const shipment = db.shipments.get(shipmentId);
  if (!shipment) throw notFound('Shipment', shipmentId);
  return shipment;
}

export function listShipments(filter: { caseId?: string; returnId?: string } = {}): Shipment[] {
  return db.shipments.find(
    (s) => (!filter.caseId || s.caseId === filter.caseId) && (!filter.returnId || s.returnId === filter.returnId),
  );
}

/**
 * Advances a shipment one step (or straight to `toStatus`).
 *
 * Promotes the matching projected event to actual, or synthesizes one if the
 * timeline does not contain it. Also appends a trace event to the parent case
 * so the UI timeline updates live.
 */
export function advanceShipment(
  shipmentId: string,
  options: { toStatus?: ShipmentStatus; note?: string } = {},
): Shipment {
  const shipment = getShipment(shipmentId);
  const now = clock.nowIso();

  if (shipment.status === 'DELIVERED' || shipment.status === 'CANCELLED') {
    throw new AppError('INVALID_STATE', `Shipment ${shipmentId} is already ${shipment.status.toLowerCase()}.`, {
      details: { status: shipment.status },
    });
  }

  /* -- work out the next status -- */
  let nextStatus: ShipmentStatus;
  if (options.toStatus) {
    nextStatus = options.toStatus;
  } else {
    const currentIndex = STATUS_ORDER.indexOf(shipment.status);
    const next = STATUS_ORDER[currentIndex + 1];
    if (!next) {
      throw new AppError('INVALID_STATE', `Shipment ${shipmentId} has no further steps from ${shipment.status}.`);
    }
    nextStatus = next;
  }

  /* -- promote the projected event, or create one -- */
  const projected = shipment.trackingEvents.find((e) => e.isProjected && e.status === nextStatus);

  const trackingEvents: TrackingEvent[] = projected
    ? shipment.trackingEvents.map((e) =>
        e.eventId === projected.eventId
          ? { ...e, isProjected: false, occurredAt: now, description: options.note ?? e.description }
          : e,
      )
    : [
        ...shipment.trackingEvents,
        {
          eventId: newId('event'),
          occurredAt: now,
          status: nextStatus,
          location: describeLocation(shipment, nextStatus),
          description: options.note ?? describeStatus(nextStatus, shipment),
          isProjected: false,
        },
      ];

  const updated = db.shipments.update(shipmentId, {
    status: nextStatus,
    trackingEvents,
    exceptionCode: nextStatus === 'EXCEPTION' ? 'PICKUP_MISSED' : shipment.exceptionCode,
    updatedAt: now,
  });

  if (!updated) throw notFound('Shipment', shipmentId);

  // Reflect it on the case timeline, when the case still exists.
  if (tryGetCase(shipment.caseId)) {
    appendTrace(
      shipment.caseId,
      'STAGE_COMPLETED',
      `Shipment ${shipmentId}: ${describeStatus(nextStatus, shipment)}`,
      { shipmentId, status: nextStatus, trackingNumber: shipment.label?.trackingNumber },
      'logistics',
      3,
    );
  }

  // Keep the Return record's status in step.
  syncReturnStatus(shipment.returnId, nextStatus);

  return updated;
}

function syncReturnStatus(returnId: string, shipmentStatus: ShipmentStatus): void {
  if (!returnId || !db.returns.has(returnId)) return;

  const map: Partial<Record<ShipmentStatus, string>> = {
    PICKED_UP: 'IN_TRANSIT',
    IN_TRANSIT: 'IN_TRANSIT',
    AT_FACILITY: 'RECEIVED',
    DELIVERED: 'RECEIVED',
  };
  const next = map[shipmentStatus];
  if (next) {
    db.returns.update(returnId, {
      status: next as never,
      updatedAt: clock.nowIso(),
      ...(next === 'RECEIVED' ? {} : {}),
    });
  }
}

function describeLocation(shipment: Shipment, status: ShipmentStatus): string {
  if (status === 'AT_FACILITY' || status === 'DELIVERED') return shipment.destinationFacilityId;
  if (status === 'IN_TRANSIT') return 'In transit';
  return `${shipment.originAddress.city}, ${shipment.originAddress.countryCode}`;
}

function describeStatus(status: ShipmentStatus, shipment: Shipment): string {
  switch (status) {
    case 'PICKED_UP':
      return `Collected by ${shipment.carrierName}.`;
    case 'IN_TRANSIT':
      return `On the way to the returns facility with ${shipment.carrierName}.`;
    case 'AT_FACILITY':
      return 'Arrived at the returns facility for inspection.';
    case 'DELIVERED':
      return 'Received and checked in.';
    case 'EXCEPTION':
      return 'A problem occurred with this shipment.';
    default:
      return status.replace(/_/g, ' ').toLowerCase();
  }
}
