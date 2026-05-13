# CLAUDE.md — 微信 AI Bot 项目总览

## 项目概况

这是一个通过 **微信 iLink Bot API** 连接微信个人号、后端对接 **Claude API** 实现 AI 自动回复的系统。两个独立实例运行在同一台 NAS 上，分别对应两个微信账号的连接。

- **部署位置**：NAS `/opt/weixin-bot-ai/`
- **进程管理**：PM2
- **运行环境**：Node.js v22，系统时区 CST +0800

## 目录结构

```
/opt/weixin-bot-ai/
├── ecosystem.config.js      # PM2 配置文件
├── config.json              # 全局参考（实际各实例用各自的）
├── weixin-ClawBot-API/      # 实例 1（PM2: weixin-bot-1）
│   ├── bot.js               # 主程序，单文件实现
│   ├── config.json          # AI 接口配置（api_key/base_url/model/prompt）
│   ├── package.json         # type: "module"，依赖 mammoth
│   └── logs/
│       ├── bot.log           # stdout 日志（带时间戳）
│       ├── bot-error.log     # stderr 日志
│       └── debug_messages.jsonl  # 完整消息调试日志
└── weixin-ClawBot-API-2/    # 实例 2（PM2: weixin-bot-2）
    └── （同上结构）
```

## 架构

### 生命周期

```
启动 → 加载 config.json → 获取登录二维码 → 等待微信扫码 →
登录成功 → [消息轮询循环] + [重连定时器循环] 并行运行
```

### 消息轮询流程

1. `POST /ilink/bot/getupdates` 长轮询（~35s 超时）
2. 收到消息后按优先级处理：
   - 重连确认 Y/N → 警告回复 Y/N → 欢迎消息 → Bot 指令 → AI 对话
3. AI 对话路径：获取 typing_ticket → 发送"正在输入" → 调用 AI API → 发送回复 → 取消"正在输入" → 写入对话历史

### 24h 自动重连

iLink 会话有效期 24 小时，到期前自动触发：
- 提前 2h 发预警，询问是否重连（Y/N）
- 用户回 N 后每 30 分钟再问
- 剩余 30 分钟时强制重连
- 重连时获取新二维码，扫码后原子替换 token

### AI 调用

`POST {base_url}/v1/messages`，Anthropic Messages 格式。内置 5 次梯度重试（2s/4s/8s/16s/32s）。

### 支持的微信消息类型

- 文本消息 → AI 对话
- 文件消息（.docx/.txt）→ 下载解密 → 提取文本 → 等用户发指令后合并传给 AI
- 图片/语音/视频 → 回复暂不支持

### 对话记忆

每个用户独立维护，最近 10 轮对话，60 分钟无活动自动清空。

## 日常操作

### PM2 管理

```bash
pm2 list                   # 查看两个 bot 状态
pm2 logs weixin-bot-1      # 实时日志
pm2 restart weixin-bot-1   # 重启单个实例
```

详见 `/opt/weixin-bot-ai/启动命令-pm2.md`。

### 扫码登录

启动时会生成 `qrcode.png` 到 bot 目录，用微信扫码即可连接。两个实例各扫各的。

重连时 bot 会把二维码链接发到微信，通过链接扫码即可，不需要登录 NAS。

## 配置

每个实例的 `config.json` 独立配置：

| 字段 | 说明 |
|------|------|
| api_key | AI 接口密钥 |
| base_url | API 地址，拼接 `/v1/messages` |
| model | 模型名，如 `claude-opus-4.7` |
| prompt | 系统提示词 |

**重要**：`config.json` 含明文 api_key，必须 gitignore，绝不可提交。

## 关键约束

- `sendmessage` 的 payload 字段一个不能少，否则消息静默丢失（HTTP 200 但不送达）
- `context_token` 必须来自当前收到的消息，不可复用
- 两个实例完全独立，扫不同的微信账号
- 依赖只有 `mammoth`，纯 JS 实现，跨平台无编译问题
- `package.json` 声明 `"type": "module"`，使用 ES Module 语法
