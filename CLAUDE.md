# CLAUDE.md — 微信 AI Bot 技术文档

## 项目概况

微信 iLink Bot API 连接微信个人号，后端对接 Claude API（Anthropic Messages 格式）实现 AI 自动回复。部署在 NAS `/opt/weixin-bot-ai/`，PM2 管理进程，Node.js v22，系统时区 CST +0800。

## 目录结构

```
/opt/weixin-bot-ai/
├── bot.js                   # 主程序（所有实例共享，约 930 行）
├── package.json             # type: "module"，仅依赖 mammoth
├── node_modules/            # 共享依赖
├── ecosystem.config.cjs     # PM2 配置（.cjs 因为 package.json 声明了 ES Module）
├── instances/               # 实例隔离目录
│   └── <实例名>/
│       ├── config.json      # AI 接口配置（gitignored）
│       ├── session.json     # 登录态持久化（运行时生成，gitignored）
│       └── logs/
│           ├── bot.log           # stdout
│           ├── bot-error.log     # stderr
│           └── debug_messages.jsonl  # 完整消息调试日志
```

### 实例隔离模型

- `bot.js` 中所有文件路径均为相对路径（`config.json`、`session.json`、`logs/`）
- PM2 通过 `cwd` 将每个实例的工作目录指向 `instances/<name>/`
- `script` 统一指向根目录 `bot.js`
- 每个微信账号对应一个实例目录，完全独立
- 旧生产实例（`weixin-ClawBot-API/`、`weixin-ClawBot-API-2/`）仍在使用旧结构，尚未迁移

## 架构

### 生命周期（完整版）

```
启动
  → 加载 config.json（不存在则交互式创建）
  → 检查 session.json
      ├── 有效 → 恢复 botToken/botBaseUrl/loginTime/getUpdatesBuf → 跳过扫码
      └── 无效/不存在 → 获取登录二维码 → 轮询扫码状态 → 登录成功 → saveSession()
  → [消息轮询循环] + [重连定时器循环] + [调度器循环] 并行运行
```

### Session 持久化（热更新）

`session.json` 保存字段：
```json
{
  "botToken": "xxx@im.bot:xxx",
  "botBaseUrl": "https://ilinkai.weixin.qq.com",
  "loginTime": 1778660898200,
  "getUpdatesBuf": ""
}
```

- 首次扫码登录成功后写入
- 重连成功后更新
- 启动时读取，若 `loginTime + 24h > now` 则直接使用，否则走扫码
- 文件损坏或字段缺失 → 自动删除，回退扫码流程
- `gitignored`（含 token 明文）

**不持久化的状态**（重启后自然重建）：
- `typingTicketCache` — 首次消息时重新获取
- `conversationHistory` — 60 分钟 TTL，丢了无影响
- `welcomedUsers` — 最多多发一次欢迎消息
- `lastContact` — 首条消息到达时自动设置

### 消息轮询流程

1. `POST /ilink/bot/getupdates` 长轮询（~35s 超时），传 `get_updates_buf` 实现游标
2. 连续失败 5 次触发自动重连
3. 收到消息后按优先级处理：

```
1. 手动重连 Y/N 确认（/重新连接 后）
2. 定时预警 Y/N 确认（24h 到期前）
3. 首次交互欢迎消息
4. Bot 指令（/help /指令 /time /重新连接）
5. AI 对话（含待处理文件合并）
```

### AI 对话路径

1. `POST /ilink/bot/getconfig` 获取 `typing_ticket`（按用户缓存）
2. `POST /ilink/bot/sendtyping` status=1 显示"正在输入"
3. 调用 `callAI()` 获取回复
4. `POST /ilink/bot/sendmessage` 发送回复
5. `POST /ilink/bot/sendtyping` status=2 取消"正在输入"
6. 写入对话历史

### 24h 自动重连

iLink 会话有效期 24 小时，`RECONNECT_CONFIG` 控制策略（默认值）：

| 参数 | 值 | 说明 |
|------|-----|------|
| session_duration | 86400s | 会话总时长 |
| warning_before | 7200s | 提前 2h 预警 |
| reminder_interval | 1800s | 用户回 N 后 30min 再问 |
| force_before | 1800s | 最后 30min 强制重连 |
| qrcode_scan_timeout | 600s | 扫码等待超时 |

重连流程：
1. 获取新二维码 → 发送到微信
2. 轮询扫码状态（1s 间隔，带超时）
3. 扫码确认后原子替换 `botToken` 和 `botBaseUrl`
4. 清空 `typingTicketCache`
5. `saveSession()` 更新持久化

### AI API 调用

`POST {config.base_url}/v1/messages`，Anthropic Messages 格式：

```js
{
  model: config.model,
  max_tokens: 4096,
  system: config.prompt,
  messages: [...history, { role: "user", content: userMessage }],
}
```

- 5 次梯度重试：2s / 4s / 8s / 16s / 32s
- 60s 超时
- 解析 `data.content[0].text`
- 累计 input/output token 用于每日统计

### 对话记忆

- 每个 `fromId` 独立维护滑动窗口
- 最近 10 轮（20 条消息，每轮 user + assistant）
- 60 分钟无活动自动清空
- 单条消息超过 2000 字截断
- 指令消息（Y/N、/help 等）不记入历史

### 文件处理

支持 `.docx` 和 `.txt` 文件：
1. 下载加密文件（CDN）→ AES-128-ECB 解密 → MD5 校验
2. docx 用 mammoth 提取文本，txt 直接读 UTF-8
3. 暂存到 `pendingFiles`（30 分钟 TTL），等用户下一条指令后合并传给 AI

### 调度器

`config.json` 的 `scheduled_tasks` 数组，支持两种 action：
- `"text"` — 定时发送指定内容
- `"daily_report"` — 发送当日消息数 + input/output token 统计

按最近任务时间计算 sleep，到点同时刻任务一起执行。

### 每日统计

内存维护当天消息数和 token 消耗，日期变更自动重置。

## 模块级共享状态

bot.js 使用模块级变量（非 class），在消息循环和重连定时器之间共享：

| 变量 | 说明 |
|------|------|
| botToken | 认证 token |
| botBaseUrl | 动态 API 地址 |
| getUpdatesBuf | 长轮询游标 |
| lastContact | 最近发消息的用户（用于定时器发通知） |
| loginTime | 登录时间戳（计算剩余时间） |
| typingTicketCache | 按用户缓存 typing_ticket |
| welcomedUsers | 已发欢迎消息的用户集合 |
| warningActive | 是否正在发出重连预警 |
| reconnectInProgress | 是否正在重连 |
| reconnectResolve | 等待用户 Y 回复的 resolve |
| conversationHistory | 对话记忆 Map |
| pendingFiles | 待处理文件 Map |

## 配置

每个实例 `instances/<name>/config.json`：

| 字段 | 类型 | 说明 |
|------|------|------|
| api_key | string | AI 接口密钥 |
| base_url | string | API 地址，拼接 `/v1/messages` |
| model | string | 模型名 |
| prompt | string | 系统提示词 |
| scheduled_tasks | array | 定时任务（可选） |

## 关键约束

- `sendmessage` payload 字段一个不能少，否则消息静默丢失（HTTP 200 但不送达）
- `context_token` 必须来自当前收到的消息，不可复用
- `X-WECHAT-UIN` 每次请求随机生成
- `config.json` 和 `session.json` 含明文密钥，已 gitignore
- `ecosystem.config.cjs` 必须用 `.cjs` 扩展名（根 `package.json` 声明了 `"type": "module"`）
- 仅依赖 `mammoth`，纯 JS 实现，跨平台无编译问题
- PM2 配置修改后需 `pm2 start` 而非 `pm2 restart`

## 测试

### 本地 HTTP 测试通道

通过 `LOCAL_TEST_PORT` 环境变量启用。详情见 `local-channel/README.md`。

测试套件位于 `tests/` 目录，使用 Node.js 内置 `node:test` 模块：
- `tests/lib/constants.js` — 从根 `constants.js` 导入，确保测试与代码共享同一套业务常量
- `tests/lib/bot-process.js` — 启动/停止本地测试实例
- `tests/lib/client.js` — HTTP 客户端封装（inbox/outbox/state/reset）
- `tests/lib/reporter.js` — JSON 测试报告生成
- `tests/scenarios/` — 按功能模块组织的测试文件

### 修改逻辑后必须跑测试

任何修改业务逻辑或常量值后：
1. 运行 `node tests/runner.js`
2. 有测试失败时逐个分析：
   - 测试过时（行为有意变更导致）→ 更新测试代码
   - 代码写错导致 → 修复代码
3. 新增行为同时新增测试用例
4. 全部通过后才能提交

### 测试里不写死魔法数字

测试应该从 `constants.js` 导入业务常量，或用相对值表达意图（如"明显超过限制"），不应该硬编码 `50000`、`10` 等魔法数字。

### 新增测试文件

在 `tests/scenarios/` 下添加 `NN-场景描述.test.js`，文件名编号递增。每个文件导出一个 `{ name, description, tests }` 对象。

### 测试模式

```
1. POST /local/inbox/... 注入消息
2. GET /local/outbox?since=N&wait_ms=... 长轮询等回复
3. assert 断言结果
4. POST /local/reset 清理状态
5. 下一个用例
```
