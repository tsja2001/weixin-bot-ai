# 本地 HTTP 测试通道 — 实施计划书

## Context（为什么要做）

当前微信 bot 每次功能改动都需要：手动重启服务 → 微信扫码登录 → 真人发消息/上传文件 → 肉眼观察 → 出 bug 再改。流程慢、不可重复、AI 无法独立完成端到端验证。

目标：**让 bot 在保留原有微信通道的同时，额外提供一个本地 HTTP 通道**。AI 可以通过 curl 发文本/文件/图片消息进入 bot 处理主流程，并通过另一个端点拉取 bot 的回复和状态，做自动化断言。

**核心硬约束**：本地注入的"假消息"在进入 [bot.js:786 messageLoop()](bot.js) 时，JSON 结构必须与真实 iLink 消息**完全一致**。否则会引入"测试通过但生产挂"的 bug 源——这是用户最担心的点。

---

## 架构（数据流）

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
- **入口汇合**：messageLoop 每轮从 wechat 拉到 0/N 条消息后，再拉 local inbox 队列；两路消息走同一段分流逻辑，无任何条件分支
- **出口分流**：`sendMsgSafe(toId, ...)` 检查 `toId.startsWith("local:")`，本地消息推 outbox，真消息走 `apiPost`
- **本地文件短路**：在 [bot.js:124 downloadAndDecryptMedia](bot.js) 首行检测 `media._local_path`，存在则 `fs.readFileSync` 返回 buffer，跳过 CDN+AES；该字段真实 iLink 协议永不出现
- **测试实例完全不连微信**：通过 `LOCAL_TEST_PORT` 环境变量启用，跳过扫码/session/重连定时器，但**保留** AI 调用 + 文档服务 + 调度器

---

## 文件清单

### 新建（独立模块）

| 文件 | 职责 | 估行 |
|---|---|---|
| `local-channel/index.js` | 对外 API 入口：`isLocalEnabled`、`isLocalId`、`drainLocalInbox`、`onLocalInboxReady`、`deliverToLocal`、`initLocalChannel`、`snapshotForProbe` | ~80 |
| `local-channel/http-server.js` | Node 原生 http，路由所有 `/local/*` 端点，JSON 解析/序列化 | ~200 |
| `local-channel/inbox.js` | inbox 队列；`buildMsgFromText/File/Image()` 三个构造器（生成与真实 iLink 一字不差的 msg JSON） | ~150 |
| `local-channel/outbox.js` | outbox 队列 + 单调 seq + 长轮询 wait/notify | ~100 |
| `local-channel/state-probe.js` | 内部状态脱敏快照（pendingFiles/history/anchors/dailyStats） | ~60 |
| `local-channel/README.md` | 文档（架构图、API 参考、用例手册、风险） | ~300 |
| `fixtures/` 目录 | 测试用文件（docx/pdf/txt/png/jpg），加入 `.gitignore` | - |

### 修改

| 文件 | 改动 |
|---|---|
| [bot.js](bot.js) | 8 处守卫式注入，约 +50 行（详见下节） |
| [ecosystem.config.cjs](ecosystem.config.cjs) | 新增 `weixin-bot-test-local` 条目，约 +18 行 |
| `.gitignore` | 加 `fixtures/`、`instances/test-local/` |
| `instances/test-local/config.json` | 测试 AI 配置（手动建，参考 instances/test 格式） |

---

## bot.js 改动点（精确）

所有改动都通过 `isLocalEnabled()` / `isLocalId(toId)` 守卫，**未设环境变量时函数立即返回 false，原有行为零变化**。

### A. 顶部 import（[bot.js:4](bot.js) 之后，+1 行）
```js
import { isLocalEnabled, isLocalId, drainLocalInbox, onLocalInboxReady,
         deliverToLocal, initLocalChannel, snapshotForProbe } from "./local-channel/index.js";
```

### B. [bot.js:124 `downloadAndDecryptMedia`](bot.js) 函数首行短路（+5 行）
```js
async function downloadAndDecryptMedia(media, label, expectedMd5) {
  if (media && Object.prototype.hasOwnProperty.call(media, "_local_path")) {
    const buf = fs.readFileSync(media._local_path);
    console.log(`[LOCAL 媒体] 读取 ${media._local_path} (${buf.length} bytes)`);
    return buf;
  }
  const { full_url, aes_key, encrypt_query_param } = media;
  // ...原代码不变
```
图片和文件都共用这一条短路，因为 `downloadAndDecryptFile` 内部就是调它。

### C. [bot.js:90 `saveSession`](bot.js) 首行（+1 行）
```js
function saveSession() {
  if (isLocalEnabled()) return;  // 测试实例不写 session
  // ...
```

### D. [bot.js:491 `sendMsgSafe`](bot.js) 函数首（+5 行）
在原 `if (!toId || !contextToken)` 之后：
```js
if (isLocalId(toId)) {
  deliverToLocal({ kind: "message", to_user_id: toId, context_token: contextToken, text });
  console.log(`[LOCAL 出站] → ${toId}: ${text.slice(0, 80)}`);
  return;
}
```

### E. [bot.js:516 `ensureTypingTicket`](bot.js) 函数首（+1 行）
```js
if (isLocalId(fromId)) return "LOCAL_TICKET";
```

### F. [bot.js:533-537 和 :557-560](bot.js) 两处 `sendtyping` 调用（各 +4 行）
把每处的 `apiPost("ilink/bot/sendtyping", { ... }).catch(...)` 包成：
```js
if (isLocalId(fromId)) {
  deliverToLocal({ kind: "typing", to_user_id: fromId, status: 1 });  // 或 2
} else {
  await apiPost("ilink/bot/sendtyping", { ... }).catch(() => {});
}
```

### G. [bot.js:786 `messageLoop`](bot.js) — 注入本地消息（+8 行）

把 [bot.js:792-812](bot.js) 的轮询块改为：
```js
let result;
if (isLocalEnabled()) {
  // 本地实例：不调微信 getupdates，等本地 inbox 信号
  await onLocalInboxReady({ timeout_ms: 35000 });
  result = { msgs: [], get_updates_buf: getUpdatesBuf };
} else {
  try {
    result = await apiPost("ilink/bot/getupdates", { ... });
    consecutiveFailures = 0;
  } catch (e) { ...原 catch 不变 }
}

getUpdatesBuf = result.get_updates_buf ?? getUpdatesBuf;
const wechatMsgs = result.msgs ?? [];
const localMsgs = isLocalEnabled() ? drainLocalInbox() : [];
const msgs = [...wechatMsgs, ...localMsgs];
```

### H. [bot.js:1135-1227 启动入口](bot.js) — 跳过扫码 + 启动 HTTP server（+15 行）

在 `await loadOrCreateConfig()` 之后、扫码/session 块之前加：
```js
if (isLocalEnabled()) {
  botToken = "LOCAL_TEST_TOKEN";
  botBaseUrl = "http://127.0.0.1:0";
  loginTime = Date.now();
  initLocalChannel({
    port: Number(process.env.LOCAL_TEST_PORT),
    snapshotForProbe: (userId) => snapshotForProbe(userId, {
      pendingFiles, fileAnchors, conversationHistory,
      typingTicketCache, dailyStats, welcomedUsers, lastContact,
    }),
    resetUser: (userId) => {
      pendingFiles.delete(userId);
      fileAnchors.delete(userId);
      conversationHistory.delete(userId);
      typingTicketCache[userId] && delete typingTicketCache[userId];
      welcomedUsers.delete(userId);
    },
  });
  console.log(`[LOCAL] 测试通道已启用 :${process.env.LOCAL_TEST_PORT}`);
} else {
  // ...原扫码/session 块（1170-1223）整段移入这里
}
```

最后的 `await Promise.all([messageLoop(), reconnectTimerLoop(), schedulerLoop()])` 改为：
```js
const tasks = [messageLoop(), schedulerLoop()];
if (!isLocalEnabled()) tasks.push(reconnectTimerLoop());
await Promise.all(tasks);
```

---

## HTTP API（local-channel/http-server.js）

监听 `127.0.0.1:${LOCAL_TEST_PORT}`，所有响应 JSON。

### 注入端点

| 端点 | 请求体 | 行为 |
|---|---|---|
| `POST /local/inbox/text` | `{ user_id?, text }` | 构造 msg(type=1) 入队 |
| `POST /local/inbox/file` | `{ user_id?, file_path, file_name? }` | 构造 msg(type=4)，`media._local_path` = 绝对路径 |
| `POST /local/inbox/image` | `{ user_id?, file_path }` | 构造 msg(type=2)，同样用 `_local_path` |
| `POST /local/inbox/raw` | `{ msg: <完整iLink JSON> }` | 高级场景，跳过构造器 |
| `POST /local/reset` | `{ user_id? }` | 清状态 + outbox |

`user_id` 默认 `local:default`，必须以 `local:` 起头。

**msg 构造器输出示例**（与真实 iLink 抓包对照过字段）：
```js
// /local/inbox/file 内部生成
{
  message_id: "local-" + crypto.randomUUID(),
  from_user_id: "local:default",
  context_token: "local-ctx-" + crypto.randomBytes(8).toString("hex"),
  message_type: 1,
  item_list: [{
    type: 4,
    file_item: {
      file_name: "sample.docx",
      len: 12345,                       // fs.statSync(file_path).size
      md5: "",                          // 空字符串，bot 144 行只警告不阻断
      media: {
        _local_path: "/abs/path/sample.docx",  // 内部约定，真实 iLink 永不出现
        full_url: "local://",
        aes_key: "",
        encrypt_query_param: "",
      }
    }
  }]
}
```

### 观察端点

| 端点 | 响应 | 说明 |
|---|---|---|
| `GET /local/outbox?since=<seq>&wait_ms=<n>` | `{ events: [...], next_seq }` | 长轮询，新事件入队即返回；超时返回空数组 |
| `GET /local/state?user_id=local:u1` | `{ pending_files, history, anchors, welcomed, daily_stats }` | 内部状态脱敏快照 |
| `GET /local/health` | `{ ok, instance_dir, doc_service_url }` | 探活 |

**outbox 事件 schema**：
```js
{ seq: 1, kind: "message", to_user_id, context_token, text, ts }
{ seq: 2, kind: "typing", to_user_id, status: 1, ts }
{ seq: 3, kind: "error", message, stack?, ts }
```

---

## 测试编排模式（写在 README，给 AI 看）

```
1. POST /local/inbox/text { text: "你好" }     →  立即返回 { ok: true }
2. GET /local/outbox?since=0&wait_ms=15000     →  等到 [typing(1), message, typing(2)]
3. assert events.find(e => e.kind === "message").text 包含期望
4. POST /local/inbox/file { file_path: "./fixtures/a.docx" }
5. GET /local/outbox?since=3&wait_ms=15000     →  等到"已收到...请告诉我您的要求"
6. POST /local/inbox/text { text: "总结这个文件" }
7. GET /local/outbox?since=4&wait_ms=30000     →  等到 AI 回复
8. GET /local/state                            →  断言 pending_files 已清空、history 已写入
9. POST /local/reset                           →  开始下一用例
```

---

## ecosystem.config.cjs 新增条目

```js
{
  name: "weixin-bot-test-local",
  cwd: "/opt/weixin-bot-ai/instances/test-local",
  script: "/opt/weixin-bot-ai/bot.js",
  interpreter: "node",
  out_file: "logs/bot.log",
  error_file: "logs/bot-error.log",
  log_date_format: "YYYY-MM-DD HH:mm:ss",
  merge_logs: true,
  autorestart: true,
  watch: false,
  max_restarts: 10,
  restart_delay: 5000,
  env: {
    NODE_ENV: "development",
    LOCAL_TEST_PORT: "9527",
  },
}
```

本地开发也可以直接 `LOCAL_TEST_PORT=9527 node bot.js`（在 `instances/test-local/` 目录下）。

---

## README 章节大纲（local-channel/README.md）

```
1. 这是什么 + 一张架构图
2. 快速开始（启动 + 第一条 curl）
3. 架构与原理
   3.1 数据流（与本计划同款图）
   3.2 为什么用 _local_path（设计原因）
   3.3 为什么用 "local:" 前缀（与生产 user_id 互斥）
   3.4 守卫式改动清单
4. HTTP API 参考（每个端点的 schema + 例子）
5. 测试场景手册
   - 纯文本对话（多轮记忆）
   - 单文件 + 文字
   - 多文件合并
   - 图片消息
   - 指令 /help /time /清空文件
   - 错误路径（文件不存在、AI 超时）
6. AI 编排测试的推荐模式（长轮询 + seq 游标）
7. 故障排查
8. 安全提示（只绑 127.0.0.1，不要在生产实例设变量）
```

---

## 风险与规避

| 风险 | 规避 |
|---|---|
| 本地 msg JSON 字段与真实 iLink 漂移 | inbox 构造器对齐 `logs/debug_messages.jsonl` 抓包，保留所有字段（即便空字符串）；README 列出字段表 |
| `_local_path` 未来与 iLink 协议冲突 | 用 `hasOwnProperty` 严格检测；命名加双下划线 `__local_path__` 进一步降低概率 |
| `isLocalId` 误判真 user_id | 守卫两重：`isLocalEnabled() && toId.startsWith("local:")`；微信 openid 含字母数字下划线，不含冒号 |
| 测试实例烧 AI 额度 | README 警告 + config.json 指向便宜模型；后续可加 `mock_ai` 开关（本期不做） |
| fixtures 文件污染仓库 | `.gitignore` 加 `fixtures/`；README 说明文件需自备 |
| bot.js 守卫遗漏 | 所有守卫调用集中在 local-channel 模块导出；改动控制在 50 行内方便 review |
| typing/message 顺序错位 | outbox 严格按 seq 单调递增，按 seq 排序返回 |

---

## 验证步骤（实施完成后怎么端到端验证）

### 1. 单元验证（不连任何外部）
- 启动 `LOCAL_TEST_PORT=9527 node bot.js`（在 instances/test-local/）
- `curl localhost:9527/local/health` → 200 + 服务信息
- `curl -X POST localhost:9527/local/inbox/text -d '{"text":"你好"}'` → 返回 ok
- `curl 'localhost:9527/local/outbox?since=0&wait_ms=15000'` → 包含 AI 回复

### 2. 文件流程验证
- 把 `sample.docx` 放入 `instances/test-local/fixtures/`
- `curl -X POST .../inbox/file -d '{"file_path":"./fixtures/sample.docx"}'`
- outbox 应依次出现："已收到...正在解析" → "已收到...约 X 字内容...请告诉我您的要求"
- 再发文字 `curl -X POST .../inbox/text -d '{"text":"总结这个"}'` → 拿到 AI 回复
- `curl 'localhost:9527/local/state?user_id=local:default'` → 验证 history 含本轮、pending_files 已空、anchors 有文件锚点

### 3. 生产零侵入验证（关键！）
- `cd instances/tsja && node bot.js`（**不**设环境变量）
- 应该照常进入扫码/session 流程，无任何 `[LOCAL]` 日志
- 在 sendMsgSafe / downloadAndDecryptMedia / messageLoop 加临时 console.log 验证守卫分支未触发

### 4. 协议一致性验证
- 真实微信发一条文件消息，捕获 `logs/debug_messages.jsonl` 的 `raw_msg`
- 与 `buildMsgFromFile()` 输出 diff（除 `_local_path` 外的字段应完全一致）
- 如有差异，补齐字段；本步骤必须做，否则违反用户硬约束

### 5. 多轮场景验证
- 顺序：text → file → text → image → text → reset → text → state
- 全程不出现错误，pending_files / history / anchors 状态符合预期

---

## 关键文件引用

| 路径 | 用途 |
|---|---|
| [bot.js](bot.js) | 主程序，8 处守卫式改动 |
| [scheduler.js](scheduler.js) | 调度器（保留运行），参考其依赖注入模式 |
| [ecosystem.config.cjs](ecosystem.config.cjs) | PM2 配置，新增 test-local 条目 |
| [document-service/server.js](document-service/server.js) | 文档解析服务，测试时正常调用 |
| `instances/test/config.json` | 测试实例 config 模板 |
| `logs/debug_messages.jsonl` | 真实 iLink msg 抓包（构造器对齐参考） |
| [CLAUDE.md](CLAUDE.md) | 项目说明，实施后需追加"本地测试通道"章节链接 README |

---

## 工作量估算

- 新模块（local-channel/）：约 600 行 JS + 300 行 markdown
- bot.js 改动：50 行
- ecosystem.config.cjs：18 行
- README 文档：1 篇，300+ 行
- 验证手册：包含在 README 第 5 章

**估算实施时间**：纯写代码 1 个工作日，对齐 iLink 字段 + 写文档 + 端到端验证 1-2 个工作日。
