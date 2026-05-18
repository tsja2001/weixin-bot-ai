# DeepSeek 智能路由：自动化文件上下文管理

## Context

微信 Bot 给非技术用户（用户女朋友）使用，要求**完全自动化**，不能依赖 `/清空文件` 等指令操作。

当前文件锚点机制（[bot.js:341-451](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js)）的痛点：

1. **机械淘汰**：`turnCount` 每轮 +1，10 轮后丢弃；不管 AI 是否真的在引用文件 → 还没聊完就被丢、聊完了还在浪费 token
2. **全量注入**：每次 `callAI` 都把全部锚点（最多 50K 字 ≈ 25K token）塞到 history 头部，即使本轮在闲聊（[bot.js:587](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L587)）
3. **多文件按比例压缩**：3 个文件就各剩 16K，关键内容可能被截断（[bot.js:411-429](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L411)）
4. **没用 Prompt Caching**：重复 token 全价计费

**方案**：在每次 `callAI` 之前，用 DeepSeek-V3（128K 上下文、输入 0.27 元/M tokens）做一次**轻量路由判断**，决定本轮带哪些文件锚点。Claude 只收到相关文件的完整原文。叠加 Prompt Caching 进一步降本。

## 整体流程

```
用户消息 + 待处理文件
      ↓
（合并 pendingFiles → user message，现有逻辑不变）
      ↓
[新增] routeContext(fromId, userText) → 决定本轮带哪些锚点
      ↓
callAI(history with cache_control + 路由选定的锚点)
      ↓
[新增] 路由失败/超时 → fallback 到当前全量逻辑
      ↓
upsertFileAnchors（保留现有，但 turnCount 不再每轮机械 +1）
```

## Step 1: 配置扩展

**文件**: [bot.js:277](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L277) 及 instances/*/config.json

config.json 新增三个独立字段（可选，缺失则禁用路由功能）：

```json
{
  "router_api_key": "sk-xxx",
  "router_base_url": "https://api.deepseek.com",
  "router_model": "deepseek-chat"
}
```

**改动点**：
- [bot.js:249-322](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L249) `loadOrCreateConfig` —— 交互式创建时**不询问**这几个字段（避免打扰首次使用），仅在已有 config.json 中读取
- [bot.js:295-303](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L295) 启动时打印路由状态：`路由模型: deepseek-chat (已启用) / (未配置)`

**常量新增**（bot.js 顶部约 L46 附近）：

```js
const ROUTER_TIMEOUT_MS = 5000;          // 路由调用超时
const ROUTER_MAX_RETRIES = 1;            // 失败仅重试 1 次（避免拖慢主流程）
const ROUTER_FILE_SUMMARY_LEN = 300;     // 路由时每个文件用前 300 字摘要参考
```

## Step 2: 路由判断函数

新增 `routeContext()` 函数，约 80 行，放在 `callAI` 之前（约 bot.js:560 位置）。

**函数签名**：
```js
async function routeContext(fromId, userText, config)
  → { useFiles: boolean, relevantIndexes: number[], expireIndexes: number[] }
```

**核心逻辑**：

1. 取 `fileAnchors.get(fromId)` 当前所有锚点
2. 没有锚点 → 直接返回 `{ useFiles: false, ... }`，不调 API
3. 配置缺失 `router_api_key` → 返回 `{ useFiles: true, relevantIndexes: 所有索引, expireIndexes: [] }`（fallback 到现行行为）
4. 构造 DeepSeek 请求：

```js
const filesList = anchors.map((a, i) => {
  const fileName = extractFileName(a.content);        // 从 "[用户上传了文件: xxx]" 提取
  const preview = a.content.slice(0, ROUTER_FILE_SUMMARY_LEN);
  return `[${i}] ${fileName}: ${preview}...`;
});

const routerPrompt = `用户当前问题：${userText}

历史上传的文件：
${filesList.join("\n")}

判断哪些文件和"当前问题"相关。规则：
- 用户在询问/引用某个文件时 → relevant_indexes 加上该文件序号
- 用户已经明显离开这个文件话题（聊别的、问无关问题）→ expire_indexes 加上序号
- 不确定就放 relevant_indexes（宁可多带）
- 闲聊问候不需要任何文件 → 两个数组都为空

只输出 JSON：{"relevant_indexes": [...], "expire_indexes": [...]}`;
```

5. POST 到 `${router_base_url}/v1/chat/completions`，OpenAI 兼容格式，`response_format: { type: "json_object" }`
6. 解析 JSON，取 `relevant_indexes` 和 `expire_indexes`
7. 超时 / 解析失败 / HTTP 异常 → fallback 到"带全部锚点"，记日志但不抛错
8. 调试日志：`[路由] DeepSeek → relevant=[0,2] expire=[1] (耗时 423ms, 输入 320 tokens)`

## Step 3: getHistoryForUser 改造

**文件**：[bot.js:360-380](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L360)

签名扩展：
```js
function getHistoryForUser(fromId, routerDecision = null)
```

逻辑：
- 没传 `routerDecision` → 保持现有行为（全量返回）
- 传了 → 按 `relevantIndexes` 过滤锚点；同时把 `expireIndexes` 中的锚点从 `fileAnchors` 中**直接删除**（持久清理）
- 仍保留 `turnCount < FILE_ANCHOR_MAX_TURNS` 兜底过滤（防止意外不清理）

**关键改动**：`upsertFileAnchors` 中 [bot.js:436-438](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L436) 的 `turnCount++` **保留但作为兜底**——路由正常时主要靠 expire_indexes 淘汰，路由全坏时仍有机械淘汰保证不无限累积。

## Step 4: sendAiReply 串联

**文件**：[bot.js:540-563](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L540)

在 `getHistoryForUser` 之前插入路由：

```js
async function sendAiReply(fromId, contextToken, userContent, pendingFilesForAnchor = null) {
  // ... 现有的 typing ticket 逻辑保持 ...

  const userText = typeof userContent === "string"
    ? userContent
    : userContent.filter(b => b.type === "text").map(b => b.text).join("\n");

  const routerDecision = await routeContext(fromId, userText, botConfig);  // 新增
  const history = getHistoryForUser(fromId, routerDecision);                // 改造

  const reply = await callAI(userContent, botConfig, history);
  // ... 后续不变 ...
}
```

## Step 5: Prompt Caching

**文件**：[bot.js:568-588](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L568) `callAI`

在 history 注入时给最后一个 fileAnchor 加 `cache_control`：

```js
// 在 callAI 内部，组装 messages 前先做 cache 标记
const messagesWithCache = history.map((msg, i) => {
  if (i === lastAnchorIndex) {
    return {
      role: msg.role,
      content: [{
        type: "text",
        text: msg.content,
        cache_control: { type: "ephemeral" }   // 5min TTL，足够单次对话
      }]
    };
  }
  return msg;
});
```

**注意**：cache_control 需要 base_url 服务端支持。需要在 config 加 `enable_prompt_cache: true/false` 开关（默认 true），失败时去掉重试一次。

## 验证方法

### Step 1 (配置)
```bash
cd /opt/weixin-bot-ai/instances/<name>
# 编辑 config.json 加入 router_* 字段
pm2 restart <instance>
pm2 logs <instance> --lines 20  # 应看到 "路由模型: deepseek-chat (已启用)"
```

### Step 2-4 (路由生效)
1. 上传一个文件，问"总结一下" → 日志应有 `[路由] relevant=[0] expire=[]`
2. 接着发"今天天气怎么样" → 日志应有 `[路由] relevant=[] expire=[0]`（或 `[]` 不淘汰）
3. 看 `logs/debug_messages.jsonl`，确认 Claude 请求的 messages 中文件锚点按预期出现/缺失
4. 不配 `router_api_key` 测降级 → 应回到全量行为，日志 `[路由] 未配置，使用全量锚点`
5. 把 `router_base_url` 故意改错 → 应有重试 + fallback 日志，主流程不中断

### Step 5 (cache 命中)
连续两轮带同一文件，观察 AI 响应 `usage.cache_creation_input_tokens` / `cache_read_input_tokens`（已在 [bot.js:627-630](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js#L627) 解析 usage，需要扩展打印这两个字段）。

## 风险点

| 风险 | 应对 |
|------|------|
| DeepSeek 响应慢（>1s）让用户感觉迟钝 | 5s 超时 + 仅 1 次重试；超时直接 fallback；并发在 `sendtyping` 之后调用，用户在"对方正在输入"期间感知不到 |
| DeepSeek 误判（该带文件却没带） | 提示词强调"不确定就放 relevant_indexes"；用户能从回复质量看出来，下一轮重新询问会自动纠正 |
| DeepSeek API 全挂 | fallback 到全量行为，与当前实现等价 |
| 中转 base_url 不支持 cache_control | enable_prompt_cache 配置开关 + 失败重试无 cache 版本 |
| 文件名特殊字符破坏 JSON | DeepSeek response_format=json_object 强约束 + try/catch 解析 |

## 不做的事（明确边界）

- ❌ 不引入向量库 / embedding / RAG
- ❌ 不引入新 npm 依赖（用 fetch 即可）
- ❌ 不改 `pendingFiles` 数据结构（pendingFiles 流程完全不动）
- ❌ 不改 `HISTORY_MAX_TURNS` / `HISTORY_TTL_MS` / `PENDING_FILE_TTL_MS` 等已平衡的常量
- ❌ 不改 `buildFileAnchors` 的两级截断（首次写入时仍然按 50K 限制，路由只决定"带不带"不重切）
- ❌ 不删 `/清空文件` 指令（保留作为兜底，但不主推）
- ❌ 不动 scheduler.js / document-service / ocr-service

## 修改文件清单

| 文件 | 修改 |
|------|------|
| [bot.js](/Users/yangzhuoran/program/weixin-bot-ai/.claude/worktrees/gifted-roentgen-5ff5a5/bot.js) | 主要改动：新增 `routeContext` 函数、改造 `getHistoryForUser`、`sendAiReply` 串联、`callAI` 加 cache_control |
| instances/*/config.json | 用户手动加 router_* 字段（首次启动不强制） |
| 无新增文件 | 整个改动在 bot.js 内完成 |

预估代码改动：+120 行 / 修改 ~30 行。

## Token 节省估算

假设场景：用户上传一个 10K 字文档（≈5K tokens），聊 20 轮，其中 8 轮和文件相关、12 轮闲聊。

| 场景 | 当前实现 | 改造后 | 节省 |
|------|---------|--------|------|
| 8 轮相关 | 5K × 8 = 40K | 5K × 8 = 40K（首轮）+ 2.5K × 7（缓存）= 57.5K... 算单价 | 同 input，缓存命中省 90% |
| 12 轮闲聊 | 5K × 12 = 60K | 0（路由判定不需要） | **省 60K input** |
| DeepSeek 路由成本 | - | 20 × 0.5K = 10K（按 0.27 元/M 计）≈ 0.003 元 | 可忽略 |

**总节省**：约 50% Claude input tokens；叠加 cache 后实际付费 input 再降 50-80%。每天 200 条消息估计省 0.5-2 元/账号。
