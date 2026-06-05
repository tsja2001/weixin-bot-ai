// ========== 共享常量 ==========
// bot.js 和测试代码都从这里导入，确保数值始终一致

// 对话记忆配置
export const HISTORY_MAX_TURNS = 10;           // 保留最近 N 轮对话
export const HISTORY_TTL_MS = 60 * 60 * 1000;  // 无活动多久后清空（毫秒）
export const HISTORY_MAX_CONTENT_LEN = 2000;   // 历史中单条消息最大字数

// 文件锚点配置
export const FILE_ANCHOR_MAX_CHARS = 50000;       // 单文件锚点硬上限
export const FILE_ANCHOR_TOTAL_CHARS = 50000;     // 所有文件锚点总和上限
export const FILE_ANCHOR_MAX_TURNS = 10;          // 锚点保留轮数
export const FILE_ANCHOR_MAX_FILES = 5;           // 同时锚定文件数上限

// 待处理文件
export const PENDING_FILE_TTL_MS = 12 * 60 * 60 * 1000;  // 12 小时未回复则清空

// 自动重连配置
export const RECONNECT_CONFIG = {
  timer_enabled:            false,  // 是否启用 24h 定时重连提醒（false=关闭，改回 true 恢复）
  session_duration:    24 * 3600,  // 会话总时长（秒）
  warning_before:       2 * 3600,  // 提前多久发出警告
  reminder_interval:      30 * 60, // 用户回 N 后多久再问
  force_before:           30 * 60, // 最后多久强制重连
  qrcode_scan_timeout:       600,  // 等待扫码超时
};

// 文档服务
export const DEFAULT_DOCUMENT_SERVICE_URL =
  process.env.DOCUMENT_SERVICE_URL || "http://127.0.0.1:8770";

// 欢迎消息（测试中用于断言指令列表）
export const COMMANDS_MSG = [
  "连接成功！",
  "可用指令：",
  "/help  /指令   - 查看全部指令列表",
  "/time          - 查询当前连接剩余时间",
  "/重新连接       - 立即触发重新连接（需确认）",
  "/清空文件       - 清除当前对话中的文件上下文",
  "",
  "非指令输入即为 AI 对话",
  "上传文件后发送文字指令，AI 会结合文件内容处理；可连续上传多个文件",
].join("\n");

// 默认提示词
export const DEFAULT_PROMPT = "你是一个有帮助的AI助手，请用中文简洁地回复。字数尽量少一些";

// ========== 长期记忆 ==========
export const MEMORY_MAX_PROFILE = 50;
export const MEMORY_MAX_EPISODES = 100;
export const MEMORY_RECALL_MAX_EPISODES = 5;
export const MEMORY_EPISODE_SUMMARY_CHARS = 40;

// ========== 秘书（DeepSeek 上下文选择）==========
export const SECRETARY_TIMEOUT_MS = 6000;
export const SECRETARY_FILE_PREVIEW_CHARS = 300;
export const FILE_IDLE_EVICT_TURNS = 6;

// ========== Prompt Caching ==========
export const CACHE_MIN_CHARS = 1500;

// ========== 秘书/抽取请求 marker ==========
export const SECRETARY_MARKER = "TASK:SELECT_CONTEXT";
export const EXTRACT_MARKER = "TASK:EXTRACT_MEMORY";
