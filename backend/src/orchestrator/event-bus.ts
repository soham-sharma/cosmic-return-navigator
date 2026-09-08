/**
 * EVENT BUS — powers the real-time agent-status visualization.
 *
 * The PRD requires "real-time agent status visualization (running / complete /
 * escalated)". The orchestrator publishes a `CaseStatusEvent` on every state
 * transition; `GET /returns/cases/:caseId/stream` subscribes and forwards them
 * to the browser as Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is strictly one-directional
 * (server -> browser), SSE needs no extra dependency, and it reconnects on its
 * own. A demo does not need more than that.
 *
 * A small replay buffer per case means a client that connects mid-pipeline (or
 * reconnects) still receives the events it missed, so the UI can rebuild the
 * timeline instead of showing a half-empty panel.
 */
import { EventEmitter } from 'node:events';
import type { CaseStatusEvent } from '../domain/case-state.schema';

const REPLAY_BUFFER_SIZE = 200;

class CaseEventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffers = new Map<string, CaseStatusEvent[]>();

  constructor() {
    // A demo can have several dashboards plus a customer view watching one case.
    this.emitter.setMaxListeners(50);
  }

  publish(event: CaseStatusEvent): void {
    const buffer = this.buffers.get(event.caseId) ?? [];
    buffer.push(event);
    if (buffer.length > REPLAY_BUFFER_SIZE) buffer.shift();
    this.buffers.set(event.caseId, buffer);

    this.emitter.emit(channel(event.caseId), event);
    this.emitter.emit('all', event);
  }

  /**
   * Subscribes to one case. Returns an unsubscribe function.
   * Pass `replay: true` to receive buffered events first.
   */
  subscribe(caseId: string, listener: (event: CaseStatusEvent) => void, replay = true): () => void {
    if (replay) {
      for (const event of this.buffers.get(caseId) ?? []) listener(event);
    }
    const ch = channel(caseId);
    this.emitter.on(ch, listener);
    return () => this.emitter.off(ch, listener);
  }

  /** Firehose for the ops dashboard: every case, no replay. */
  subscribeAll(listener: (event: CaseStatusEvent) => void): () => void {
    this.emitter.on('all', listener);
    return () => this.emitter.off('all', listener);
  }

  /** Buffered events for a case, for a client that wants a snapshot. */
  history(caseId: string): CaseStatusEvent[] {
    return [...(this.buffers.get(caseId) ?? [])];
  }

  clear(caseId?: string): void {
    if (caseId) this.buffers.delete(caseId);
    else this.buffers.clear();
  }
}

const channel = (caseId: string) => `case:${caseId}`;

export const eventBus = new CaseEventBus();
