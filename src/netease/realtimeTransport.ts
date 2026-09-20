import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, readNumber, readString, type RealtimeCredentials } from "./types.js";

const NIM_APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";
const ENTER_TIMEOUT_MS = 15_000;
const IM_RECOVERY_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_CHAT_TEXT_LENGTH = 500;
const MAX_JSON_STRING_BYTES = 65_536;

type RealtimePlayStatus = "PLAY" | "PAUSE" | "UNKNOWN";

export type RealtimePlaybackEvent = {
  type: "playback";
  serverSeq: number | null;
  commandType: string | null;
  songId: string | null;
  formerSongId: string | null;
  progressMs: number;
  playStatus: RealtimePlayStatus;
  receivedAtMs: number;
};

export type RealtimeChatRoomMessage = {
  type: "chatroom_message";
  category: "text" | "custom" | "robot" | "notification" | "other";
  msgType: number | null;
  senderId: string | null;
  senderNick: string | null;
  text: string | null;
  messageId: string | null;
  timetagMs: number | null;
  receivedAtMs: number;
};

export type RealtimeTransportStatus = {
  enabled: boolean;
  connected: boolean;
  roomId: string | null;
  chatRoomId: string | null;
  credentialsReady: boolean;
  lastPlaybackEvent: RealtimePlaybackEvent | null;
  lastChatMessage: RealtimeChatRoomMessage | null;
  lastError: string | null;
};

export type RealtimeChatSendResult = {
  ok: true;
  roomId: string;
  chatRoomId: string;
  messageId: string;
  text: string;
  code: number;
};

export type RealtimeMemberProfile = {
  userId?: string;
  nick?: string;
  avatar?: string;
  gender?: number;
};

type ConnectOptions = {
  roomId: string;
  chatRoomId: string;
  credentials: RealtimeCredentials;
  memberProfile?: RealtimeMemberProfile;
};

type EventHandler = (...args: unknown[]) => void;

type ChatRoomLike = {
  init(appInstallDir: string, extension: string): boolean;
  initEventHandlers(): void;
  enter(roomId: number, requestLoginData: string, info: Record<string, unknown>, extension: string): boolean;
  exit(roomId: number, extension: string): void;
  sendMsg(roomId: number, msg: Record<string, unknown>, extension: string): boolean;
  updateMyRoomRoleAsync(
    roomId: number,
    info: Record<string, unknown>,
    needNotify: boolean,
    notifyExt: string,
    cb: null,
    extension: string,
  ): Promise<[number, number]>;
  getMemberInfoByIDsAsync(
    roomId: number,
    ids: string[],
    cb: null,
    extension: string,
  ): Promise<[number, number, Array<Record<string, unknown>>]>;
  on(event: string, handler: EventHandler): unknown;
};

type NimClientLike = {
  init(appKey: string, appDataDir: string, appInstallDir: string, config: Record<string, unknown>): boolean;
  initEventHandlers(): void;
  login(appKey: string, account: string, password: string, cb: null, extension: string): Promise<[unknown]>;
  on?(event: string, handler: EventHandler): unknown;
};

type NimPluginLike = {
  initEventHandlers(): void;
  chatRoomRequestEnterAsync(roomId: number, cb: null, extension: string): Promise<[number, string]>;
};

type NodeNimModule = {
  ChatRoom: new () => ChatRoomLike;
  NIMClient: new () => NimClientLike;
  NIMPlugin: new () => NimPluginLike;
};

type PendingEnter = {
  generation: number;
  roomNumber: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

type ImReadyWaiter = {
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingSend = {
  roomNumber: number;
  roomId: string;
  chatRoomId: string;
  text: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: RealtimeChatSendResult) => void;
  reject: (error: Error) => void;
};

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_JSON_STRING_BYTES) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeStatus(value: unknown): RealtimePlayStatus {
  const status = readString(value)?.toUpperCase();
  return status === "PLAY" || status === "PAUSE" ? status : "UNKNOWN";
}

function extractPlaybackCommand(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 7) return null;
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = extractPlaybackCommand(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;
  const hasCommandFields =
    object.commandType !== undefined
    || object.playStatus !== undefined
    || object.targetSongId !== undefined
    || object.progress !== undefined;
  if (hasCommandFields) return object;

  for (const key of ["command", "commandInfo", "config", "content", "data", "msg_attach_", "msg_body_", "ext_"]) {
    if (object[key] === undefined) continue;
    const found = extractPlaybackCommand(object[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function findPlaybackEnvelope(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 7) return null;
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findPlaybackEnvelope(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;
  const eventType = readNumber(object.event_type) ?? readNumber(object.type);
  if (eventType === 20_000) return object;

  for (const nested of Object.values(object)) {
    const found = findPlaybackEnvelope(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

export function decodeRealtimePlaybackEvent(
  raw: unknown,
  receivedAtMs = Date.now(),
): RealtimePlaybackEvent | null {
  const envelope = findPlaybackEnvelope(raw);
  if (!envelope) return null;
  const command = extractPlaybackCommand(envelope);
  if (!command) return null;

  const progress = readNumber(command.progress);
  const serverSeq = readNumber(command.serverSeq) ?? readNumber(envelope.serverSeq);
  return {
    type: "playback",
    serverSeq,
    commandType: readString(command.commandType)?.toUpperCase() ?? null,
    songId: readString(command.targetSongId),
    formerSongId: readString(command.formerSongId),
    progressMs: Math.max(0, progress ?? 0),
    playStatus: normalizeStatus(command.playStatus),
    receivedAtMs,
  };
}

function extractChatText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;

  const parsed = parseJsonString(value);

  if (typeof parsed === "string") {
    const text = parsed.trim();
    return text || null;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = extractChatText(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;

  for (const key of [
    "text",
    "content",
    "body",
    "msg",
    "message",
    "data",
    "payload",
    "attach",
    "msg_attach_",
    "msg_body_",
    "ext",
    "ext_",
    "clientExt",
  ]) {
    if (object[key] === undefined) continue;

    const found = extractChatText(object[key], depth + 1);
    if (found) return found;
  }

  return null;
}
  
  
  
  
  
  
    
    
    


function chatMessageCategory(msgType: number | null): RealtimeChatRoomMessage["category"] {
  if (msgType === 0) return "text";
  if (msgType === 5) return "notification";
  if (msgType === 11) return "robot";
  if (msgType === 100) return "custom";
  return "other";
}

export function buildRealtimeChatTextMessage(
  text: string,
  roomId: string,
  messageId: string = randomUUID(),
  senderProfile?: RealtimeMemberProfile,
): Record<string, unknown> {
  const normalized = text.trim();
  if (!normalized) throw new Error("ChatRoom message cannot be empty");
  if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
    throw new Error(`ChatRoom message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`);
  }
  const numericUserId = senderProfile?.userId && /^\d+$/.test(senderProfile.userId)
    ? Number(senderProfile.userId)
    : null;
  const senderNick = senderProfile?.nick?.trim();
  const senderAvatar = senderProfile?.avatar?.trim();
  const serverExt = numericUserId !== null && senderNick && senderAvatar
    ? {
        userId: numericUserId,
        nickname: senderNick,
        avatarUrl: senderAvatar,
        msgId: Number(BigInt(`0x${messageId.replaceAll("-", "").slice(0, 12)}`) % 90_000_000_000n + 10_000_000_000n),
        ...(typeof senderProfile?.gender === "number" ? { gender: senderProfile.gender } : {}),
      }
    : undefined;
  const ext = JSON.stringify({
    ...(serverExt ? { serverExt } : {}),
    appName: "music",
    clientExt: {
      bizType: "listenTogether",
      ltType: "FRIEND",
      roomId,
      clientMsgId: messageId,
    },
  });
  return {
    msg_type_: 0,
    msg_attach_: normalized,
    msg_body_: "",
    client_msg_id_: messageId,
    sub_type_: 0,
    msg_setting_: {
      ext_: ext,
      anti_spam_enable_: false,
      history_save_: true,
      anti_spam_using_yidun_: 1,
      route_enabled_: true,
    },
  };
}

export function decodeRealtimeChatRoomMessage(
  raw: unknown,
  receivedAtMs = Date.now(),
): RealtimeChatRoomMessage | null {
  const message = asRecord(raw);
  if (!Object.keys(message).length) return null;
  const msgType = readNumber(message.msg_type_);
  return {
    type: "chatroom_message",
    category: chatMessageCategory(msgType),
    msgType,
    senderId: readString(message.from_id_),
    senderNick: readString(message.from_nick_),
    text: extractChatText(message.msg_body_) ?? extractChatText(message.msg_attach_),
    messageId: readString(message.client_msg_id_),
    timetagMs: readNumber(message.timetag_),
    receivedAtMs,
  };
}

export function buildRealtimeChatRoomEnterInfo(
  profile?: RealtimeMemberProfile,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const nick = profile?.nick?.trim();
  const avatar = profile?.avatar?.trim();
  if (nick) values.nick = nick;
  if (avatar) values.avatar = avatar;
  return { values_: values };
}

function numericChatRoomId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Unsupported NIM chatRoomId: ${value}`);
  }
  return parsed;
}

async function loadNodeNim(): Promise<NodeNimModule> {
  const imported = await import("node-nim");
  const candidate = (imported as { default?: unknown }).default ?? imported;
  const module = candidate as Partial<NodeNimModule>;
  if (typeof module.ChatRoom !== "function") {
    throw new Error("node-nim ChatRoom export is unavailable");
  }
  if (typeof module.NIMClient !== "function" || typeof module.NIMPlugin !== "function") {
    throw new Error("node-nim NIMClient/NIMPlugin exports are unavailable");
  }
  return module as NodeNimModule;
}

export class NeteaseRealtimeTransport {
  private chatroom: ChatRoomLike | null = null;
  private nimClient: NimClientLike | null = null;
  private nimPlugin: NimPluginLike | null = null;
  private runtimeReady = false;
  private loggedInAccount: string | null = null;
  private imOnline = false;
  private readonly imReadyWaiters = new Set<ImReadyWaiter>();
  private readonly pendingSends = new Map<string, PendingSend>();
  private roomNumber: number | null = null;
  private connecting: Promise<void> | null = null;
  private pendingEnter: PendingEnter | null = null;
  private activeMemberProfile: RealtimeMemberProfile | null = null;
  private generation = 0;
  private status: RealtimeTransportStatus;

  constructor(
    private readonly enabled = true,
    private readonly onChatMessage?: (message: RealtimeChatRoomMessage) => void,
  ) {
    this.status = {
      enabled,
      connected: false,
      roomId: null,
      chatRoomId: null,
      credentialsReady: false,
      lastPlaybackEvent: null,
      lastChatMessage: null,
      lastError: null,
    };
  }

  getStatus(): RealtimeTransportStatus {
    return {
      ...this.status,
      lastPlaybackEvent: this.status.lastPlaybackEvent
        ? { ...this.status.lastPlaybackEvent }
        : null,
      lastChatMessage: this.status.lastChatMessage
        ? { ...this.status.lastChatMessage }
        : null,
    };
  }

  async connect(options: ConnectOptions): Promise<void> {
    if (!this.enabled) return;
    if (
      this.status.connected
      && this.status.roomId === options.roomId
      && this.status.chatRoomId === options.chatRoomId
    ) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectInternal(options)
      .catch((error) => {
        this.recordConnectionError(error);
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private markImOnline(): void {
    this.imOnline = true;
    for (const waiter of this.imReadyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.imReadyWaiters.clear();
  }

  private markImOffline(): void {
    this.imOnline = false;
  }

  private rejectImReadyWaiters(error: Error): void {
    for (const waiter of this.imReadyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.imReadyWaiters.clear();
  }

  private async waitForImRecovery(): Promise<void> {
    if (this.imOnline) return;
    await new Promise<void>((resolve, reject) => {
      let waiter!: ImReadyWaiter;
      const timeout = setTimeout(() => {
        this.imReadyWaiters.delete(waiter);
        reject(new Error("NIM client relogin timed out"));
      }, IM_RECOVERY_TIMEOUT_MS);
      timeout.unref?.();
      waiter = { timeout, resolve, reject };
      this.imReadyWaiters.add(waiter);
    });
  }

  private async ensureRuntime(credentials: RealtimeCredentials): Promise<void> {
    if (!this.runtimeReady) {
      const dataDir = join(tmpdir(), `cove-nim-${process.pid}`);
      await mkdir(dataDir, { recursive: true });
      const nim = await loadNodeNim();
      const client = new nim.NIMClient();
      const plugin = new nim.NIMPlugin();
      const chatroom = new nim.ChatRoom();

      const nimConfig = {
        database_encrypt_key_: NIM_APP_KEY,
        use_https_: true,
      };
      console.log("NIM diag: before client.init");
      if (!client.init(NIM_APP_KEY, `${dataDir}/`, "", nimConfig)) {
        throw new Error("NIM client initialization failed");
      }
      console.log("NIM diag: after client.init");
      client.initEventHandlers();
      plugin.initEventHandlers();
      console.log("NIM diag: before chatroom.init");
      if (!chatroom.init("", "")) {
        throw new Error("NIM chatroom initialization failed");
      }
      console.log("NIM diag: after chatroom.init");
      chatroom.initEventHandlers();

      this.nimClient = client;
      this.nimPlugin = plugin;
      this.chatroom = chatroom;
      this.installRuntimeHandlers(chatroom, client);
      this.runtimeReady = true;
      console.log("NetEase NIM native runtime initialized once for this process");
    }

    if (this.loggedInAccount && this.loggedInAccount !== credentials.accId) {
      throw new Error("NIM runtime is already bound to a different account");
    }

    if (this.loggedInAccount === credentials.accId) {
      if (!this.imOnline) {
        console.log("NetEase NIM client is recovering internally; waiting before chatroom re-entry");
        await this.waitForImRecovery();
      }
      return;
    }

    const client = this.nimClient;
    if (!client) throw new Error("NIM client is unavailable");
    let loginTimeout: ReturnType<typeof setTimeout> | null = null;

try {
  const [loginResult] = await Promise.race([
    client.login(
      NIM_APP_KEY,
      credentials.accId,
      credentials.token,
      null,
      "",
    ),
    new Promise<never>((_, reject) => {
      loginTimeout = setTimeout(() => {
        reject(new Error("NIM login timed out"));
      }, 15_000);
      loginTimeout.unref?.();
    }),
  ]);

  const loginCode = readNumber(asRecord(loginResult).res_code_);
  if (loginCode !== 200) {
    throw new Error(
      `NIM login failed${loginCode === null ? "" : ` code=${loginCode}`}`,
    );
  }

  this.loggedInAccount = credentials.accId;
  this.markImOnline();
} finally {
  if (loginTimeout) clearTimeout(loginTimeout);
}
    
      
      
      
      
    
    
    
      
    
    
    
  }

  private installRuntimeHandlers(chatroom: ChatRoomLike, client: NimClientLike): void {
    chatroom.on("enter", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      const step = readNumber(args[1]);
      const code = readNumber(args[2]);
      const pending = this.pendingEnter;
      if (!pending || room !== pending.roomNumber || pending.generation !== this.generation) return;
      if (step !== 5) return;
      this.pendingEnter = null;
      if (code === 200) pending.resolve();
      else pending.reject(new Error(`NIM chatroom auth failed${code === null ? "" : ` code=${code}`}`));
    });

    chatroom.on("sendMsg", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      const code = readNumber(args[1]);
      const rawMessage = asRecord(args[2]);
      const messageId = readString(rawMessage.client_msg_id_);
      if (!messageId) return;
      const pending = this.pendingSends.get(messageId);
      if (!pending || room !== pending.roomNumber) return;
      this.pendingSends.delete(messageId);
      clearTimeout(pending.timeout);
      if (code === 200) {
        console.log(`NetEase ChatRoom message sent: code=200 messageId=***${messageId.slice(-6)} textLength=${pending.text.length}`);
        pending.resolve({
          ok: true,
          roomId: pending.roomId,
          chatRoomId: pending.chatRoomId,
          messageId,
          text: pending.text,
          code,
        });
      } else {
        pending.reject(new Error(`NIM ChatRoom send failed${code === null ? "" : ` code=${code}`}`));
      }
    });

    chatroom.on("receiveMsg", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      if (this.roomNumber !== null && room !== this.roomNumber) return;
      const receivedAtMs = Date.now();
      const event = decodeRealtimePlaybackEvent(args[1], receivedAtMs);
      if (event) {
        this.status.lastPlaybackEvent = event;
        console.log(
          `NetEase realtime playback event: command=${event.commandType ?? "UNKNOWN"} songId=${event.songId ?? "unknown"} progressMs=${event.progressMs} serverSeq=${event.serverSeq ?? "unknown"} latencyAnchor=receivedAt`,
        );
        return;
      }

      const message = decodeRealtimeChatRoomMessage(args[1], receivedAtMs);
      if (!message) return;
      this.status.lastChatMessage = message;
      const sender = message.senderId ? `***${message.senderId.slice(-4)}` : "unknown";
      const messageId = message.messageId ? `***${message.messageId.slice(-6)}` : "unknown";
      const textPreview = message.category === "text" && message.text
        ? message.text.replace(/[\r\n\t]+/g, " ").slice(0, 80)
        : null;
      console.log(
        `NetEase ChatRoom message received: category=${message.category} msgType=${message.msgType ?? "unknown"} sender=${sender} textLength=${message.text?.length ?? 0} textPreview=${textPreview === null ? "n/a" : JSON.stringify(textPreview)} messageId=${messageId}`,
      );
      try {
        this.onChatMessage?.(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        console.error(`NetEase ChatRoom message sink failed: ${detail}`);
      }
    });

    chatroom.on("exit", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      if (this.roomNumber !== null && room !== this.roomNumber) return;
      const reason = readNumber(args[2]) ?? readNumber(args[1]);
      this.status.connected = false;
      this.status.lastError = `NIM chatroom exited${reason === null ? "" : ` reason=${reason}`}`;
      console.warn(this.status.lastError);
    });

    chatroom.on("linkCondition", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      if (this.roomNumber !== null && room !== this.roomNumber) return;
      const condition = readNumber(args[1]);
      if (condition === 0) {
        if (this.roomNumber !== null) this.status.connected = true;
        this.status.lastError = null;
        return;
      }
      if (condition === 1) {
        this.status.lastError = "NIM realtime link is retrying internally";
        console.warn(this.status.lastError);
        return;
      }
      if (condition === 2) {
        this.status.connected = false;
        this.status.lastError = "NIM realtime link requires chatroom re-entry";
        console.warn(this.status.lastError);
      }
    });

    client.on?.("disconnect", () => {
      this.markImOffline();
      console.warn("NetEase NIM IM link disconnected; ChatRoom state left unchanged");
    });

    client.on?.("relogin", (...args: unknown[]) => {
      const result = asRecord(args[0]);
      const code = readNumber(result.res_code_);
      const step = readNumber(result.login_step_);
      const retrying = result.retrying_ === true;

      if (code === 200 && step === 3) {
        this.markImOnline();
        console.log("NetEase NIM client relogin recovered; ChatRoom state left unchanged");
        return;
      }

      if (code !== null) {
        console.warn(`NetEase NIM client relogin pending code=${code} retrying=${retrying}`);
      }
      if (code !== 200 && !retrying) {
        this.rejectImReadyWaiters(
          new Error(`NIM client relogin failed${code === null ? "" : ` code=${code}`}`),
        );
      }
    });

    client.on?.("multispotLogin", (...args: unknown[]) => {
  const result = asRecord(args[0]);
  const notifyType = readNumber(result.notify_type_);
  const peerCandidates = [result.other_clients_, result.online_clients_, result.clients_]
    .find((value) => Array.isArray(value));
  const peers = Array.isArray(peerCandidates) ? peerCandidates : [];
  const peerTypes = peers.slice(0, 8).map((peer) => {
    const info = asRecord(peer);
    return {
      clientType: readNumber(info.client_type_),
      customClientType: readNumber(info.custom_client_type_),
    };
  });
  console.warn(
    `NetEase NIM multispot login: notifyType=${notifyType ?? "unknown"} peerCount=${peers.length} peerTypes=${JSON.stringify(peerTypes)} fields=${Object.keys(result).join(",")}`,
  );
});

client.on?.("kickout", (...args: unknown[]) => {
  const result = asRecord(args[0]);
  const reason = readNumber(result.kick_reason_) ?? readNumber(result.reason_);
  const clientType = readNumber(result.client_type_);
  const customClientType = readNumber(result.custom_client_type_);
  this.markImOffline();
  this.loggedInAccount = null;
  this.rejectImReadyWaiters(new Error("NIM client was kicked out"));
  console.warn(
    `NetEase NIM client was kicked out: reason=${reason ?? "unknown"} clientType=${clientType ?? "unknown"} customClientType=${customClientType ?? "unknown"} fields=${Object.keys(result).join(",")}`,
  );
});
  }

  private async connectInternal(options: ConnectOptions): Promise<void> {
    const generation = ++this.generation;
    const roomNumber = numericChatRoomId(options.chatRoomId);
    this.status = {
      enabled: this.enabled,
      connected: false,
      roomId: options.roomId,
      chatRoomId: options.chatRoomId,
      credentialsReady: true,
      lastPlaybackEvent: this.status.lastPlaybackEvent,
      lastChatMessage: this.status.lastChatMessage,
      lastError: null,
    };

    await this.ensureRuntime(options.credentials);
    const chatroom = this.chatroom;
    const plugin = this.nimPlugin;
    if (!chatroom || !plugin) throw new Error("NIM realtime runtime is unavailable");

    if (this.roomNumber !== null && this.roomNumber !== roomNumber) {
      try {
        chatroom.exit(this.roomNumber, "");
      } catch {
        // Best effort. Keep the native SDK alive and move to the new room.
      }
    }
    this.roomNumber = roomNumber;

    const [requestCode, requestLoginData] = await plugin.chatRoomRequestEnterAsync(roomNumber, null, "");
    if (requestCode !== 200 || !requestLoginData) {
      throw new Error(`NIM chatroom enter ticket failed code=${requestCode}`);
    }

    const entered = new Promise<void>((resolve, reject) => {
      this.pendingEnter = { generation, roomNumber, resolve, reject };
    });
    const started = chatroom.enter(
      roomNumber,
      requestLoginData,
      buildRealtimeChatRoomEnterInfo(options.memberProfile),
      "",
    );
    if (!started) {
      this.pendingEnter = null;
      throw new Error("NIM chatroom enter request was rejected locally");
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("NIM chatroom enter timed out")), ENTER_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });
    try {
      await Promise.race([entered, timeout]);
      if (generation !== this.generation) return;

      const profile = options.memberProfile;
      if (profile?.nick || profile?.avatar) {
        const memberUpdate: Record<string, unknown> = {
          account_id_: options.credentials.accId,
          ...(profile.nick ? { nick_: profile.nick.trim() } : {}),
          ...(profile.avatar ? { avatar_: profile.avatar.trim() } : {}),
        };
        const [, updateCode] = await chatroom.updateMyRoomRoleAsync(
          roomNumber,
          memberUpdate,
          false,
          "",
          null,
          "",
        );
        if (updateCode !== 200) {
          throw new Error(`NIM ChatRoom member profile update failed code=${updateCode}`);
        }

        const [, lookupCode, members] = await chatroom.getMemberInfoByIDsAsync(
          roomNumber,
          [options.credentials.accId],
          null,
          "",
        );
        if (lookupCode !== 200) {
          throw new Error(`NIM ChatRoom member profile verify failed code=${lookupCode}`);
        }
        const ownMember = asRecord(members[0]);
        console.log(
          `NetEase ChatRoom member profile synced: nick=${readString(ownMember.nick_) ? "present" : "empty"} avatar=${readString(ownMember.avatar_) ? "present" : "empty"}`,
        );
      }

      this.activeMemberProfile = options.memberProfile ?? null;
      this.status.connected = true;
      this.status.lastError = null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (this.pendingEnter?.generation === generation) this.pendingEnter = null;
    }
  }

  async sendChatRoomText(text: string): Promise<RealtimeChatSendResult> {
    const chatroom = this.chatroom;
    const roomNumber = this.roomNumber;
    const roomId = this.status.roomId;
    const chatRoomId = this.status.chatRoomId;
    if (!this.enabled) throw new Error("NetEase realtime transport is disabled");
    if (!this.status.connected || !chatroom || roomNumber === null || !roomId || !chatRoomId) {
      throw new Error("Not connected to a NetEase ChatRoom");
    }

    const messageId = randomUUID();
    const msg = buildRealtimeChatTextMessage(text, roomId, messageId, this.activeMemberProfile ?? undefined);
    const normalized = text.trim();

    return await new Promise<RealtimeChatSendResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(messageId);
        reject(new Error("NIM ChatRoom send timed out"));
      }, SEND_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingSends.set(messageId, { roomNumber, roomId, chatRoomId, text: normalized, timeout, resolve, reject });

      let accepted = false;
      try {
        accepted = chatroom.sendMsg(roomNumber, msg, "");
      } catch (error) {
        this.pendingSends.delete(messageId);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("NIM ChatRoom send threw an unknown error"));
        return;
      }
      if (!accepted) {
        this.pendingSends.delete(messageId);
        clearTimeout(timeout);
        reject(new Error("NIM ChatRoom send request was rejected locally"));
      }
    });
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    for (const [messageId, pending] of this.pendingSends) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("NIM ChatRoom disconnected before send completed"));
      this.pendingSends.delete(messageId);
    }
    const pending = this.pendingEnter;
    this.pendingEnter = null;
    pending?.reject(new Error("NIM chatroom enter cancelled"));

    const roomNumber = this.roomNumber;
    this.roomNumber = null;
    this.status.connected = false;
    this.status.roomId = null;
    this.status.chatRoomId = null;
    this.status.credentialsReady = false;
    this.activeMemberProfile = null;

    if (roomNumber !== null && this.chatroom) {
      try {
        this.chatroom.exit(roomNumber, "");
      } catch {
        // Best-effort room exit. Keep the NIM runtime initialized for reuse.
      }
    }
  }

  recordConnectionError(error: unknown): void {
    this.status.connected = false;
    this.status.lastError = error instanceof Error ? error.message : "NIM realtime connect failed";
  }
}
