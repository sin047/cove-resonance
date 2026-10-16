import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { NeteaseApiError, NeteaseClient } from "../src/netease/client.js";

const require = createRequire(import.meta.url);
const sdk = require("NeteaseCloudMusicApi") as Record<string, (...args: any[]) => Promise<unknown>>;

test("playlist_tracks accepts HTTP 200 when response body omits code", async () => {
  const original = sdk.playlist_tracks;
  sdk.playlist_tracks = async () => ({ status: 200, body: {} });

  try {
    const client = new NeteaseClient("MUSIC_U=test");
    await client.updatePlaylistTracks("123", ["456"], "add");
  } finally {
    sdk.playlist_tracks = original;
  }
});

test("playlist_tracks accepts an API error when the requested add postcondition is already true", async () => {
  const originalTracks = sdk.playlist_tracks;
  const originalDetail = sdk.playlist_detail;
  sdk.playlist_tracks = async () => ({
    status: 200,
    body: { code: 502, message: "unexpected upstream result" },
  });
  sdk.playlist_detail = async () => ({
    status: 200,
    body: {
      code: 200,
      playlist: {
        trackCount: 1,
        trackIds: [{ id: 456 }],
      },
    },
  });

  try {
    const client = new NeteaseClient("MUSIC_U=test");
    await client.updatePlaylistTracks("123", ["456"], "add");
  } finally {
    sdk.playlist_tracks = originalTracks;
    sdk.playlist_detail = originalDetail;
  }
});

test("playlist_tracks keeps API-level error when the requested postcondition is false", async () => {
  const originalTracks = sdk.playlist_tracks;
  const originalDetail = sdk.playlist_detail;
  sdk.playlist_tracks = async () => ({
    status: 200,
    body: { code: 502, message: "write failed" },
  });
  sdk.playlist_detail = async () => ({
    status: 200,
    body: {
      code: 200,
      playlist: {
        trackCount: 1,
        trackIds: [{ id: 999 }],
      },
    },
  });

  try {
    const client = new NeteaseClient("MUSIC_U=test");
    await assert.rejects(
      () => client.updatePlaylistTracks("123", ["456"], "add"),
      (error: unknown) => error instanceof NeteaseApiError && error.code === 502,
    );
  } finally {
    sdk.playlist_tracks = originalTracks;
    sdk.playlist_detail = originalDetail;
  }
});
