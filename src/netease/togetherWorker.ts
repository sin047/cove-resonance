import { NeteaseApiError, NeteaseClient, type AccountProfile } from "./client.js";
import { collectContactUserIds, parseLatestInvite } from "./inviteParser.js";
import { buildFullLyricsModelContext, countAvailableLyricPayloads } from "./lyricsContext.js";
import type { PlaybackStateSink } from "./playbackState.js";
import { NeteaseRealtimeTransport, type RealtimeChatRoomMessage, type RealtimeChatSendResult, type RealtimeTransportStatus } from "./realtimeTransport.js";
import type {
  PlayingState,
  SongDetails,
  TogetherInvite,
  TogetherWorkerStatus,
} from "./types.js";

type EventSink = (source: string, text: string, modelContext?: string) => unknown;

type TogetherWorkerOptions = {
  cookie: string;
  enabled: boolean;
  inviterUid?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  onEvent: EventSink;
  stateSink?: PlaybackStateSink;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TogetherWorker {
  private readonly client: NeteaseClient;
  private readonly realtime: NeteaseRealtimeTransport;
  private readonly handledInvites = new Set<string>();
  private readonly handledChatMessageKeys = new Set<string>();
  private running = false;
  private roomId: string | null = null;
  private chatRoomId: string | null = null;
  private previousSongId: string | null = null;
  private previousPlayStatus: PlayingState["playStatus"] = "UNKNOWN";
  private joinedPending = false;
  private lastHeartbeatAt = 0;
  private lastRealtimeAttemptAt = 0;
  private errorStreak = 0;
  private accountProfile: AccountProfile | null = null;
  private currentLyricsModelContext: string | null = null;
  private status: TogetherWorkerStatus;

  constructor(private readonly options: TogetherWorkerOptions) {
    this.client = new NeteaseClient(options.cookie);
    this.realtime = new NeteaseRealtimeTransport(options.enabled, (message) => {
      this.handleRealtimeChatMessage(message);
    });
    this.status = {
      enabled: options.enabled,
      phase: options.enabled ? "starting" : "disabled",
      accountId: null,
      roomId: null,
      currentSong: null,
      playStatus: "UNKNOWN",
      lastPollAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    };
  }

  getStatus(): TogetherWorkerStatus {
    return { ...this.status };
  }

  getRealtimeStatus(): RealtimeTransportStatus {
    return this.realtime.getStatus();
  }

  async sendChatRoomText(text: string): Promise<RealtimeChatSendResult> {
    return await this.realtime.sendChatRoomText(text);
  }

  start(): void {
    if (this.running || !this.options.enabled) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      this.accountProfile = await this.client.getAccountProfile();
      this.status.accountId = this.accountProfile.id;
      this.status.phase = "waiting_invite";
      console.log(`NetEase Together worker ready for account ${this.status.accountId}`);
    } catch (error) {
      this.recordError(error, "Cookie validation failed");
    }

    while (this.running) {
      const startedAt = Date.now();
      try {
        if (!this.status.accountId) {
          this.accountProfile = await this.client.getAccountProfile();
          this.status.accountId = this.accountProfile.id;
        }
        await this.pollOnce();
        this.errorStreak = 0;
        this.status.lastError = null;
      } catch (error) {
        if (error instanceof NeteaseApiError && error.code === 488) {
          this.leaveRoom("房间已经结束了。一起听已退出，继续等待下一次邀请。");
        } else {
          this.recordError(error, "Together poll failed");
        }
      }

      const base = this.options.pollIntervalMs ?? 4000;
      const backoff = this.errorStreak > 0
        ? Math.min(60_000, base * 2 ** Math.min(this.errorStreak, 4))
        : base;
      await sleep(Math.max(250, backoff - (Date.now() - startedAt)));
    }
  }

  private async pollOnce(): Promise<void> {
    this.status.lastPollAt = new Date().toISOString();
    const remote = await this.client.getRoomStatus();

    if (remote.inRoom && remote.roomId) {
      if (this.roomId !== remote.roomId) {
        this.enterRoom(remote.roomId, remote.chatRoomId);
      } else if (remote.chatRoomId && remote.chatRoomId !== this.chatRoomId) {
        this.chatRoomId = remote.chatRoomId;
      }
      if (remote.chatRoomId) void this.ensureRealtime(remote.roomId, remote.chatRoomId);
    } else if (this.roomId) {
      this.leaveRoom("一起听已经结束了。我会继续等你的下一次邀请。");
    }

    if (!this.roomId) {
      this.status.phase = "waiting_invite";
      const invite = await this.findInvite();
      if (!invite) return;
      await this.acceptInvite(invite);
    }

    if (!this.roomId) return;
    this.status.phase = "listening";
    const playing = await this.client.getPlaying(this.roomId);
    this.updateState((sink) => sink.updatePlayback({
      songId: playing.songId,
      playStatus: playing.playStatus,
      progressMs: playing.progress,
      observedAtMs: Date.now(),
      ...(playing.serverSeq === undefined ? {} : { serverSeq: playing.serverSeq }),
    }));
    await this.maybeHeartbeat(playing);
    await this.handlePlaying(playing);
  }

  private async ensureRealtime(roomId: string, chatRoomId: string): Promise<void> {
    const realtimeStatus = this.realtime.getStatus();
    if (
      realtimeStatus.connected
      && realtimeStatus.roomId === roomId
      && realtimeStatus.chatRoomId === chatRoomId
    ) return;

    const now = Date.now();
    if (now - this.lastRealtimeAttemptAt < 10_000) return;
    this.lastRealtimeAttemptAt = now;

    try {
      const credentials = await this.client.getRealtimeCredentials();
      console.log(
  `NetEase NIM realtime credentials acquired for account ${this.status.accountId ?? "unknown"}; addresses=${JSON.stringify(
    credentials.addresses.map((value) => value.split("?")[0]),
  )}`,
);
        
      
      if (!this.accountProfile) {
        this.accountProfile = await this.client.getAccountProfile();
        this.status.accountId = this.accountProfile.id;
      }
      await this.realtime.connect({
        roomId,
        chatRoomId,
        credentials,
        memberProfile: {
          userId: this.accountProfile.id,
          ...(this.accountProfile.nickname ? { nick: this.accountProfile.nickname } : {}),
          ...(this.accountProfile.avatarUrl ? { avatar: this.accountProfile.avatarUrl } : {}),
          ...(this.accountProfile.gender !== null ? { gender: this.accountProfile.gender } : {}),
        },
      });
      console.log(`NetEase NIM realtime connected: roomId=${roomId} chatRoomId=${chatRoomId}`);
    } catch (error) {
      this.realtime.recordConnectionError(error);
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`NetEase NIM realtime connect failed: ${detail}`);
    }
  }

  private async findInvite(): Promise<TogetherInvite | null> {
    const ownId = this.status.accountId;
    if (!ownId) return null;
    let contactIds: string[];

    if (this.options.inviterUid) {
      contactIds = [this.options.inviterUid];
    } else {
      const contacts = await this.client.getRecentContacts();
      contactIds = collectContactUserIds(contacts, ownId);
    }

    for (const uid of contactIds) {
      const history = await this.client.getPrivateHistory(uid);
      const invite = parseLatestInvite(history, uid);
      if (invite && !this.handledInvites.has(invite.roomId)) return invite;
    }
    return null;
  }

  private async acceptInvite(invite: TogetherInvite): Promise<void> {
    this.status.phase = "joining";
    this.handledInvites.add(invite.roomId);
    if (this.handledInvites.size > 50) {
      const oldest = this.handledInvites.values().next().value as string | undefined;
      if (oldest) this.handledInvites.delete(oldest);
    }
    try {
      const accepted = await this.client.acceptInvite(invite.roomId, invite.inviterId);
      this.enterRoom(accepted.roomId ?? invite.roomId, accepted.chatRoomId);
      if (accepted.roomId && accepted.chatRoomId) {
        await this.ensureRealtime(accepted.roomId, accepted.chatRoomId);
      }
    } catch (error) {
      this.handledInvites.delete(invite.roomId);
      throw error;
    }
  }

  private enterRoom(roomId: string, chatRoomId: string | null = null): void {
    const changedRoom = this.roomId !== roomId;
    if (changedRoom) void this.realtime.disconnect();
    this.roomId = roomId;
    this.chatRoomId = chatRoomId;
    this.previousSongId = null;
    this.previousPlayStatus = "UNKNOWN";
    this.currentLyricsModelContext = null;
    this.joinedPending = true;
    this.lastHeartbeatAt = 0;
    this.lastRealtimeAttemptAt = 0;
    this.status.roomId = roomId;
    this.status.currentSong = null;
    this.status.playStatus = "UNKNOWN";
    this.status.phase = "listening";
    this.updateState((sink) => sink.enterRoom(roomId));
  }

  private leaveRoom(message: string): void {
    const wasInRoom = Boolean(this.roomId);
    this.roomId = null;
    this.chatRoomId = null;
    this.previousSongId = null;
    this.previousPlayStatus = "UNKNOWN";
    this.currentLyricsModelContext = null;
    this.joinedPending = false;
    this.lastHeartbeatAt = 0;
    this.lastRealtimeAttemptAt = 0;
    this.status.roomId = null;
    this.status.currentSong = null;
    this.status.playStatus = "UNKNOWN";
    this.status.phase = "waiting_invite";
    void this.realtime.disconnect();
    this.updateState((sink) => sink.leaveRoom());
    if (wasInRoom) this.options.onEvent("netease.together", message);
  }

  private async maybeHeartbeat(playing: PlayingState): Promise<void> {
    if (!this.roomId) return;
    const interval = this.options.heartbeatIntervalMs ?? 10_000;
    if (Date.now() - this.lastHeartbeatAt < interval) return;
    await this.client.sendHeartbeat(
      this.roomId,
      playing.songId,
      playing.playStatus === "PLAY",
      playing.progress,
    );
    this.lastHeartbeatAt = Date.now();
    this.status.lastHeartbeatAt = new Date(this.lastHeartbeatAt).toISOString();
  }

  private async handlePlaying(playing: PlayingState): Promise<void> {
    this.status.playStatus = playing.playStatus;
    const statusChanged = this.previousPlayStatus !== playing.playStatus;

    if (playing.songId && playing.songId !== this.previousSongId) {
      const song = await this.client.getSongDetails(playing.songId);
      this.previousSongId = playing.songId;
      this.currentLyricsModelContext = null;
      this.status.currentSong = song;
      this.updateState((sink) => sink.updateSong(song));
      const lyricsContext = await this.loadLyrics(song);

      if (playing.playStatus === "PLAY") {
        const prefix = this.joinedPending
          ? "你把我拉进一起听啦。现在播放"
          : "你换到了";
        this.options.onEvent(
          "netease.music_changed",
          `${prefix}《${song.name}》— ${song.artist}。请结合我们的对话自然回应；如果没必要点评，也可以只安静陪听。`,
          lyricsContext,
        );
        this.joinedPending = false;
      }
    } else if (statusChanged && this.previousPlayStatus !== "UNKNOWN") {
      if (playing.playStatus === "PAUSE") {
        this.options.onEvent(
          "netease.playback",
          "一起听暂停了。",
          this.currentLyricsModelContext ?? undefined,
        );
      } else if (playing.playStatus === "PLAY") {
        const song = this.status.currentSong;
        this.options.onEvent(
          "netease.playback",
          song
            ? `一起听继续播放：《${song.name}》— ${song.artist}。`
            : "一起听继续播放了。",
          this.currentLyricsModelContext ?? undefined,
        );
        this.joinedPending = false;
      }
    }

    this.previousPlayStatus = playing.playStatus;
  }

  private handleRealtimeChatMessage(message: RealtimeChatRoomMessage): void {
    if (
  (message.category !== "text" && message.category !== "custom")
  || !message.text
) return;
    const ownAccountId = this.status.accountId;
    if (ownAccountId && message.senderId === ownAccountId) return;

    const roomKey = this.roomId ?? "no-room";
    const messageKey = message.messageId
      ? roomKey + ":" + message.messageId
      : roomKey + ":" + (message.senderId ?? "unknown") + ":" + String(message.timetagMs ?? message.receivedAtMs) + ":" + message.text;
    if (this.handledChatMessageKeys.has(messageKey)) {
      const suffix = message.messageId ? "***" + message.messageId.slice(-6) : "unknown";
      console.warn("NetEase duplicate ChatRoom message suppressed: messageId=" + suffix);
      return;
    }
    this.handledChatMessageKeys.add(messageKey);
    while (this.handledChatMessageKeys.size > 512) {
      const oldest = this.handledChatMessageKeys.values().next().value;
      if (!oldest) break;
      this.handledChatMessageKeys.delete(oldest);
    }

    this.options.onEvent(
      "netease.chatroom",
      message.text,
      this.currentLyricsModelContext ?? undefined,
    );
  }

  private async loadLyrics(song: SongDetails): Promise<string | undefined> {
    try {
      const lyrics = await this.client.getLyrics(song.id);
      this.updateState((sink) => sink.updateLyrics(song.id, lyrics));
      const modelContext = buildFullLyricsModelContext(song, lyrics);
      this.currentLyricsModelContext = modelContext;
      if (modelContext) {
        console.log(
          `Together full lyrics context ready: songId=${song.id} payloads=${countAvailableLyricPayloads(lyrics)} contextChars=${modelContext.length}`,
        );
      }
      return modelContext ?? undefined;
    } catch (error) {
      this.currentLyricsModelContext = null;
      const detail = error instanceof NeteaseApiError
        ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
        : error instanceof Error ? error.message : "unknown error";
      console.error(`Together lyrics load failed: ${detail}`);
      return undefined;
    }
  }

  private updateState(update: (sink: PlaybackStateSink) => void): void {
    if (!this.options.stateSink) return;
    try {
      update(this.options.stateSink);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`Together state update failed: ${detail}`);
    }
  }

  private recordError(error: unknown, prefix: string): void {
    this.errorStreak += 1;
    this.status.phase = this.errorStreak >= 3 ? "error" : "backoff";
    const detail = error instanceof NeteaseApiError
      ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
      : error instanceof Error ? error.message : "unknown error";
    this.status.lastError = `${prefix}: ${detail}`;
    console.error(this.status.lastError);
  }
}

export function createTogetherWorker(
  onEvent: EventSink,
  stateSink?: PlaybackStateSink,
): TogetherWorker {
  const cookie = process.env.NETEASE_COOKIE?.trim() ?? "";
  const explicitlyDisabled = /^(0|false|off|no)$/i.test(
    process.env.TOGETHER_ENABLED?.trim() ?? "",
  );
  const enabled = Boolean(cookie) && !explicitlyDisabled;
  const parseInterval = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 1000 ? value : fallback;
  };

  if (cookie && !cookie.includes("MUSIC_U=")) {
    console.warn("NETEASE_COOKIE is set but MUSIC_U is missing; Together worker may not authenticate.");
  }

  return new TogetherWorker({
    cookie,
    enabled,
    inviterUid: process.env.NETEASE_INVITER_UID?.trim() || undefined,
    pollIntervalMs: parseInterval("TOGETHER_POLL_INTERVAL_MS", 4000),
    heartbeatIntervalMs: parseInterval("TOGETHER_HEARTBEAT_INTERVAL_MS", 10_000),
    onEvent,
    stateSink,
  });
}
