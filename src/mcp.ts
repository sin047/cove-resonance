import { createHash } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildListenerHtml } from "./listener-html.js";
import { listenerWakeHub } from "./listenerWake.js";
import { registerNeteaseAccountTools } from "./netease/accountTools.js";
import { NeteaseClient } from "./netease/client.js";
import type { PlaybackStateStore } from "./netease/playbackState.js";
import type { TogetherWorker } from "./netease/togetherWorker.js";
import type { InMemoryEventQueue } from "./queue.js";
import { normalizeReplyBubbles } from "./replyBubbles.js";

export const RESOURCE_URI = "ui://widget/cove-bridge.html";
const PUBLIC_ORIGIN = process.env.BRIDGE_PUBLIC_ORIGIN?.trim()
  || `http://localhost:${process.env.PORT ?? "8787"}`;

export function createMcpServer(
  queue: InMemoryEventQueue,
  playbackState: PlaybackStateStore,
  togetherWorker: TogetherWorker,
): McpServer {
  const server = new McpServer(
    { name: "cove-bridge", version: "0.1.0" },
    {
      instructions: [
        "Cove Bridge routes external events into this conversation and may require a reply to be delivered back through the recorded route.",
        "For any current turn whose model context contains replyPolicy=required and replyRoute=netease.chatroom, you MUST call cove_bridge_reply exactly once before completing the turn. eventId may be omitted because the Bridge binds the reply to the active required event.",
        "For normal conversational replies, messages[] MUST default to 2-5 short, natural chat bubbles. Do not pack a multi-sentence reply into one bubble when it can be naturally separated.",
        "A single bubble is allowed only for a genuinely brief confirmation, reaction, greeting, or similarly short reply. Do not invent filler bubbles merely to satisfy the count.",
        "Each bubble should contain real conversational content; do not replace the real reply with generic filler such as 'I am here with you'.",
        "A reply written only in the ChatGPT conversation does NOT satisfy a required routed reply.",
        "Do not use netease_together_send_message directly for a routed reply.",
        "For replyPolicy=optional, call cove_bridge_reply only when you choose to send a user-facing reaction.",
      ].join("\n"),
    },
  );
  const html = buildListenerHtml();
  const neteaseAccountClient = new NeteaseClient(process.env.NETEASE_COOKIE?.trim() ?? "");

  registerNeteaseAccountTools(server, neteaseAccountClient);

  registerAppResource(
    server,
    "cove-bridge-widget",
    RESOURCE_URI,
    {},
    async () => ({
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: {
          ui: {
            domain: PUBLIC_ORIGIN,
            prefersBorder: false,
            csp: { connectDomains: [PUBLIC_ORIGIN], resourceDomains: [] },
          },
          "openai/widgetDescription": "A manually controlled listener for Cove Bridge test events.",
        },
      }],
    }),
  );

  registerAppTool(
    server,
    "open_cove_bridge",
    {
      title: "Open Cove Bridge",
      description: "Mount the Cove Bridge listener component in an idle state. Only use when the user explicitly asks to open it. Opening does not start listening; the user starts listening from the component.",
      inputSchema: {},
      outputSchema: { ready: z.boolean(), listening: z.boolean() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
        "openai/outputTemplate": RESOURCE_URI,
      },
    },
    async () => ({
      structuredContent: { ready: true, listening: false },
      content: [{ type: "text", text: "Cove Bridge mounted in an idle state. Listening has not started." }],
    }),
  );

  server.registerTool(
    "cove_bridge_listener_session",
    {
      title: "Cove Bridge listener session",
      description: "Create a short-lived, single-use authorization token for the Cove Bridge wake stream. App-only.",
      inputSchema: {},
      outputSchema: {
        token: z.string(),
        streamUrl: z.string(),
        expiresAt: z.string(),
        fallbackPollMs: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const session = listenerWakeHub.createSession();
      return {
        structuredContent: {
          token: session.token,
          streamUrl: `${PUBLIC_ORIGIN}/listener/events`,
          expiresAt: session.expiresAt,
          fallbackPollMs: 60_000,
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "netease_together_now",
    {
      title: "NetEase Together now",
      description: "Read the latest cached NetEase Listen Together playback state and nearby lyrics.",
      inputSchema: {},
      outputSchema: {
        inRoom: z.boolean(),
        roomId: z.string().optional(),
        playStatus: z.enum(["PLAY", "PAUSE", "UNKNOWN"]),
        song: z.object({
          id: z.string(),
          name: z.string(),
          artist: z.string(),
          durationMs: z.number(),
        }).optional(),
        progressMs: z.number(),
        durationMs: z.number(),
        progressRatio: z.number(),
        lyric: z.object({
          previous: z.string().optional(),
          current: z.string().optional(),
          next: z.string().optional(),
        }).optional(),
        observedAt: z.string().nullable(),
        stateUpdatedAt: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const state = playbackState.getCurrentState();
      return {
        structuredContent: state,
        content: [{ type: "text", text: JSON.stringify(state) }],
      };
    },
  );

  server.registerTool(
    "netease_together_realtime_status",
    {
      title: "NetEase Together realtime status",
      description: "Read the NIM realtime connection status plus the latest cached playback event and ChatRoom message. Never returns NetEase credentials.",
      inputSchema: {},
      outputSchema: {
        enabled: z.boolean(),
        connected: z.boolean(),
        roomId: z.string().nullable(),
        chatRoomId: z.string().nullable(),
        credentialsReady: z.boolean(),
        lastPlaybackEvent: z.object({
          type: z.literal("playback"),
          serverSeq: z.number().nullable(),
          commandType: z.string().nullable(),
          songId: z.string().nullable(),
          formerSongId: z.string().nullable(),
          progressMs: z.number(),
          playStatus: z.enum(["PLAY", "PAUSE", "UNKNOWN"]),
          receivedAtMs: z.number(),
        }).nullable(),
        lastChatMessage: z.object({
          type: z.literal("chatroom_message"),
          category: z.enum(["text", "custom", "robot", "notification", "other"]),
          msgType: z.number().nullable(),
          senderId: z.string().nullable(),
          senderNick: z.string().nullable(),
          text: z.string().nullable(),
          messageId: z.string().nullable(),
          timetagMs: z.number().nullable(),
          receivedAtMs: z.number(),
        }).nullable(),
        lastError: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const state = togetherWorker.getRealtimeStatus();
      return {
        structuredContent: state,
        content: [{ type: "text", text: JSON.stringify(state) }],
      };
    },
  );

  server.registerTool(
    "netease_together_send_message",
    {
      title: "Send NetEase Together room message",
      description: "Send one ordinary text message from Cove's NetEase account to the currently connected Listen Together ChatRoom. This is primarily for manual/proactive sends. If a required Cove Bridge reply is currently outstanding, the Bridge will automatically bind this send to that event and complete its reply route so the listener cannot deadlock.",
      inputSchema: { text: z.string().trim().min(1).max(500) },
      outputSchema: {
        ok: z.literal(true),
        roomId: z.string(),
        chatRoomId: z.string(),
        messageId: z.string(),
        text: z.string(),
        code: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ text }) => {
      const normalized = text.trim();
      const outstanding = queue.getOutstandingRequiredReplyEvent();

      if (!outstanding) {
        const result = await togetherWorker.sendChatRoomText(normalized);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }

      if (outstanding.replyRoute !== "netease.chatroom") {
        throw new Error(`Outstanding reply route is not supported by this tool: ${outstanding.replyRoute ?? "none"}`);
      }

      const bubbles = normalizeReplyBubbles([normalized]);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({
          eventId: outstanding.id,
          route: outstanding.replyRoute,
          messages: bubbles,
        }))
        .digest("hex");
      const claim = queue.claimReply(outstanding.id, fingerprint);
      if (claim.state === "in_progress") {
        throw new Error(`Routed reply is already in progress: ${outstanding.id}`);
      }
      if (claim.state === "already_completed") {
        throw new Error(`Routed reply is already completed: ${outstanding.id}`);
      }

      try {
        let result = null;
        for (let index = claim.sentCount; index < bubbles.length; index += 1) {
          result = await togetherWorker.sendChatRoomText(bubbles[index]);
          queue.markReplyMessageSent(outstanding.id, fingerprint);
          if (index < bubbles.length - 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 350));
          }
        }
        if (!result) throw new Error("Routed reply has no unsent bubble to deliver.");
        queue.markReplyCompleted(outstanding.id, fingerprint);
        listenerWakeHub.wake("reply-completed");
        console.warn(
          `Cove Bridge compatibility route completed via netease_together_send_message: eventId=${outstanding.id} messages=${bubbles.length}`,
        );
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        queue.releaseReply(outstanding.id, fingerprint);
        throw error;
      }
    },
  );

  server.registerTool(
    "cove_bridge_reply",
    {
      title: "Reply through Cove Bridge",
      description: "Deliver the user-facing reply for the active Cove Bridge event back through its recorded reply route. For replyPolicy=required, call this exactly once before completing the turn. eventId is optional because the Bridge binds to the active required event and corrects stale ids. For normal conversation, messages[] should contain 2-5 short natural bubbles; a single bubble is only for a genuinely brief reply. Do not pack multiple sentences into one long bubble and do not add filler just to increase the count. The Bridge will also split an obviously long single bubble as a fallback. Do not call netease_together_send_message directly for routed replies.",
      inputSchema: {
        eventId: z.string().trim().min(1).optional(),
        messages: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
      },
      outputSchema: {
        ok: z.literal(true),
        eventId: z.string(),
        route: z.literal("netease.chatroom"),
        sentCount: z.number(),
        completed: z.boolean(),
        deduplicated: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ eventId, messages }) => {
      const outstanding = queue.getOutstandingRequiredReplyEvent();
      const requested = eventId ? queue.getEvent(eventId) : null;
      const event = outstanding ?? requested;
      if (!event) {
        throw new Error(eventId
          ? `Unknown Cove Bridge event: ${eventId}`
          : "No active Cove Bridge event is awaiting a routed reply.");
      }

      const resolvedEventId = event.id;
      if (eventId && eventId !== resolvedEventId) {
        console.warn(
          `Cove Bridge reply eventId corrected: requested=${eventId} resolved=${resolvedEventId}`,
        );
      }
      if (!event.replyRoute) throw new Error(`Event has no reply route: ${resolvedEventId}`);
      if (event.replyRoute !== "netease.chatroom") {
        throw new Error(`Unsupported reply route: ${event.replyRoute}`);
      }

      const normalized = normalizeReplyBubbles(messages);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ eventId: resolvedEventId, route: event.replyRoute, messages: normalized }))
        .digest("hex");
      const claim = queue.claimReply(resolvedEventId, fingerprint);

      if (claim.state === "already_completed" || claim.state === "in_progress") {
        return {
          structuredContent: {
            ok: true as const,
            eventId: resolvedEventId,
            route: "netease.chatroom" as const,
            sentCount: claim.sentCount,
            completed: claim.state === "already_completed",
            deduplicated: true,
          },
          content: [{
            type: "text",
            text: claim.state === "already_completed"
              ? "Reply was already delivered; duplicate send suppressed."
              : "The same reply is already being delivered; duplicate send suppressed.",
          }],
        };
      }

      try {
        let sentCount = claim.sentCount;
        for (let index = sentCount; index < normalized.length; index += 1) {
          await togetherWorker.sendChatRoomText(normalized[index]);
          sentCount = queue.markReplyMessageSent(resolvedEventId, fingerprint);
          if (index < normalized.length - 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 350));
          }
        }
        queue.markReplyCompleted(resolvedEventId, fingerprint);
        listenerWakeHub.wake("reply-completed");
        console.log(
          `Cove Bridge reply delivered: eventId=${resolvedEventId} route=netease.chatroom messages=${normalized.length}`,
        );
        return {
          structuredContent: {
            ok: true as const,
            eventId: resolvedEventId,
            route: "netease.chatroom" as const,
            sentCount,
            completed: true,
            deduplicated: false,
          },
          content: [{
            type: "text",
            text: `Delivered ${sentCount} chat bubble(s) through netease.chatroom.`,
          }],
        };
      } catch (error) {
        queue.releaseReply(resolvedEventId, fingerprint);
        throw error;
      }
    },
  );

  server.registerTool(
    "cove_bridge_sync",
    {
      title: "Cove Bridge sync",
      description: "Reserve one pending test event for the Cove Bridge component.",
      inputSchema: {},
      outputSchema: {
        hasEvent: z.boolean(),
        eventId: z.string().optional(),
        awaitingReply: z.boolean().optional(),
        outstandingStatus: z.enum(["reserved", "delivered"]).optional(),
        reservedAt: z.string().optional(),
        deliveredAt: z.string().nullable().optional(),
        awaitingReplyForMs: z.number().optional(),
        queuedConversation: z.number().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const outstanding = queue.getOutstandingRequiredReplyState();
      if (outstanding) {
        const queueState = queue.status();
        return {
          structuredContent: {
            hasEvent: false,
            eventId: outstanding.event.id,
            awaitingReply: true,
            outstandingStatus: outstanding.status,
            reservedAt: outstanding.reservedAt,
            deliveredAt: outstanding.deliveredAt,
            awaitingReplyForMs: outstanding.awaitingReplyForMs,
            queuedConversation: queueState.conversation.pending,
          },
          content: [],
        };
      }

      const event = queue.reserveNext();
      if (!event) return { structuredContent: { hasEvent: false }, content: [] };
      console.log(
        `Cove Bridge event reserved: eventId=${event.id} stream=${event.stream} source=${event.source} replyPolicy=${event.replyPolicy ?? "none"}`,
      );
      return {
        structuredContent: { hasEvent: true, eventId: event.id, awaitingReply: false },
        content: [],
        _meta: { event },
      };
    },
  );

  server.registerTool(
    "cove_bridge_replay_outstanding",
    {
      title: "Replay outstanding Cove Bridge event",
      description: "Return the current required event to the Listener for an explicit user-requested follow-up retry. App-only.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { replayed: z.boolean(), eventId: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      const outstanding = queue.getOutstandingRequiredReplyState();
      if (!outstanding) throw new Error("No required Cove Bridge event is awaiting a reply.");
      if (outstanding.event.id !== eventId) {
        throw new Error(
          `Outstanding event changed: requested=${eventId} current=${outstanding.event.id}`,
        );
      }

      console.warn(
        `Cove Bridge outstanding replay requested: eventId=${eventId} awaitingReplyForMs=${outstanding.awaitingReplyForMs}`,
      );
      return {
        structuredContent: { replayed: true, eventId },
        content: [],
        _meta: { event: outstanding.event },
      };
    },
  );

  server.registerTool(
    "cove_bridge_cancel_outstanding",
    {
      title: "Cancel outstanding Cove Bridge event",
      description: "Cancel the current required event after explicit user confirmation so later queued events can continue. App-only.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { cancelled: z.boolean(), eventId: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      const cancelled = queue.cancelOutstandingRequiredReply(eventId);
      if (cancelled) {
        console.warn(`Cove Bridge outstanding event cancelled: eventId=${eventId}`);
        listenerWakeHub.wake("outstanding-cancelled");
      }
      return {
        structuredContent: { cancelled, eventId },
        content: [],
      };
    },
  );

  server.registerTool(
    "cove_bridge_delivered",
    {
      title: "Cove Bridge delivered",
      description: "Mark a reserved event as accepted by the chat host.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { delivered: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      queue.markDelivered(eventId);
      return { structuredContent: { delivered: true }, content: [] };
    },
  );

  server.registerTool(
    "cove_bridge_release",
    {
      title: "Cove Bridge release",
      description: "Release a reserved event after a failed host dispatch.",
      inputSchema: { eventId: z.string().min(1) },
      outputSchema: { released: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ eventId }) => {
      queue.release(eventId);
      listenerWakeHub.wake("released");
      return { structuredContent: { released: true }, content: [] };
    },
  );

  return server;
}
