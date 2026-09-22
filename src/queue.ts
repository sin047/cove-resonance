import type { BridgeEvent, StoredBridgeEvent } from "./types.js";

export type ReplyClaim =
  | { state: "send"; sentCount: number }
  | { state: "in_progress"; sentCount: number }
  | { state: "already_completed"; sentCount: number };

type StreamCounts = {
  pending: number;
  reserved: number;
  delivered: number;
  total: number;
};

export type QueueStatus = StreamCounts & {
  conversation: StreamCounts;
  state: StreamCounts;
};

export type OutstandingRequiredReplyState = {
  event: BridgeEvent;
  status: "reserved" | "delivered";
  reservedAt: string;
  deliveredAt: string | null;
  awaitingReplyForMs: number;
};

type EventLifecycle = {
  reservedAtMs: number;
  deliveredAtMs?: number;
};

const STATE_HISTORY_PER_KEY = 12;

function emptyCounts(): StreamCounts {
  return { pending: 0, reserved: 0, delivered: 0, total: 0 };
}

export class InMemoryEventQueue {
  private readonly conversationRows = new Map<string, StoredBridgeEvent>();
  private readonly stateRows = new Map<string, StoredBridgeEvent>();
  private readonly statePendingByKey = new Map<string, string>();
  private readonly lifecycleByEventId = new Map<string, EventLifecycle>();

  enqueue(event: BridgeEvent): boolean {
    if (this.getRow(event.id)) return false;

    if (event.stream === "state") {
      const key = event.stateKey ?? event.source;
      const previousPendingId = this.statePendingByKey.get(key);
      if (previousPendingId) {
        const previous = this.stateRows.get(previousPendingId);
        if (previous?.status === "pending") this.stateRows.delete(previousPendingId);
      }

      this.stateRows.set(event.id, { event, status: "pending" });
      this.statePendingByKey.delete(key);
      this.statePendingByKey.set(key, event.id);
      this.pruneStateHistory(key);
      return true;
    }

    this.conversationRows.set(event.id, { event, status: "pending" });
    return true;
  }

  getEvent(eventId: string): BridgeEvent | null {
    return this.getRow(eventId)?.event ?? null;
  }

  getOutstandingRequiredReplyEvent(): BridgeEvent | null {
    return this.getOutstandingRequiredReplyState()?.event ?? null;
  }

  getOutstandingRequiredReplyState(nowMs = Date.now()): OutstandingRequiredReplyState | null {
    for (const row of this.conversationRows.values()) {
      if (row.event.replyPolicy !== "required") continue;
      if (row.reply?.completed) continue;
      if (row.status !== "reserved" && row.status !== "delivered") continue;

      let lifecycle = this.lifecycleByEventId.get(row.event.id);
      if (!lifecycle) {
        const createdAtMs = Date.parse(row.event.createdAt);
        lifecycle = {
          reservedAtMs: Number.isFinite(createdAtMs) ? createdAtMs : nowMs,
        };
        this.lifecycleByEventId.set(row.event.id, lifecycle);
      }

      return {
        event: row.event,
        status: row.status,
        reservedAt: new Date(lifecycle.reservedAtMs).toISOString(),
        deliveredAt: lifecycle.deliveredAtMs === undefined
          ? null
          : new Date(lifecycle.deliveredAtMs).toISOString(),
        awaitingReplyForMs: Math.max(0, nowMs - lifecycle.reservedAtMs),
      };
    }
    return null;
  }

  cancelOutstandingRequiredReply(eventId: string): boolean {
    const outstanding = this.getOutstandingRequiredReplyState();
    if (!outstanding) return false;
    if (outstanding.event.id !== eventId) {
      throw new Error(
        `Outstanding event changed: requested=${eventId} current=${outstanding.event.id}`,
      );
    }

    this.conversationRows.delete(eventId);
    this.lifecycleByEventId.delete(eventId);
    return true;
  }

  reserveNext(): BridgeEvent | null {
    if (this.getOutstandingRequiredReplyEvent()) return null;

    for (const row of this.conversationRows.values()) {
      if (row.status !== "pending") continue;
      row.status = "reserved";
      this.lifecycleByEventId.set(row.event.id, { reservedAtMs: Date.now() });
      return row.event;
    }

    for (const [key, eventId] of this.statePendingByKey) {
      const row = this.stateRows.get(eventId);
      if (!row || row.status !== "pending") {
        this.statePendingByKey.delete(key);
        continue;
      }
      row.status = "reserved";
      this.lifecycleByEventId.set(row.event.id, { reservedAtMs: Date.now() });
      this.statePendingByKey.delete(key);
      return row.event;
    }

    return null;
  }

  markDelivered(eventId: string): void {
    const row = this.getRow(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    if (row.status === "delivered") return;
    if (row.status !== "reserved") {
      throw new Error(`Event is not reserved: ${eventId}`);
    }
    row.status = "delivered";
    const lifecycle = this.lifecycleByEventId.get(eventId) ?? { reservedAtMs: Date.now() };
    lifecycle.deliveredAtMs = Date.now();
    this.lifecycleByEventId.set(eventId, lifecycle);
  }

  release(eventId: string): void {
    const row = this.getRow(eventId);
    if (!row || row.status === "delivered") return;

    this.lifecycleByEventId.delete(eventId);

    if (row.event.stream === "state") {
      const key = row.event.stateKey ?? row.event.source;
      const newerPendingId = this.statePendingByKey.get(key);
      if (newerPendingId && newerPendingId !== eventId) {
        this.stateRows.delete(eventId);
        return;
      }
      row.status = "pending";
      this.statePendingByKey.delete(key);
      this.statePendingByKey.set(key, eventId);
      return;
    }

    row.status = "pending";
  }

  claimReply(eventId: string, fingerprint: string): ReplyClaim {
    const row = this.getRow(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    const reply = row.reply;

    if (!reply) {
      row.reply = {
        fingerprint,
        sentCount: 0,
        completed: false,
        inFlight: true,
      };
      return { state: "send", sentCount: 0 };
    }

    if (reply.completed) {
      return { state: "already_completed", sentCount: reply.sentCount };
    }
    if (reply.fingerprint !== fingerprint) {
      throw new Error(`Event already has a different reply: ${eventId}`);
    }
    if (reply.inFlight) {
      return { state: "in_progress", sentCount: reply.sentCount };
    }

    reply.inFlight = true;
    return { state: "send", sentCount: reply.sentCount };
  }

  markReplyMessageSent(eventId: string, fingerprint: string): number {
    const row = this.getRow(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint) {
      throw new Error(`Reply is not claimed: ${eventId}`);
    }
    row.reply.sentCount += 1;
    return row.reply.sentCount;
  }

  markReplyCompleted(eventId: string, fingerprint: string): void {
    const row = this.getRow(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint) {
      throw new Error(`Reply is not claimed: ${eventId}`);
    }
    row.reply.completed = true;
    row.reply.inFlight = false;
    row.reply.completedAt = new Date().toISOString();
  }

  releaseReply(eventId: string, fingerprint: string): void {
    const row = this.getRow(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint || row.reply.completed) return;
    row.reply.inFlight = false;
  }

  status(): QueueStatus {
    const conversation = this.countRows(this.conversationRows);
    const state = this.countRows(this.stateRows);
    return {
      pending: conversation.pending + state.pending,
      reserved: conversation.reserved + state.reserved,
      delivered: conversation.delivered + state.delivered,
      total: conversation.total + state.total,
      conversation,
      state,
    };
  }

  private getRow(eventId: string): StoredBridgeEvent | undefined {
    return this.conversationRows.get(eventId) ?? this.stateRows.get(eventId);
  }

  private countRows(rows: Map<string, StoredBridgeEvent>): StreamCounts {
    const counts = emptyCounts();
    counts.total = rows.size;
    for (const row of rows.values()) counts[row.status] += 1;
    return counts;
  }

  private pruneStateHistory(key: string): void {
    const deliveredIds: string[] = [];
    for (const [eventId, row] of this.stateRows) {
      if ((row.event.stateKey ?? row.event.source) !== key) continue;
      if (row.status === "delivered") deliveredIds.push(eventId);
    }
    const overflow = deliveredIds.length - STATE_HISTORY_PER_KEY;
    for (let index = 0; index < overflow; index += 1) {
      this.stateRows.delete(deliveredIds[index]);
    }
  }
}
