import assert from "node:assert/strict";
import test from "node:test";
import { buildListenerHtml } from "../src/listener-html.js";

test("listener keeps local health telemetry and outstanding recovery controls", () => {
  const html = buildListenerHtml();
  assert.match(html, /监听时长/);
  assert.match(html, /NIM：/);
  assert.match(html, /netease_together_realtime_status/);
  assert.match(html, /cove_bridge_replay_outstanding/);
  assert.match(html, /cove_bridge_cancel_outstanding/);
  assert.match(html, /重新触发/);
  assert.match(html, /取消此条/);
});
