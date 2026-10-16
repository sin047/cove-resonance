# 本地 V2 迁移保留清单

这份文件用于防止迁移到 upstream V2 时丢掉已经在真实环境验证过的本地修复。

## 基线

- 生产 `main` 在迁移开始时：`9bbc9ec571a5c72d2a866beb85cbc556c5f8b2fb`
- upstream V2 最新基线：`e63cfa5f29730b2fa9d90406fc882a6eba8d22e1`
- 集成分支：`v2-integration`
- 原始 upstream 快照：`v2-migration`

生产 `main` 在完整验收前保持不动。

## 必须保留 / 重新适配

### 1. 歌单写入真实状态确认

已在真实网易云账号验证：`playlist_tracks` 有时已经完成写入，但响应体会让 SDK 抛错；不能只根据一次响应判断成功失败。

本地修复要求：

- API code 读取兼容 `body.code`、嵌套 `body.body.code`、HTTP `status`；
- add/del 报错后读取歌单真实 trackIds；
- add 后目标歌曲已存在 -> 视为成功；
- del 后目标歌曲已不存在 -> 视为成功；
- 真实状态未满足 postcondition 时才保留原错误。

该修复已经用真实歌单验证过：正常新增、重复新增、读回、删除均工作。

### 2. Listener 可视状态

保留我们已经使用过的 Widget 状态信息：

- 监听持续时长；
- NIM 在线 / 离线 / 检测失败状态；
- SSE 状态继续由 V2 自己管理。

### 3. required reply 卡死恢复

旧版已有：

- required reply 等待超过 60 秒后显示恢复区；
- “重新触发”；
- “取消此条”；
- 显示后续待处理 conversation 数量。

迁到 V2 时不照搬旧队列删除语义：

- 优先复用 V2 的 terminal `dismissed` 语义；
- 取消后旧事件必须终止，不能重新复活；
- replay 只重新触发当前 outstanding event，不创建新 eventId；
- 保持 required-reply backpressure。

### 4. 现有交互细节

- routed reply 保持 2–5 个自然短气泡默认策略；
- 普通 ChatGPT 对话不能误发到网易云；
- Widget / Long-wait 两种 Listener 不同时运行；
- source/message ID 去重不可回退。

## 已由 upstream V2 更好覆盖，不搬旧实现

以下旧本地代码只保留需求，不保留旧实现：

- NIM login timeout / runtime reset：采用 V2 `nimTicketBootstrap` 与新的 realtime 生命周期；
- 播放状态主链路：采用 V2 realtime-primary；
- Together PAUSE / RESUME / GOTO / NEXT / ENQUEUE_NEXT：采用 V2 realtime confirmation；
- reliable leave：采用 V2 authoritative leave；
- custom ChatRoom payload 解析与 message-id 去重：采用 V2；
- Bridge 模块拆分：采用 V2 `bridge/*` / `netease/registerTogetherTools.ts`；
- Debian/glibc Docker：upstream 已使用 `node:22-slim`，满足原本地修复目标。

## 验收清单

合并到 `main` 前至少验证：

1. `npm test`
2. `npm run build`
3. `git diff --check`
4. Zeabur 启动成功，NIM realtime online
5. 手机端真实 Together：邀请 / 入房 / 聊天 / routed reply
6. 换歌、暂停、继续、next、enqueue-next 均有 realtime confirmation
7. Widget Listener：SSE + fallback 正常
8. Long-wait：wait -> ack -> required reply -> next wait
9. Listener 状态显示：监听时长 + NIM 状态
10. outstanding required reply 60s 后：replay / dismiss 恢复路径
11. 歌单：创建 / add / 重复 add / readback / remove；不能再出现“实际写入成功但工具报失败”
12. `main` / 当前 Zeabur 正式服务在验收完成前不切换
