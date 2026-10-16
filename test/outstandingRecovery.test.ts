import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventQueue } from "../src/queue.js";
import type { BridgeEvent } from "../src/types.js";

function event(id: string): BridgeEvent {
  return {
    id,
    correlationId: id,
    kind: "message",
    source: "netease.chatroom",
    stream: "conversation",
    replyRoute: "netease.chatroom",
    replyPolicy: "required",
    createdAt: new Date(1_000).toISOString(),
    visibleText: "hello",
    modelContext: "test",
  };
}

test("outstanding required reply exposes lifecycle timing", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(event("evt-1"));
  const reserved = queue.reserveNext();
  assert.equal(reserved?.id, "evt-1");

  const beforeDelivery = queue.getOutstandingRequiredReplyState(undefined, Date.now() + 1_000);
  assert.equal(beforeDelivery?.event.id, "evt-1");
  assert.equal(beforeDelivery?.status, "reserved");
  assert.equal(beforeDelivery?.deliveredAt, null);
  assert.ok((beforeDelivery?.awaitingReplyForMs ?? 0) >= 1_000);

  queue.markDelivered("evt-1");
  const afterDelivery = queue.getOutstandingRequiredReplyState();
  assert.equal(afterDelivery?.status, "delivered");
  assert.ok(afterDelivery?.deliveredAt);
});

test("dismiss terminally releases required-reply backpressure", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(event("evt-1"));
  queue.enqueue(event("evt-2"));
  assert.equal(queue.reserveNext()?.id, "evt-1");
  queue.markDelivered("evt-1");
  assert.equal(queue.reserveNext(), null);

  queue.dismiss("evt-1");
  assert.equal(queue.getOutstandingRequiredReplyEvent(), null);
  assert.equal(queue.reserveNext()?.id, "evt-2");
});
