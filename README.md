# 微信 AI Bot

通过微信 iLink Bot API 连接微信个人号，后端对接 Claude API 实现 AI 自动回复。

## 目录结构

```
/opt/weixin-bot-ai/
├── bot.js                   # 主程序，所有实例共享
├── document-service/         # Node 文档解析服务（PDF/Office，必要时调用 OCR）
├── ocr-service/              # Python OCR 服务（图片 -> 文本）
├── package.json             # type: "module"，依赖 mammoth
├── node_modules/            # 共享依赖
├── ecosystem.config.cjs     # PM2 配置
├── instances/               # 各实例独立目录
│   ├── tsja/                # 实例 1
│   │   ├── config.json      # AI 接口配置
│   │   ├── session.json     # 登录态（自动生成）
│   │   └── logs/
│   └── wife/                # 实例 2
│       ├── config.json
│       ├── session.json
│       └── logs/
```

代码与配置分离：`bot.js` 一处修改，所有实例生效。每个实例目录只放 `config.json`，运行时自动生成 `session.json` 和 `logs/`。

文件解析已经拆为独立服务：

```text
bot.js
  -> 下载并解密微信文件
  -> document-service /parse
  -> PDF 扫描页按需调用 ocr-service /ocr/image
  -> bot 暂存解析结果，等待用户下一条要求
```

## 快速开始

### 1. 创建实例

```bash
mkdir -p instances/新用户
cp instances/tsja/config.json instances/新用户/config.json
vim instances/新用户/config.json   # 修改 API key、prompt 等
```

### 2. 在 ecosystem.config.cjs 添加 PM2 条目

```js
{
  name: "weixin-bot-新用户",
  cwd: "/opt/weixin-bot-ai/instances/新用户",
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
  env: { NODE_ENV: "production" },
}
```

### 3. 启动

```bash
pm2 start /opt/weixin-bot-ai/ecosystem.config.cjs --only weixin-bot-新用户
```

文档解析和 OCR 服务：

```bash
pm2 start /opt/weixin-bot-ai/ecosystem.config.cjs --only ocr-service
pm2 start /opt/weixin-bot-ai/ecosystem.config.cjs --only document-service
curl http://127.0.0.1:8770/health
```

首次启动生成二维码，用微信扫码连接即可。

## 热更新

登录成功后会自动保存 `session.json`，之后 `pm2 restart` 会在 2 秒内恢复登录态，无需重新扫码。如果 session 已过期则自动走二维码登录流程。

## 配置

每个实例的 `config.json`：

```json
{
  "api_key": "sk-xxx",
  "base_url": "https://api.b.ai",
  "model": "claude-opus-4.7",
  "prompt": "系统提示词...",
  "scheduled_tasks": [
    { "time": "20:00", "action": "daily_report" },
    { "time": "08:45", "action": "text", "content": "早上好" }
  ]
}
```

| 字段 | 说明 |
|------|------|
| api_key | AI 接口密钥 |
| base_url | API 地址，拼接 `/v1/messages` |
| model | 模型名 |
| prompt | 系统提示词 |
| scheduled_tasks | 定时任务（可选） |

可选字段：

| 字段 | 说明 |
|------|------|
| document_service_url | 文档解析服务地址，默认 `http://127.0.0.1:8770` |
| ocr_service_url | 历史兼容字段；OCR 现在由 document-service 侧配置 |

`scheduled_tasks` 支持两种 action：
- `"text"` — 定时发送指定文字
- `"daily_report"` — 发送当日消息数和 token 统计

## 指令

微信里发送以下指令：

| 指令 | 说明 |
|------|------|
| `/help` `/指令` | 查看指令列表 |
| `/time` | 查询当前连接剩余时间 |
| `/重新连接` | 手动触发重连 |

非指令内容自动进入 AI 对话。

## PM2 管理

```bash
pm2 list                                          # 查看所有实例
pm2 logs weixin-bot-1                             # 实时日志
pm2 restart weixin-bot-1                          # 重启（热更新，无需扫码）
pm2 start /opt/weixin-bot-ai/ecosystem.config.cjs --only weixin-bot-1
pm2 stop weixin-bot-1
pm2 delete weixin-bot-1
```

详见 `启动命令-pm2.md`。
