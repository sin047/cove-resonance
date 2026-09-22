const FALLBACK_POLL_MS = 60_000;
const RECOVERY_GRACE_MS = 60_000;

export function buildListenerHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Cove Bridge</title>
<style>
  :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
  *{box-sizing:border-box}
  body{margin:0;padding:12px;background:transparent;color:CanvasText}
  .card{padding:14px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 92%,transparent)}
  .title{font-weight:650}.status{margin-top:9px;font-size:12px;opacity:.72}
  button{margin-top:12px;padding:8px 12px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);background:Canvas;color:CanvasText;font:inherit;cursor:pointer}
  button:disabled{opacity:.55;cursor:default}
  .recovery{margin-top:12px;padding:10px;border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:10px}
  .recovery[hidden]{display:none}.recovery-actions{display:flex;gap:8px;flex-wrap:wrap}.recovery-actions button{margin-top:8px}
</style>
</head>
<body>
<main class="card">
  <div class="title">Cove Bridge</div>
  <div id="status" class="status">已挂载，尚未监听。</div>
  <div id="meta" class="status">监听时长：— · NIM：待检测</div>
  <section id="recovery" class="recovery" hidden>
    <div id="recoveryText" class="status"></div>
    <div class="recovery-actions">
      <button id="replay" type="button" disabled>重新触发</button>
      <button id="cancel" type="button" disabled>取消此条</button>
    </div>
  </section>
  <button id="toggle" type="button" disabled>正在连接…</button>
</main>
<script>
(() => {
const FALLBACK_POLL_MS = ${FALLBACK_POLL_MS};
const RECOVERY_GRACE_MS = ${RECOVERY_GRACE_MS};
const pending = new Map();
let rpcId = 0;
let timer = 0;
let listening = false;
let inFlight = false;
let syncQueued = false;
let bridgeReady = false;
let streamAbort = null;
let streamGeneration = 0;
let sseConnected = false;
let listeningStartedAt = 0;
let metaTimer = 0;
let nimState = '待检测';
let nimCheckInFlight = false;
let activeOutstandingId = '';
let recoveryBusy = false;
  const DISPATCHED_STORAGE_KEY = 'cove-bridge-dispatched-v1';
  const PENDING_ACK_STORAGE_KEY = 'cove-bridge-pending-acks-v1';
  const MAX_RECENT_DISPATCHED = 128;
  const recentlyDispatched = new Set();
  const pendingAcks = new Set();

  const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const recoveryEl = document.getElementById('recovery');
const recoveryTextEl = document.getElementById('recoveryText');
const replayEl = document.getElementById('replay');
const cancelEl = document.getElementById('cancel');
const toggleEl = document.getElementById('toggle');
const setStatus = (text) => { statusEl.textContent = text; };

function hideRecovery() {
  activeOutstandingId = '';
  recoveryEl.hidden = true;
  replayEl.disabled = true;
  cancelEl.disabled = true;
}

function renderRecovery(state) {
  const eventId = String(state.eventId || '');
  const waitingMs = Math.max(0, Number(state.awaitingReplyForMs) || 0);
  const waitingSeconds = Math.floor(waitingMs / 1000);
  const queuedConversation = Math.max(0, Number(state.queuedConversation) || 0);
  const queuedSuffix = queuedConversation > 0 ? ' · 后续待处理 ' + queuedConversation + ' 条' : '';
  const canRecover = waitingMs >= RECOVERY_GRACE_MS && !recoveryBusy;
  activeOutstandingId = eventId;
  recoveryEl.hidden = false;
  recoveryTextEl.textContent = canRecover
    ? '事件 ' + eventId.slice(0, 8) + '… 已等待 ' + waitingSeconds + ' 秒' + queuedSuffix + '，可以重新触发或取消。'
    : '事件 ' + eventId.slice(0, 8) + '… 已等待 ' + waitingSeconds + ' 秒' + queuedSuffix + '；60 秒后开放恢复操作。';
  replayEl.disabled = !canRecover;
  cancelEl.disabled = !canRecover;
}

  function readStoredIds(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  function writeStoredIds(key, ids) {
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {}
  }

  for (const id of readStoredIds(DISPATCHED_STORAGE_KEY)) recentlyDispatched.add(id);
  for (const id of readStoredIds(PENDING_ACK_STORAGE_KEY)) pendingAcks.add(id);

  function rememberDispatched(eventId) {
    recentlyDispatched.delete(eventId);
    recentlyDispatched.add(eventId);
    while (recentlyDispatched.size > MAX_RECENT_DISPATCHED) {
      const oldest = recentlyDispatched.values().next().value;
      if (!oldest) break;
      recentlyDispatched.delete(oldest);
    }
    writeStoredIds(DISPATCHED_STORAGE_KEY, [...recentlyDispatched]);
  }

  function rememberPendingAck(eventId) {
    pendingAcks.add(eventId);
    writeStoredIds(PENDING_ACK_STORAGE_KEY, [...pendingAcks]);
  }

  function forgetPendingAck(eventId) {
    pendingAcks.delete(eventId);
    writeStoredIds(PENDING_ACK_STORAGE_KEY, [...pendingAcks]);
  }

  async function flushPendingAcks() {
    for (const eventId of [...pendingAcks]) {
      try {
        await callTool('cove_bridge_delivered', { eventId });
        forgetPendingAck(eventId);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message.includes('Unknown event')) {
          forgetPendingAck(eventId);
          continue;
        }
        return false;
      }
    }
    return true;
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  function request(method, params) {
    const id = ++rpcId;
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 18000);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || 'Host request failed'));
    else entry.resolve(message.result);
  }, { passive: true });

  async function initialize() {
    await request('ui/initialize', {
      appInfo: { name: 'cove-bridge-widget', version: '0.1.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26'
    });
    notify('ui/notifications/initialized', {});
    bridgeReady = true;
    toggleEl.disabled = false;
    toggleEl.textContent = '开始监听';
    setStatus('已挂载，尚未监听。');
  }

  async function callTool(name, args) {
    if (!bridgeReady) throw new Error('Bridge is not initialized');
    return request('tools/call', { name, arguments: args || {} });
  }

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function setIdleStatus() {
    if (!listening) return;
    setStatus(sseConnected
      ? 'SSE 实时监听中，暂无新事件。'
      : '监听中（SSE 重连中，60 秒轮询兜底）。');
  }
  function formatListeningDuration() {
  if (!listening || !listeningStartedAt) return '—';

  const totalMinutes = Math.floor(
    (Date.now() - listeningStartedAt) / 60_000
  );

  if (totalMinutes < 60) {
    return totalMinutes + ' 分钟';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + ' 小时 ' + minutes + ' 分钟';
}

function renderMetaStatus() {
  metaEl.textContent =
    '监听时长：' + formatListeningDuration()
    + ' · NIM：' + nimState;
}

async function refreshNimStatus() {
  if (!listening || nimCheckInFlight) return;

  nimCheckInFlight = true;

  try {
    const result = await callTool(
      'netease_together_realtime_status',
      {}
    );
    const state = result && result.structuredContent;

    nimState =
      state && state.connected
        ? '在线'
        : '离线';
  } catch {
    nimState = '检测失败';
  } finally {
    nimCheckInFlight = false;
    renderMetaStatus();
  }
}

function startMetaStatus() {
  listeningStartedAt = Date.now();
  nimState = '待检测';

  window.clearInterval(metaTimer);
  renderMetaStatus();
  void refreshNimStatus();

  metaTimer = window.setInterval(() => {
    renderMetaStatus();
    void refreshNimStatus();
  }, 10_000);
}

function stopMetaStatus() {
  window.clearInterval(metaTimer);
  metaTimer = 0;
  listeningStartedAt = 0;
  nimState = '待检测';
  renderMetaStatus();
}

  async function openWakeStream(generation) {
    let retryMs = 1000;

    while (listening && generation === streamGeneration) {
      try {
        const sessionResult = await callTool('cove_bridge_listener_session', {});
        const session = sessionResult && sessionResult.structuredContent;
        if (!session || !session.token || !session.streamUrl) {
          throw new Error('Bridge did not return a wake-stream session');
        }

        const streamUrl = new URL(String(session.streamUrl));
        streamUrl.searchParams.set('session', String(session.token));

        await new Promise((resolve, reject) => {
          const source = new EventSource(streamUrl.toString());
          streamAbort = { abort: () => source.close() };

          const fail = () => {
            source.close();
            reject(new Error('EventSource disconnected'));
          };

          source.onopen = () => {
            sseConnected = true;
            retryMs = 1000;
            setStatus('SSE 实时监听中。');
          };

          source.addEventListener('wake', () => {
            void syncOnce();
          });

          source.addEventListener('session-expired', () => {
            source.close();
            resolve();
          });

          source.onerror = fail;
        });
      } catch (error) {
        if (!listening || generation !== streamGeneration) return;
        const message = error && error.message ? error.message : String(error);
        setStatus('SSE 暂时断开：' + message + '；60 秒轮询兜底，正在重连…');
      } finally {
        if (generation === streamGeneration) {
          sseConnected = false;
          streamAbort = null;
        }
      }

      if (!listening || generation !== streamGeneration) return;
      await sleep(retryMs);
      retryMs = Math.min(15_000, retryMs * 2);
    }
  }

  async function dispatch(event, preferCompatibility) {
    await request('ui/update-model-context', {
      content: [{
        type: 'text',
        text: String(event.modelContext || ''),
        annotations: { audience: ['assistant'], priority: 1 }
      }],
      structuredContent: {
        bridgeEvent: {
          eventId: String(event.id),
          correlationId: String(event.correlationId || event.id),
          kind: String(event.kind || ''),
          source: String(event.source || ''),
          stream: String(event.stream || ''),
          stateKey: String(event.stateKey || ''),
          replyRoute: String(event.replyRoute || ''),
          replyPolicy: String(event.replyPolicy || ''),
          createdAt: String(event.createdAt || '')
        }
      }
    });
    if (
      preferCompatibility
      && window.openai
      && typeof window.openai.sendFollowUpMessage === 'function'
    ) {
      await window.openai.sendFollowUpMessage({
        prompt: String(event.visibleText || ''),
        scrollToBottom: true
      });
      return;
    }
    await request('ui/message', {
      role: 'user',
      content: [{ type: 'text', text: String(event.visibleText || '') }]
    });
  }

  async function syncOnce() {
  if (!listening) return;

  if (inFlight) {
    syncQueued = true;
    return;
  }

  inFlight = true;
  syncQueued = false;
    
    
    let shouldContinue = false;
    try {
      const acksFlushed = await flushPendingAcks();
      if (!acksFlushed) {
        setStatus('事件已显示，正在重试送达确认；不会重复显示。');
        return;
      }

      const result = await callTool('cove_bridge_sync', {});
      const event = result && result._meta && result._meta.event;
      if (!event) {
        const state = result && result.structuredContent;
    
      if (state && state.awaitingReply) {
  renderRecovery(state);
  const waitingSeconds = Math.floor((Number(state.awaitingReplyForMs) || 0) / 1000);
  setStatus(waitingSeconds >= 60
    ? '当前消息等待回传已超过 60 秒，可使用恢复操作。'
    : '等待当前消息完成回传…' + waitingSeconds + ' 秒');
  window.setTimeout(() => void syncOnce(), 2000);
} else {
  hideRecovery();
  setIdleStatus();
}  
        return;
      }

      hideRecovery();
      const eventId = String(event.id);
      if (recentlyDispatched.has(eventId)) {
        rememberPendingAck(eventId);
        const acked = await flushPendingAcks();
        if (!acked) {
          setStatus('重复事件已拦截，正在重试送达确认。');
          return;
        }
        shouldContinue = true;
        setStatus('重复投递已拦截。');
        return;
      }

      setStatus('正在投递事件…');
      try {
        await dispatch(event);
      } catch (error) {
        await callTool('cove_bridge_release', { eventId }).catch(() => {});
        throw error;
      }

      // From this point onward the host has already accepted the visible message.
      // Never release it back to pending if the acknowledgement RPC fails, or the
      // same user-visible event can be dispatched again.
      rememberDispatched(eventId);
      rememberPendingAck(eventId);
      const acked = await flushPendingAcks();
      if (!acked) {
        setStatus('事件已显示，正在重试送达确认；不会重复显示。');
        return;
      }

      shouldContinue = true;
      setStatus('事件已送达。');
    } catch (error) {
      setStatus('监听错误：' + (error && error.message ? error.message : String(error)));
    } finally {
  inFlight = false;

  if (listening && (shouldContinue || syncQueued)) {
    syncQueued = false;
    window.setTimeout(() => void syncOnce(), 0);
  }
}
  }

  async function replayOutstanding() {
    const eventId = activeOutstandingId;
    if (!eventId || recoveryBusy) return;
    recoveryBusy = true;
    replayEl.disabled = true;
    cancelEl.disabled = true;
    setStatus('正在重新触发悬挂消息…');
    try {
      const result = await callTool('cove_bridge_replay_outstanding', { eventId });
      const event = result && result._meta && result._meta.event;
      if (!event) throw new Error('Bridge did not return the outstanding event');
      await dispatch(event, true);
      rememberDispatched(eventId);
      await callTool('cove_bridge_delivered', { eventId });
      forgetPendingAck(eventId);
      setStatus('已重新触发，等待本轮回传…');
    } catch (error) {
      setStatus('重新触发失败：' + (error && error.message ? error.message : String(error)));
    } finally {
      recoveryBusy = false;
      window.setTimeout(() => void syncOnce(), 2000);
    }
  }

  async function cancelOutstanding() {
    const eventId = activeOutstandingId;
    if (!eventId || recoveryBusy) return;
    if (!window.confirm('确认取消这条悬挂消息并继续处理后续消息？')) return;
    recoveryBusy = true;
    replayEl.disabled = true;
    cancelEl.disabled = true;
    setStatus('正在取消悬挂消息…');
    try {
      const result = await callTool('cove_bridge_cancel_outstanding', { eventId });
      const state = result && result.structuredContent;
      if (!state || !state.cancelled) throw new Error('Outstanding event was not cancelled');
      forgetPendingAck(eventId);
      hideRecovery();
      setStatus('悬挂消息已取消，继续处理后续队列。');
      window.setTimeout(() => void syncOnce(), 0);
    } catch (error) {
      setStatus('取消失败：' + (error && error.message ? error.message : String(error)));
    } finally {
      recoveryBusy = false;
    }
  }

  function scheduleFallback() {
    window.clearInterval(timer);
    if (!listening) return;
    timer = window.setInterval(() => void syncOnce(), FALLBACK_POLL_MS);
  }

  function startListening() {
  listening = true;
  startMetaStatus();
  toggleEl.textContent = '停止监听';
  setStatus('正在建立 SSE 实时监听…');
  scheduleFallback();
  streamGeneration += 1;
  const generation = streamGeneration;
  void openWakeStream(generation);
  void syncOnce();
}

 function stopListening() {
  listening = false;
  stopMetaStatus();
  hideRecovery();
  toggleEl.textContent = '开始监听';
  window.clearInterval(timer);
  streamGeneration += 1;
  sseConnected = false;
  if (streamAbort) streamAbort.abort();
  streamAbort = null;
  setStatus('已暂停。');
} 

  toggleEl.addEventListener('click', () => {
    if (listening) stopListening();
    else startListening();
  });
  replayEl.addEventListener('click', () => void replayOutstanding());
  cancelEl.addEventListener('click', () => void cancelOutstanding());

  initialize().catch((error) => {
    toggleEl.disabled = true;
    toggleEl.textContent = '连接失败';
    setStatus('组件连接失败：' + (error && error.message ? error.message : String(error)));
  });
})();
</script>
</body>
</html>`;
}
