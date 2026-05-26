# 本地 HTTP 测试通道

让微信 bot 在保留原有微信通道的同时，额外提供本地 HTTP 通道。AI/人可通过 curl 发消息、拉回复、查状态，实现自动化端到端测试。

## 架构

```
                   ┌─────────────────────────────────┐
   生产实例 ──→    │ iLink (微信服务器)              │
   (tsja/wife)     │ getupdates/sendmessage/typing   │
                   └────────────┬────────────────────┘
                                │
                                ▼
                  ┌──────────────────────────────────┐
                  │  bot.js (单进程)                  │
                  │  ┌────────────────────────────┐  │
                  │  │ messageLoop()              │  │
                  │  │   inbox = wechat ∪ local   │  │
                  │  │      ↓                     │  │
                  │  │   分流 (文本/文件/图/指令)   │  │
                  │  │      ↓                     │  │
                  │  │   sendMsgSafe              │  │
                  │  │   ├── 真 user_id → apiPost │  │
                  │  │   └── "local:" 前缀 → outbox│ │
                  │  └────────┬───────────────────┘  │
                  └───────────┼──────────────────────┘
                              │
                              ▼
                   ┌──────────────────────────┐
   测试实例 ──→    │ local-channel/           │
   (test-local)    │  HTTP server :9527       │
                   │  POST /local/inbox/*     │
                   │  GET  /local/outbox      │◀── curl (AI 编排)
                   │  GET  /local/state       │
                   │  POST /local/reset       │
                   └──────────────────────────┘
```

**关键设计**：
- **入口汇合**：messageLoop 每轮从微信拉到 0/N 条消息后，再拉 local inbox 队列；两路消息走同一段分流逻辑
- **出口分流**：`sendMsgSafe(toId, ...)` 检查 `toId.startsWith("local:")`，本地消息推 outbox，真消息走 `apiPost`
- **本地文件短路**：`downloadAndDecryptMedia` 首行检测 `media._local_path`，存在则 `fs.readFileSync` 返回 buffer，跳过 CDN+AES
- **测试实例完全不连微信**：通过 `LOCAL_TEST_PORT` 环境变量启用，跳过扫码/session/重连定时器

## 快速开始

### 1. 启动测试实例

```bash
# 方式 A：直接启动
cd instances/test-local
LOCAL_TEST_PORT=9527 node ../../bot.js

# 方式 B：PM2 启动
pm2 start ecosystem.config.cjs --only weixin-bot-test-local
```

### 2. 发送第一条消息

```bash
# 发文本消息
curl -s -X POST http://127.0.0.1:9527/local/inbox/text \
  -H "Content-Type: application/json" \
  -d '{"text": "你好，请做个自我介绍"}'

# 拉取 bot 回复（长轮询 15s）
curl -s "http://127.0.0.1:9527/local/outbox?since=0&wait_ms=15000" | jq .
```

### 3. 预期 outbox 输出

```json
{
  "events": [
    { "seq": 1, "kind": "typing", "to_user_id": "local:default", "status": 1 },
    { "seq": 2, "kind": "message", "to_user_id": "local:default", "text": "你好！我是..." },
    { "seq": 3, "kind": "typing", "to_user_id": "local:default", "status": 2 }
  ],
  "next_seq": 4
}
```

## HTTP API 参考

所有端点绑定 `127.0.0.1:${LOCAL_TEST_PORT}`，响应均为 JSON。

### 注入端点

#### `POST /local/inbox/text`

```bash
curl -X POST http://127.0.0.1:9527/local/inbox/text \
  -H "Content-Type: application/json" \
  -d '{"user_id": "local:u1", "text": "你好"}'
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `user_id` | 否 | `local:default` | 必须以 `local:` 开头 |
| `text` | 是 | - | 消息文本 |

#### `POST /local/inbox/file`

```bash
curl -X POST http://127.0.0.1:9527/local/inbox/file \
  -H "Content-Type: application/json" \
  -d '{"user_id": "local:u1", "file_path": "./fixtures/sample.docx"}'
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `user_id` | 否 | `local:default` | 必须以 `local:` 开头 |
| `file_path` | 是 | - | 文件路径（相对或绝对） |
| `file_name` | 否 | 从路径提取 | 文件名 |

#### `POST /local/inbox/image`

```bash
curl -X POST http://127.0.0.1:9527/local/inbox/image \
  -H "Content-Type: application/json" \
  -d '{"user_id": "local:u1", "file_path": "./fixtures/photo.jpg"}'
```

#### `POST /local/inbox/raw`

直接注入完整 iLink JSON，用于高级/边界场景。

```bash
curl -X POST http://127.0.0.1:9527/local/inbox/raw \
  -H "Content-Type: application/json" \
  -d '{"msg": {"message_id": "...", "from_user_id": "local:u1", ...}}'
```

#### `POST /local/reset`

清空指定用户的状态和 outbox。

```bash
# 清空特定用户
curl -X POST http://127.0.0.1:9527/local/reset \
  -H "Content-Type: application/json" \
  -d '{"user_id": "local:u1"}'

# 清空 outbox 全部事件
curl -X POST http://127.0.0.1:9527/local/reset \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 观察端点

#### `GET /local/outbox`

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `since` | `0` | 只返回 seq > since 的事件 |
| `wait_ms` | `0` | 长轮询超时（最大 60000ms） |

```bash
curl -s "http://127.0.0.1:9527/local/outbox?since=0&wait_ms=15000" | jq .
```

outbox 事件 schema：

```json
{ "seq": 1, "kind": "message", "to_user_id": "local:default", "context_token": "...", "text": "...", "ts": "..." }
{ "seq": 2, "kind": "typing", "to_user_id": "local:default", "status": 1, "ts": "..." }
```

#### `GET /local/state`

```bash
curl -s "http://127.0.0.1:9527/local/state?user_id=local:default" | jq .
```

返回脱敏快照：`pending_files`、`file_anchors`、`conversation_history`、`welcomed`、`daily_stats`。

#### `GET /local/health`

```bash
curl http://127.0.0.1:9527/local/health
```

## 测试场景手册

### 纯文本对话（多轮记忆）

```bash
# 第 1 轮
curl -X POST :9527/local/inbox/text -d '{"text":"我叫小明"}'
sleep 3
# 第 2 轮
curl -X POST :9527/local/inbox/text -d '{"text":"我叫什么名字？"}'
# 期望 AI 回复包含"小明"
```

### 单文件 + 文字

```bash
# 先发文件
curl -X POST :9527/local/inbox/file \
  -d '{"file_path":"./fixtures/report.docx"}'
sleep 2
# 等 bot 回复"已收到...请告诉我您的要求"
curl -s ":9527/outbox?since=0&wait_ms=10000" | jq .

# 再发指令
curl -X POST :9527/local/inbox/text \
  -d '{"text":"总结这个文件"}'
sleep 5
# 验证 AI 回复包含文件相关内容
curl -s ":9527/outbox?since=2&wait_ms=30000" | jq .
```

### 多文件合并

```bash
curl -X POST :9527/local/inbox/file -d '{"file_path":"./fixtures/a.docx"}'
curl -X POST :9527/local/inbox/file -d '{"file_path":"./fixtures/b.txt"}'
sleep 1
curl -X POST :9527/local/inbox/text -d '{"text":"对比这两个文件"}'
```

### 指令测试

```bash
curl -X POST :9527/local/inbox/text -d '{"text":"/help"}'
# 期望回复包含"可用指令"
```

### 错误路径

```bash
# 文件不存在
curl -X POST :9527/local/inbox/file -d '{"file_path":"./fixtures/nonexistent.docx"}'
# 期望返回 400 错误

# 非法 user_id（不以 local: 开头）
curl -X POST :9527/local/inbox/text \
  -d '{"user_id":"evil_user","text":"hi"}'
# 期望返回 400 错误
```

## AI 编排测试的推荐模式

```
1. POST /local/inbox/text { text }       → 立即返回 { ok: true }
2. GET /local/outbox?since=0&wait_ms=N   → 等到 [typing(1), message, typing(2)]
3. assert events 包含期望文本
4. POST /local/reset                     → 清理，开始下一用例
```

使用 `since` + `next_seq` 实现增量拉取，避免漏事件或重复。

## 为什么用 `_local_path`

真实 iLink 协议中 `media` 对象包含 `full_url`、`aes_key`、`encrypt_query_param` 三个字段。我们增加 `_local_path` 字段作为内部约定——当 `downloadAndDecryptMedia` 检测到此字段时，直接用 `fs.readFileSync` 读取本地文件，跳过 CDN 下载 + AES 解密。

- 用 `hasOwnProperty` 严格检测，iLink 协议永远不会包含此字段
- 命名以双下划线进一步降低未来冲突概率

## 为什么用 `local:` 前缀

微信 `from_user_id` 格式为 `o9cq803...@im.wechat`（字母数字下划线），不含冒号。`local:` 前缀与生产 user_id 绝对互斥，`isLocalId()` 不会误判。

## 守卫式改动清单

bot.js 所有改动都通过 `isLocalEnabled()` / `isLocalId()` 守卫，**未设 `LOCAL_TEST_PORT` 环境变量时原有行为零变化**：

| 注入点 | 代码位置 | 守卫 |
|--------|---------|------|
| import | bot.js:5-6 | 无（始终加载模块） |
| saveSession | bot.js:93 | `isLocalEnabled()` → return |
| downloadAndDecryptMedia | bot.js:128 | `_local_path` hasOwnProperty |
| sendMsgSafe | bot.js:504 | `isLocalId(toId)` |
| ensureTypingTicket | bot.js:530 | `isLocalId(fromId)` |
| sendtyping ×2 | bot.js:547,573 | `isLocalId(fromId)` |
| messageLoop 轮询 | bot.js:811 | `isLocalEnabled()` |
| 启动入口 | bot.js:1197 | `isLocalEnabled()` |

## 故障排查

| 症状 | 检查 |
|------|------|
| `curl: Connection refused` | bot 是否启动？`LOCAL_TEST_PORT` 是否设置？ |
| AI 回复超时 | `config.json` 的 `api_key` / `base_url` 是否正确？ |
| 文件路径错误 | 路径是否相对于 `instances/test-local/`？ |
| outbox 为空 | `since` 是否超过当前 seq？是否被 `reset` 清空？ |

## 安全提示

- 服务只绑定 `127.0.0.1`，不暴露到公网
- **不要在生产实例设置 `LOCAL_TEST_PORT` 环境变量**
- `instances/test-local/config.json` 含 API key，已 gitignored
- 测试用 AI 调用会消耗 API 额度，建议指向便宜模型
