import crypto from "crypto";
import fs from "fs";
import readline from "readline";
import { init as initScheduler, loop as schedulerLoop } from "./scheduler.js";
import { initFeishuSummary, recordChatTurn } from "./feishu-summary/index.js";
import { isLocalEnabled, isLocalId, drainLocalInbox, onLocalInboxReady,
         deliverToLocal, initLocalChannel, snapshotForProbe } from "./local-channel/index.js";
import { callClaude, normalizeUsage } from "./lib/ai-client.js";
import { selectContext } from "./secretary.js";
import { buildRequest } from "./context-builder.js";
import { loadMemory, saveMemory, touchProfile } from "./memory/store.js";
import { extractAndSaveMemory } from "./memory/extract.js";
import {
  ageFileAnchors, selectFilesByIds, upsertFileAnchors as upsertFileContextAnchors,
} from "./file-context.js";
import {
  HISTORY_MAX_TURNS, HISTORY_TTL_MS, HISTORY_MAX_CONTENT_LEN,
  PENDING_FILE_TTL_MS, RECONNECT_CONFIG, DEFAULT_DOCUMENT_SERVICE_URL,
  COMMANDS_MSG, DEFAULT_PROMPT,
} from "./constants.js";

// ========== 常量 ==========
const BASE_URL = "https://ilinkai.weixin.qq.com";
const CONFIG_FILE = "config.json";
const SESSION_FILE = "session.json";
const DEBUG_LOG_FILE = "logs/debug_messages.jsonl";
const PROMPT_FILE = "promt.md";
// 常量已移至 constants.js（bot.js 与测试共享），通过顶部 import 引用

fs.mkdirSync("logs", { recursive: true });

// ========== 每日统计 ==========
const dailyStats = {
  date: new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }),
  messageCount: 0,
  inputTokens: 0,
  outputTokens: 0,
};

function resetStatsIfNewDay() {
  const today = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (dailyStats.date !== today) {
    dailyStats.date = today;
    dailyStats.messageCount = 0;
    dailyStats.inputTokens = 0;
    dailyStats.outputTokens = 0;
  }
}
// ============================

// ========== 工具函数 ==========
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function debugLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try { fs.appendFileSync(DEBUG_LOG_FILE, line, "utf-8"); } catch {}
}

function summarizeMsg(msg) {
  const items = (msg.item_list || []).map(it => {
    const keys = Object.keys(it).filter(k => k !== "type");
    return `type=${it.type} keys=[${keys.join(",")}]`;
  });
  return `msg_id=${msg.message_id} from=${msg.from_user_id} top_msg_type=${msg.message_type} items=[${items.join("; ")}]`;
}

function maskKey(key) {
  if (key.length <= 10) return key;
  return key.slice(0, 5) + "*".repeat(key.length - 10) + key.slice(-5);
}

function saveSession() {
  if (isLocalEnabled()) return;
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      botToken, botBaseUrl, loginTime, getUpdatesBuf
    }), "utf-8");
    console.log("[Session] 已保存登录态");
  } catch (e) {
    console.log("[Session] 保存失败:", e.message);
  }
}

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const s = JSON.parse(raw);
    if (!s.botToken || !s.loginTime) throw new Error("session 字段缺失");
    console.log("[Session] 从文件恢复: loginTime=%s, baseUrl=%s",
      new Date(s.loginTime).toISOString(), s.botBaseUrl);
    return s;
  } catch (e) {
    console.log("[Session] 读取失败(%s)，将走扫码流程", e.message);
    try { fs.unlinkSync(SESSION_FILE); } catch {}
    return null;
  }
}

function rlQuestion(rl, q) {
  return new Promise(resolve => rl.question(q, resolve));
}
// ==============================

// ========== 文件下载解密 + 文本提取 ==========
// 通用媒体下载+解密（图片/文件共用）
async function downloadAndDecryptMedia(media, label, expectedMd5) {
  if (media && Object.prototype.hasOwnProperty.call(media, "_local_path")) {
    const buf = fs.readFileSync(media._local_path);
    console.log(`[LOCAL 媒体] 读取 ${media._local_path} (${buf.length} bytes)`);
    return buf;
  }
  const { full_url, aes_key, encrypt_query_param } = media;

  const url = full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(encrypt_query_param)}`;
  console.log(`[媒体] 开始下载: ${label}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`CDN 下载失败: HTTP ${res.status}`);
  const encryptedBuf = Buffer.from(await res.arrayBuffer());
  console.log(`[媒体] 下载完成: ${encryptedBuf.length} bytes`);

  // AES-128-ECB 解密（aes_key 是 base64 编码的 32 字符 hex 串，解码得到 16 字节密钥）
  const keyHex = Buffer.from(aes_key, "base64").toString("utf-8");
  const key = Buffer.from(keyHex, "hex");
  console.log(`[媒体] AES key (hex): ${keyHex}`);
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
  console.log(`[媒体] 解密完成: ${decrypted.length} bytes`);

  // 校验 MD5
  if (expectedMd5) {
    const actualMd5 = crypto.createHash("md5").update(decrypted).digest("hex");
    console.log(`[媒体] MD5 期望: ${expectedMd5}, 实际: ${actualMd5}`);
    if (actualMd5 !== expectedMd5) {
      console.log(`[媒体] 警告: MD5 不匹配!`);
    }
  }

  return decrypted;
}

async function downloadAndDecryptFile(fileItem) {
  const { media, file_name, md5, len } = fileItem;
  console.log(`[文件] 开始下载: ${file_name} (${len} bytes)`);
  const buffer = await downloadAndDecryptMedia(media, file_name, md5);
  return { buffer, fileName: file_name };
}

// 图片格式检测（文件头 magic number）
function detectImageFormat(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

async function parseDocumentFile({ buffer, fileName }, onEvent) {
  const documentServiceUrl = botConfig.document_service_url || DEFAULT_DOCUMENT_SERVICE_URL;
  const res = await fetch(`${documentServiceUrl}/parse-stream`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(fileName),
    },
    body: buffer,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (!res.ok) {
    if (res.status === 404) {
      return parseDocumentFileLegacy({ buffer, fileName });
    }
    const text = await res.text().catch(() => "");
    throw new Error(`文档解析服务返回 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  let pending = "";
  let finalResult = null;

  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.event === "result") {
        finalResult = event;
      } else if (event.event === "error") {
        throw new Error(event.error || "文档解析失败");
      } else {
        await onEvent?.(event);
      }
    }
  }

  pending += decoder.decode();
  if (pending.trim()) {
    const event = JSON.parse(pending);
    if (event.event === "result") finalResult = event;
    else if (event.event === "error") throw new Error(event.error || "文档解析失败");
    else await onEvent?.(event);
  }

  if (!finalResult) {
    throw new Error("文档解析服务未返回结果");
  }
  return finalResult;
}

async function parseDocumentFileLegacy({ buffer, fileName }) {
  const documentServiceUrl = botConfig.document_service_url || DEFAULT_DOCUMENT_SERVICE_URL;
  const res = await fetch(`${documentServiceUrl}/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(fileName),
    },
    body: buffer,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`文档解析服务返回 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}
// ============================

// ========== 配置文件加载 ==========
async function loadOrCreateConfig() {
  const sep = "=".repeat(60);
  const dash = "-".repeat(60);
  while (true) {
    if (!fs.existsSync(CONFIG_FILE)) {
      // 非交互式环境（如 launchd 后台运行）无法创建配置
      if (!process.stdin.isTTY) {
        console.error("未找到配置文件，且当前为非交互式环境，无法创建配置。请先手动运行 node bot.js 完成初始配置。");
        process.exit(1);
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`\n${sep}`);
      console.log("  首次运行，需要配置 API 信息");
      console.log(sep);
      console.log();
      console.log("  !! 重要提示 !!");
      console.log("  当前版本仅支持 DusAPI");
      console.log("  注册地址：https://dusapi.com");
      console.log("  如需使用其他 AI 接口，请前往 GitHub 拉取源代码自行修改");
      console.log(dash);

      const apiKey = (await rlQuestion(rl, "\n请输入 API Key（留空使用默认值 your-api-key）: ")).trim() || "your-api-key";
      const baseUrl = (await rlQuestion(rl, "请输入 API 地址（留空默认 https://api.dusapi.com）: ")).trim() || "https://api.dusapi.com";
      const model = (await rlQuestion(rl, "请输入模型名称（留空默认 gpt-5）: ")).trim() || "gpt-5";
      const prompt = (await rlQuestion(rl, "请输入系统提示词（留空使用默认值）: ")).trim() || DEFAULT_PROMPT;
      rl.close();

      const cfg = { api_key: apiKey, base_url: baseUrl, model, prompt };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
      console.log(`\n配置已保存到 ${CONFIG_FILE}\n`);
      // 如果存在 promt.md 则覆盖交互式输入的 prompt
      if (fs.existsSync(PROMPT_FILE)) {
        const filePrompt = fs.readFileSync(PROMPT_FILE, "utf-8").trim();
        if (filePrompt) cfg.prompt = filePrompt;
      }
      cfg.memory = { enabled: false, ...(cfg.memory || {}) };
      cfg.secretary = { enabled: false, ...(cfg.secretary || {}) };
      cfg.prompt_cache = { enabled: false, ...(cfg.prompt_cache || {}) };
      return cfg;
    }

    // 已有配置文件
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (process.env.ROUTER_BASE_URL) cfg.router_base_url = process.env.ROUTER_BASE_URL;
    cfg.memory = { enabled: false, ...(cfg.memory || {}) };
    cfg.secretary = { enabled: false, ...(cfg.secretary || {}) };
    cfg.prompt_cache = { enabled: false, ...(cfg.prompt_cache || {}) };
    // 优先从 prompt.md 加载提示词，fallback 到 config 中的 prompt 字段
    if (fs.existsSync(PROMPT_FILE)) {
      const filePrompt = fs.readFileSync(PROMPT_FILE, "utf-8").trim();
      if (filePrompt) cfg.prompt = filePrompt;
    }
    console.log(`\n${sep}`);
    console.log("  检测到配置文件，当前配置如下：");
    console.log(sep);
    console.log(`  API Key  : ${maskKey(cfg.api_key ?? "")}`);
    console.log(`  API 地址 : ${cfg.base_url ?? ""}`);
    console.log(`  模型     : ${cfg.model ?? ""}`);
    const p = cfg.prompt ?? "";
    const promptSource = fs.existsSync(PROMPT_FILE) ? PROMPT_FILE : "config.json";
    console.log(`  提示词   : ${p.slice(0, 50)}${p.length > 50 ? "..." : ""}  (来源: ${promptSource})`);
    console.log(dash);

    // 非交互式环境自动使用已有配置
    if (!process.stdin.isTTY) {
      console.log("  非交互式环境，自动使用已有配置");
      return cfg;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await rlQuestion(rl, "\n使用此配置继续？(直接回车或输入 Y 继续 / 输入 N 重新配置): ")).trim().toUpperCase();
    rl.close();

    if (choice === "N") {
      fs.unlinkSync(CONFIG_FILE);
      continue;
    }
    return cfg;
  }
}
// =================================

// ========== 模块级共享状态 ==========
let botToken;
let botBaseUrl = BASE_URL;
let getUpdatesBuf = "";
let lastContact = { fromId: null, contextToken: null };
let loginTime;

const typingTicketCache = {};          // {fromId: typing_ticket}
const welcomedUsers = new Set();       // 已发送过欢迎消息的用户
const manualReconnectPending = new Set(); // 等待手动重连确认的用��
let warningActive = false;             // 是否正在发出重连预警
let reconnectInProgress = false;       // 是否正在执行重连
let reconnectResolve = null;           // 定时器等待用户 Y 回复的 resolve
// ====================================

// ========== 待处理文件（等待用户发来要求后一起传给AI）==========
const pendingFiles = new Map();  // fromId → { files: [{fileName, text, type?, images?, timestamp}], timestamp }
// PENDING_FILE_TTL_MS 从 constants.js 导入

// 文件上下文锚点（本轮由秘书选择是否注入 Claude）
const fileAnchors = new Map();  // fromId → [{ id, fileName, content, idleTurns }]
const lastRouting = new Map();
const lastRequestMeta = new Map();
const lastUsage = new Map();

function addPendingFile(fromId, fileEntry) {
  let entry = pendingFiles.get(fromId);
  if (!entry) {
    entry = { files: [], timestamp: Date.now() };
    pendingFiles.set(fromId, entry);
  }
  entry.files.push(fileEntry);
}
// ================================================================

// ========== 对话上下文记忆 ==========
const conversationHistory = new Map();

function getHistoryForUser(fromId) {
  const entry = conversationHistory.get(fromId);

  if (!entry) return [];
  if (entry && Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
    conversationHistory.delete(fromId);
    fileAnchors.delete(fromId);
    return [];
  }

  if (entry) entry.lastActivity = Date.now();
  return entry?.messages || [];
}

function addToHistory(fromId, userMsg, assistantReply) {
  let entry = conversationHistory.get(fromId);
  if (!entry) {
    entry = { messages: [], lastActivity: Date.now() };
    conversationHistory.set(fromId, entry);
  }
  entry.lastActivity = Date.now();

  // 长消息截断，防止文件内容撑爆 token 预算
  const truncate = (s) => s.length > HISTORY_MAX_CONTENT_LEN
    ? s.slice(0, HISTORY_MAX_CONTENT_LEN) + "..."
    : s;

  // 内容可能是字符串或 content blocks 数组，历史只保留 text 部分
  const userText = typeof userMsg === "string"
    ? userMsg
    : userMsg.filter(b => b.type === "text").map(b => b.text).join("\n");

  entry.messages.push({ role: "user", content: truncate(userText) });
  entry.messages.push({ role: "assistant", content: truncate(assistantReply) });

  // 保留最近 N 轮（每轮 = user + assistant 两条消息）
  const maxMessages = HISTORY_MAX_TURNS * 2;
  if (entry.messages.length > maxMessages) {
    entry.messages = entry.messages.slice(-maxMessages);
  }
}

// ====================================

// ========== iLink Bot API 封装 ==========
function makeHeaders(token) {
  // X-WECHAT-UIN: 一个随机 32 位整数，base64 编码
  const uin = String(Math.floor(Math.random() * 0xFFFFFFFF));
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(uin).toString("base64"),
    ...(token ? { "Authorization": `Bearer ${token}` } : {})
  };
}

async function apiPost(path, body, token, baseUrl, retries = 3) {
  const url = `${baseUrl ?? botBaseUrl}/${path}`;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: makeHeaders(token ?? botToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      return res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const delay = Math.min(1000 * Math.pow(2, i), 10000);
        console.log(`[API] ${path} 失败 (${e.message})，${delay / 1000}s 后重试 (${i + 1}/${retries})`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// 安全发送消息：失败时打印日志并降级，不抛异常
async function sendMsgSafe(toId, contextToken, text) {
  if (!toId || !contextToken) {
    console.log(`[发送] 缺少 toId 或 contextToken，仅打印: ${text}`);
    return;
  }
  if (isLocalId(toId)) {
    deliverToLocal({ kind: "message", to_user_id: toId, context_token: contextToken, text });
    console.log(`[LOCAL 出站] → ${toId}: ${text.slice(0, 80)}`);
    return;
  }
  try {
    const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, "0")}`;
    await apiPost("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }]
      },
      base_info: { channel_version: "1.0.2" }
    });
  } catch (e) {
    console.log(`[发送] 失败(${e?.message})，降级打印: ${text}`);
  }
}

// 获取 typing_ticket（每个用户首次调用后缓存）
async function ensureTypingTicket(fromId, contextToken) {
  if (isLocalId(fromId)) return "LOCAL_TICKET";
  if (!typingTicketCache[fromId]) {
    const cfg = await apiPost("ilink/bot/getconfig", {
      ilink_user_id: fromId, context_token: contextToken,
      base_info: { channel_version: "1.0.2" }
    });
    typingTicketCache[fromId] = cfg.typing_ticket ?? "";
  }
  return typingTicketCache[fromId];
}

function extractUserTextForSummary(userContent) {
  if (typeof userContent === "string") return userContent;
  if (Array.isArray(userContent)) {
    return userContent
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");
  }
  return String(userContent || "");
}

function extractAnchorAttachmentText(history) {
  return "";
}

function normalizeAiUsage(usage = {}) {
  return normalizeUsage(usage);
}

// AI 回复完整流程：正在输入 → 调 AI → 发送 → 停止输入 → 记入历史
// pendingFilesForAnchor: 本轮处理过的文件列表，用于写入文件锚点
async function sendAiReply(fromId, contextToken, userContent, pendingFilesForAnchor = null, meta = {}) {
  const ticket = await ensureTypingTicket(fromId, contextToken);

  // status=1 显示"正在输入..."
  if (isLocalId(fromId)) {
    deliverToLocal({ kind: "typing", to_user_id: fromId, status: 1 });
  } else if (ticket) {
    await apiPost("ilink/bot/sendtyping", {
      ilink_user_id: fromId, typing_ticket: ticket, status: 1
    }).catch(() => {});
  }

  // 调用 AI：文件和长期记忆先由秘书筛选，再由 context-builder 组装
  const history = getHistoryForUser(fromId);
  if (pendingFilesForAnchor && pendingFilesForAnchor.length > 0) {
    const updated = upsertFileContextAnchors(fileAnchors.get(fromId) || [], pendingFilesForAnchor);
    fileAnchors.set(fromId, updated);
  }
  const allFiles = fileAnchors.get(fromId) || [];
  const memoryEnabled = botConfig.memory?.enabled !== false;
  const secretaryEnabled = botConfig.secretary?.enabled !== false;
  const promptCacheEnabled = botConfig.prompt_cache?.enabled === true;
  const memory = memoryEnabled ? loadMemory(fromId) : { profile: [], episodes: [] };
  const routing = await selectContext({
    userId: fromId,
    userContent,
    history,
    memory,
    files: allFiles,
    config: botConfig,
    enabled: secretaryEnabled,
    debugLog,
  });
  lastRouting.set(fromId, routing);
  const selectedProfile = (memory.profile || []).filter(item => routing.profileIds.includes(item.id));
  const selectedEpisodes = (memory.episodes || []).filter(item => routing.episodeIds.includes(item.id));
  const selectedFiles = selectFilesByIds(allFiles, routing.fileIds);
  fileAnchors.set(fromId, ageFileAnchors(allFiles, routing.fileIds));
  if (memoryEnabled && routing.profileIds.length > 0) {
    saveMemory(fromId, touchProfile(memory, routing.profileIds));
  }
  const contentLen = typeof userContent === "string"
    ? userContent.length
    : JSON.stringify(userContent).length;
  const LARGE_CONTENT_THRESHOLD = 20000;
  if (contentLen > LARGE_CONTENT_THRESHOLD) {
    const kb = (contentLen / 1000).toFixed(1);
    const waitHint = `内容较大（约 ${kb} KB），回复需要较长时间，请耐心等待...`;
    await sendMsgSafe(fromId, contextToken, waitHint);
  }
  const request = buildRequest({
    prompt: botConfig.prompt,
    userContent,
    history,
    files: selectedFiles,
    profile: selectedProfile,
    episodes: selectedEpisodes,
    promptCacheEnabled,
    userId: fromId,
  });
  lastRequestMeta.set(fromId, request.meta);
  console.log(`[上下文] user=${fromId} system=${request.meta.system_chars}字${request.meta.cached_blocks ? "(缓存)" : ""} 文件=${request.meta.file_count} 事件=${request.meta.episode_count} 历史=${request.meta.history_messages}条 ≈${request.meta.approx_tokens} token`);
  debugLog({ event: "context_built", ...request.meta });
  const aiResult = await callClaude({
    system: request.system,
    messages: request.messages,
    config: botConfig,
    cache: { enabled: promptCacheEnabled },
    onLog: console.log,
  });
  const reply = aiResult.text;
  const usage = normalizeAiUsage(aiResult.usage);
  lastUsage.set(fromId, usage);
  debugLog({
    event: "claude_usage",
    user: fromId,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_creation: usage.cache_creation_input_tokens,
    cache_read: usage.cache_read_input_tokens,
  });
  resetStatsIfNewDay();
  dailyStats.messageCount++;
  dailyStats.inputTokens += usage.input_tokens;
  dailyStats.outputTokens += usage.output_tokens;
  addToHistory(fromId, userContent, reply);

  // 发送回复
  await sendMsgSafe(fromId, contextToken, reply);
  console.log(`\n╔══ AI 回复 ══════════════════════════════════\n${reply}\n──────────────────────────────────────────`);

  const attachmentNames = meta.attachmentNames || pendingFilesForAnchor?.map(f => f.fileName) || [];
  const currentAttachmentText = meta.attachmentText
    ?? pendingFilesForAnchor?.map(f => `[${f.fileName}]\n${f.text}`).join("\n\n")
    ?? "";
  const anchorAttachmentText = extractAnchorAttachmentText(history);
  recordChatTurn({
    instanceName: meta.instanceName || process.cwd().split(/[\\/]/).pop(),
    fromId,
    messageId: meta.messageId,
    timestamp: meta.timestamp || Date.now(),
    userContent: meta.userContent || extractUserTextForSummary(userContent),
    attachmentNames,
    attachmentText: [currentAttachmentText, anchorAttachmentText].filter(Boolean).join("\n\n"),
    aiReply: reply,
    model: botConfig.model,
    usage,
  }).catch(e => {
    console.log(`[飞书汇总] 记录聊天轮次失败: ${e.message}`);
  });
  extractAndSaveMemory({
    userId: fromId,
    userText: meta.userContent || extractUserTextForSummary(userContent),
    aiReply: reply,
    config: botConfig,
    enabled: memoryEnabled,
    debugLog,
  }).catch(e => {
    console.log(`[记忆] 异步抽取异常: ${e.message}`);
  });

  // status=2 取消"正在输入..."
  if (isLocalId(fromId)) {
    deliverToLocal({ kind: "typing", to_user_id: fromId, status: 2 });
  } else if (ticket) {
    await apiPost("ilink/bot/sendtyping", {
      ilink_user_id: fromId, typing_ticket: ticket, status: 2
    }).catch(() => {});
  }

  return reply;
}
// =========================================

// ========== AI API 调用 ==========
async function callAI(userContent, config, history = []) {
  const result = await callAIWithUsage(userContent, config, history);
  return result.text;
}

async function callSummaryAI(userContent, config, history = []) {
  const text = typeof userContent === "string"
    ? userContent
    : Array.isArray(userContent)
      ? userContent.filter(b => b.type === "text").map(b => b.text).join("\n")
      : String(userContent || "");
  const messages = [
    ...history.map(item => ({ role: item.role, content: item.content })),
    { role: "user", content: text },
  ];
  const res = await fetch(`${config.base_url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: 512,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`summary HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  const summary = choice?.content || choice?.reasoning_content;
  if (!summary) throw new Error("summary response has no content");
  return summary;
}

async function callAIWithUsage(userContent, config, history = []) {
  const request = buildRequest({
    prompt: config.prompt,
    userContent,
    history,
    promptCacheEnabled: false,
  });
  return callClaude({ system: request.system, messages: request.messages, config, cache: { enabled: false } });
}
// =================================

// ========== 自动重连 ==========
async function doReconnect() {
  if (reconnectInProgress) return;
  reconnectInProgress = true;
  warningActive = false;
  reconnectResolve = null;

  console.log("[重连] 开始重连流程...");
  const { fromId, contextToken } = lastContact;

  // 1. 获取新二维码
  let qrcode, qrcodeUrl;
  try {
    const data = await fetch(`${botBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`).then(r => r.json());
    qrcode = data.qrcode;
    qrcodeUrl = data.qrcode_img_content ?? qrcode;
  } catch (e) {
    console.log(`[重连] 获取二维码失败: ${e?.message}`);
    reconnectInProgress = false;
    loginTime = Date.now();
    return;
  }

  const qrMsg = `[重连] 请扫码完成新连接：${qrcodeUrl}`;
  console.log(qrMsg);
  await sendMsgSafe(fromId, contextToken, qrMsg);

  // 2. 轮询扫码状态（带超时）
  const deadline = Date.now() + RECONNECT_CONFIG.qrcode_scan_timeout * 1000;
  let newToken = null, newBaseUrl = null;
  while (Date.now() < deadline) {
    try {
      const status = await fetch(
        `${botBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
      ).then(r => r.json());
      if (status.status === "confirmed") {
        newToken = status.bot_token;
        newBaseUrl = status.baseurl ?? botBaseUrl;
        break;
      }
    } catch {}
    await sleep(1000);
  }

  if (!newToken) {
    console.log("[重连] 扫码超时，重连未完成");
    await sendMsgSafe(fromId, contextToken, "[失败] 扫码超时，重连未完成，下次到期前会再次提醒");
    loginTime = Date.now();
    reconnectInProgress = false;
    return;
  }

  // 3. 原子替换 token 和 base_url
  botToken = newToken;
  botBaseUrl = newBaseUrl;
  Object.keys(typingTicketCache).forEach(k => delete typingTicketCache[k]);
  console.log("[重连] 新连接已建立，token 已切换");
  await sendMsgSafe(fromId, contextToken, "[完成] 新连接已建立，已自动切换，继续使用");

  reconnectInProgress = false;
  loginTime = Date.now();
  saveSession();
}

async function reconnectTimerLoop() {
  while (true) {
    // 等待到达预警时间点
    const elapsed = (Date.now() - loginTime) / 1000;
    const firstWait = Math.max(0, RECONNECT_CONFIG.session_duration - RECONNECT_CONFIG.warning_before - elapsed);
    await sleep(firstWait * 1000);

    // 检查是否已经超过强制重连阈值
    let remaining = (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000;
    if (remaining <= RECONNECT_CONFIG.force_before) {
      const msg = "[自动] 连接即将到期，开始强制重新连接...";
      console.log(msg);
      await sendMsgSafe(lastContact.fromId, lastContact.contextToken, msg);
      await doReconnect();
      continue;
    }

    // 发出初次预警
    const remainingH = (remaining / 3600).toFixed(1);
    const warnMsg = `[提醒] 连接还剩约 ${remainingH} 小时到期，是否现在重新连接？回复 Y 立即重连，N 稍后提醒`;
    console.log(warnMsg);
    await sendMsgSafe(lastContact.fromId, lastContact.contextToken, warnMsg);
    warningActive = true;

    // 询问循环：等待用户 Y 或超时重新提醒
    while (true) {
      remaining = (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000;
      if (remaining <= RECONNECT_CONFIG.force_before) {
        const forceMsg = "[自动] 连接即将到期，开始强制重新连接...";
        console.log(forceMsg);
        await sendMsgSafe(lastContact.fromId, lastContact.contextToken, forceMsg);
        await doReconnect();
        break;
      }

      const waitSecs = Math.max(0, Math.min(RECONNECT_CONFIG.reminder_interval,
                                             remaining - RECONNECT_CONFIG.force_before));

      // Promise.race：用户 Y 回复 或 超时
      let userReplied = false;
      await Promise.race([
        new Promise(r => { reconnectResolve = () => { userReplied = true; r(); }; }),
        sleep(waitSecs * 1000)
      ]);

      if (userReplied) {
        await doReconnect();
        break;
      }

      // 超时：重新评估剩余时间，视情况再次提醒
      remaining = (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000;
      if (remaining <= RECONNECT_CONFIG.force_before) continue;

      const remainingM = Math.round(remaining / 60);
      const remindMsg = `[提醒] 连接还剩约 ${remainingM} 分钟，是否现在重新连接？回复 Y 立即重连，N 继续等待`;
      console.log(remindMsg);
      await sendMsgSafe(lastContact.fromId, lastContact.contextToken, remindMsg);
    }
  }
}
// ========== 消息处理主循环 ==========
async function messageLoop() {
  console.log("开始监听消息...");
  let consecutiveFailures = 0;

  while (true) {
    // ── 长轮询获取消息 ──
    let result;
    if (isLocalEnabled()) {
      // 本地测试实例：不调微信 getupdates，等待本地 inbox 信号
      await onLocalInboxReady({ timeout_ms: 35000 });
      result = { msgs: [], get_updates_buf: getUpdatesBuf };
    } else {
      try {
        result = await apiPost(
          "ilink/bot/getupdates",
          { get_updates_buf: getUpdatesBuf, base_info: { channel_version: "1.0.2" } }
        );
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        console.log(`[消息循环] getupdates 失败 (${consecutiveFailures}/5): ${e.message}`);
        if (consecutiveFailures >= 5) {
          console.log("[消息循环] 连续失败 5 次，尝试重连...");
          await doReconnect();
          consecutiveFailures = 0;
        }
        await sleep(5000);
        continue;
      }
    }

    getUpdatesBuf = result.get_updates_buf ?? getUpdatesBuf;
    const wechatMsgs = result.msgs ?? [];
    const localMsgs = isLocalEnabled() ? drainLocalInbox() : [];
    const msgs = [...wechatMsgs, ...localMsgs];

    if (msgs.length > 0) {
      const types = msgs.map(m => `msg_type=${m.message_type} items=[${(m.item_list || []).map(i => i.type).join(",")}]`);
      console.log(`[getupdates] 收到 ${msgs.length} 条消息: ${types.join(" | ")}`);
      debugLog({ event: "getupdates_batch", count: msgs.length, types });
    }

    // ── 逐条处理消息 ──
    for (const msg of msgs) {
      const fromId = msg.from_user_id;
      const contextToken = msg.context_token;
      const topMsgType = msg.message_type;
      const itemTypes = (msg.item_list || []).map(it => it.type);

      // 所有消息写入调试日志
      debugLog({
        event: "inbound_msg",
        top_msg_type: topMsgType,
        item_types: itemTypes,
        summary: summarizeMsg(msg),
        raw_msg: msg,
      });

      // 非文本消息打印完整结构到控制台，方便排查
      if (topMsgType !== 1 || itemTypes.some(t => t !== 1)) {
        console.log(`\n┌── [DEBUG] 非文本消息 ─────────────────────────────`);
        console.log(`│  top_msg_type: ${topMsgType}`);
        console.log(`│  item_types:   [${itemTypes.join(", ")}]`);
        for (let i = 0; i < (msg.item_list || []).length; i++) {
          const item = msg.item_list[i];
          console.log(`│  item[${i}]: type=${item.type}`);
          for (const [k, v] of Object.entries(item).filter(([key]) => key !== "type")) {
            const vs = typeof v === "string" ? v.slice(0, 300) : JSON.stringify(v).slice(0, 300);
            console.log(`│    ${k}: ${vs}`);
          }
        }
        console.log(`│  完整 JSON 已写入: ${DEBUG_LOG_FILE}`);
        console.log(`└──────────────────────────────────────────────────`);
      }

      // 跳过非用户消息（如 Bot 自己发出的消息回显）
      if (topMsgType !== 1) continue;

      // ── 根据第一条 item 类型分流处理 ──
      const firstItem = msg.item_list?.[0];

      // >> 文件消息（type=4）
      if (firstItem?.type === 4) {
        const fileItem = firstItem.file_item;
        console.log(`\n┌── [文件消息] ${fileItem.file_name} (${fileItem.len} bytes) ──`);
        try {
          const fileData = await downloadAndDecryptFile(fileItem);
          await sendMsgSafe(fromId, contextToken,
            `已收到「${fileItem.file_name}」，正在解析，请稍候...`);

          let ocrProgressTimer = null;
          let ocrPageCount = 0;
          const ocrDonePages = new Set();
          const clearOcrProgressTimer = () => {
            if (ocrProgressTimer) {
              clearTimeout(ocrProgressTimer);
              ocrProgressTimer = null;
            }
          };

          const result = await (async () => {
            try {
              return await parseDocumentFile(fileData, async event => {
                if (event.type === "ocr_start") {
                  ocrPageCount = event.pageCount || 0;
                  await sendMsgSafe(fromId, contextToken, "需要OCR识别，请稍等。");
                  clearOcrProgressTimer();
                  ocrProgressTimer = setTimeout(() => {
                    const done = ocrDonePages.size;
                    const total = ocrPageCount || "?";
                    sendMsgSafe(fromId, contextToken, `OCR进行中（${done}/${total}页），请稍候。`);
                  }, 15000);
                } else if (event.type === "ocr_page" && event.page) {
                  ocrDonePages.add(event.page);
                }
              });
            } finally {
              clearOcrProgressTimer();
            }
          })();
          if (result.mode === "image") {
            console.log("[文件] 文档服务返回了旧版图片模式，请重启 document-service");
            await sendMsgSafe(fromId, contextToken,
              `文档解析服务需要重启，请稍后再试。`);
          } else if (result.mode === "ocr_text") {
            if (result.text === "(未能识别出文字内容)") {
              await sendMsgSafe(fromId, contextToken,
                `已收到「${fileItem.file_name}」（${result.pageCount}页），但未能识别出文字内容，可能是扫描质量较低或纯图片页面。`);
            } else {
              addPendingFile(fromId, {
                fileName: fileItem.file_name,
                text: result.text,
                timestamp: Date.now(),
              });
              const charCount = result.text.length;
              const totalFiles = pendingFiles.get(fromId)?.files?.length || 0;
              const source = result.source === "pdf_text" ? "文本层提取" : "OCR识别";
              const multiHint = totalFiles > 1 ? `（当前已暂存 ${totalFiles} 个文件）` : "";
              await sendMsgSafe(fromId, contextToken,
                `已收到「${fileItem.file_name}」（${result.pageCount}页），${source}出约 ${charCount} 字内容${multiHint}，请告诉我您的要求。`);
            }
          } else if (result.mode === "text" && result.text) {
            addPendingFile(fromId, {
              fileName: fileItem.file_name,
              text: result.text,
              timestamp: Date.now(),
            });
            const charCount = result.text.length;
            const totalFiles = pendingFiles.get(fromId)?.files?.length || 0;
            const multiHint = totalFiles > 1 ? `（当前已暂存 ${totalFiles} 个文件）` : "";
            const preview = result.text.slice(0, 50);
            const reply = `已收到「${fileItem.file_name}」，解析出约 ${charCount} 字内容${multiHint}，开头预览：\n\n---\n${preview}${result.text.length > 200 ? "\n…(后续内容已就绪)" : ""}\n---\n\n请告诉我您的要求，我会结合文件内容一并处理。`;
            console.log(`\n╔══ 文件内容（已暂存，等用户指令） ════════════════\n${result.text.slice(0, 500)}${result.text.length > 500 ? "...(截断)" : ""}\n──────────────────────────────────────────`);
            await sendMsgSafe(fromId, contextToken, reply);
          } else if (result.mode === "ocr_needed") {
            await sendMsgSafe(fromId, contextToken,
              `已收到「${fileItem.file_name}」（${result.pageCount}页），需要OCR，但OCR服务未配置。`);
          } else {
            await sendMsgSafe(fromId, contextToken,
              `[Bot] 收到文件 "${fileItem.file_name}"，但无法解析 .${result.type} 格式。目前支持: .docx, .txt, .pdf, .xlsx, .pptx`);
          }
        } catch (e) {
          console.log(`[文件] 处理失败: ${e.message}`);
          await sendMsgSafe(fromId, contextToken, `[Bot] 文件处理失败: ${e.message}`);
        }
        console.log(`└──────────────────────────────────────────────────`);
        continue;
      }

      // >> 图片消息（type=2）
      if (firstItem?.type === 2) {
        const imgItem = firstItem.image_item;
        console.log(`\n┌── [图片消息] ──`);
        try {
          const imgBuf = await downloadAndDecryptMedia(imgItem.media, "图片消息");
          const mediaType = detectImageFormat(imgBuf);
          if (!mediaType) {
            console.log(`[图片] 无法识别图片格式，文件头: ${imgBuf.slice(0, 16).toString("hex")}`);
            await sendMsgSafe(fromId, contextToken, "[Bot] 收到图片，但无法识别格式，请确认发送的是 JPEG/PNG/GIF/WebP 图片");
          } else {
            const base64 = imgBuf.toString("base64");
            const fileName = `图片_${Date.now()}.${mediaType.split("/")[1]}`;
            addPendingFile(fromId, {
              type: "image",
              fileName,
              images: [{ mediaType, base64 }],
              timestamp: Date.now(),
            });
            console.log(`[图片] 已暂存: ${mediaType} ${(imgBuf.length / 1024).toFixed(1)}KB`);
            await sendMsgSafe(fromId, contextToken,
              `已收到图片「${fileName}」，请告诉我您的要求（如"描述这张图"、"图上写了什么"等）。`);
          }
        } catch (e) {
          console.log(`[图片] 处理失败: ${e.message}`);
          await sendMsgSafe(fromId, contextToken, `[Bot] 图片处理失败: ${e.message}`);
        }
        console.log(`└──────────────────────────────────────────────────`);
        continue;
      }

      // >> 其他非文本消息（语音/视频等）
      if (firstItem?.type !== 1) {
        const typeNames = ["", "文本", "", "语音", "文件", "视频"];
        await sendMsgSafe(fromId, contextToken,
          `[Bot] 收到 ${typeNames[firstItem?.type] || "未知"}消息，暂不支持此类型`);
        continue;
      }

      // >> 纯文本消息
      const text = firstItem.text_item?.text;
      console.log(`\n╔══ 用户消息 ════════════════════════════════\n${text}\n──────────────────────────────────────────`);

      // 更新最近联系人（定时器用于发送重连通知）
      lastContact = { fromId, contextToken };

      // ── 消息优先级处理 ──

      // 1. 手动重连 Y/N 确认
      if (manualReconnectPending.has(fromId) && ["Y", "N"].includes(text?.trim()?.toUpperCase())) {
        manualReconnectPending.delete(fromId);
        if (text.trim().toUpperCase() === "Y") {
          await sendMsgSafe(fromId, contextToken, "好的，正在重新连接...");
          await doReconnect();
        } else {
          await sendMsgSafe(fromId, contextToken, "已取消重新连接");
        }
        continue;
      }

      // 2. 定时预警 Y/N 确认
      if (warningActive && ["Y", "N"].includes(text?.trim()?.toUpperCase())) {
        if (text.trim().toUpperCase() === "Y") {
          reconnectResolve?.();
          await sendMsgSafe(fromId, contextToken, "好的，正在重新连接...");
        } else {
          await sendMsgSafe(fromId, contextToken, "好的，稍后再提醒您");
        }
        continue;
      }

      // 3. 首次交互发送欢迎消息（有挂起文件则跳过，优先处理文件+AI 流程）
      if (!welcomedUsers.has(fromId) && !pendingFiles.has(fromId)) {
        welcomedUsers.add(fromId);
        await sendMsgSafe(fromId, contextToken, COMMANDS_MSG);
        continue;
      }
      welcomedUsers.add(fromId);

      // 4. 指令处理
      const cmd = text?.trim();

      if (["/help", "/指令"].includes(cmd)) {
        await sendMsgSafe(fromId, contextToken, COMMANDS_MSG);
        continue;
      }

      if (cmd === "/time") {
        const rem = Math.max(0, (loginTime + RECONNECT_CONFIG.session_duration * 1000 - Date.now()) / 1000);
        const h = Math.floor(rem / 3600);
        const m = Math.floor((rem % 3600) / 60);
        const s = Math.floor(rem % 60);
        const ts = h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟 ${s} 秒`;
        await sendMsgSafe(fromId, contextToken, `当前连接剩余时间：${ts}`);
        continue;
      }

      if (cmd === "/重新连接") {
        if (reconnectInProgress) {
          await sendMsgSafe(fromId, contextToken, "重连正在进行中，请稍候...");
        } else {
          manualReconnectPending.add(fromId);
          await sendMsgSafe(fromId, contextToken, "确认要立即重新连接吗？\n回复 Y 确认重连 / N 取消");
        }
        continue;
      }

      if (cmd === "/清空文件") {
        const anchorCount = (fileAnchors.get(fromId) || []).length;
        fileAnchors.delete(fromId);
        pendingFiles.delete(fromId);
        await sendMsgSafe(fromId, contextToken,
          anchorCount > 0
            ? `已清除当前对话中的 ${anchorCount} 个文件上下文。`
            : "当前没有文件上下文。");
        continue;
      }

      // 5. 以上都不匹配 → AI 对话（检查是否有待处理的文件/图片）
      const pendingEntry = pendingFiles.get(fromId);
      if (pendingEntry && pendingEntry.files.length > 0) {
        const allPending = pendingEntry.files;
        pendingFiles.delete(fromId);

        // 分离图片和文本文件
        const imageFiles = allPending.filter(f => f.type === "image");
        const textFiles = allPending.filter(f => !f.type || f.type !== "image");

        // 检查最早文件是否超时
        const oldestTs = Math.min(...allPending.map(f => f.timestamp));
        if (Date.now() - oldestTs > PENDING_FILE_TTL_MS) {
          console.log(`[文件] ${fromId} 的待处理文件已超时，丢弃 ${allPending.length} 个文件`);
          await sendAiReply(fromId, contextToken, text, null, {
            messageId: msg.message_id,
            timestamp: Date.now(),
            userContent: text,
          });
        } else if (textFiles.length === 0 && imageFiles.length === 1) {
          // 单图片：走旧的 content blocks 路径
          const img = imageFiles[0];
          const content = [
            ...img.images.map(img => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.base64 }
            })),
            { type: "text", text: `[用户上传了: ${img.fileName}]\n${text}` }
          ];
          console.log(`\n╔══ 合并图片+用户要求（传给AI） ══════════════\n图片=${img.fileName} 要求=${text.slice(0, 100)}\n──────────────────────────────────────────`);
          await sendAiReply(fromId, contextToken, content, null, {
            messageId: msg.message_id,
            timestamp: Date.now(),
            userContent: text,
            attachmentNames: [img.fileName],
            attachmentText: "",
          });
        } else {
          // 有文本文件（可能混合图片）：构建多文件合并消息
          let combined = "";
          const fileNames = [];

          if (textFiles.length > 0) {
            const fileLabel = textFiles.length === 1 ? "文件" : `${textFiles.length} 个文件`;
            combined += `[用户之前发送了以下 ${fileLabel}]\n\n`;
            for (let i = 0; i < textFiles.length; i++) {
              combined += `${"=".repeat(40)}\n`;
              combined += `文件${i + 1}: ${textFiles[i].fileName}\n`;
              combined += `${"=".repeat(40)}\n`;
              combined += textFiles[i].text + "\n\n";
              fileNames.push(textFiles[i].fileName);
            }
          }
          combined += `[用户要求]\n${text}`;

          console.log(`\n╔══ 合并 ${textFiles.length} 文件 + 用户要求（传给AI） ══════════════\n文件=${fileNames.join(", ")} 要求=${text.slice(0, 100)}\n──────────────────────────────────────────`);

          // 图片作为 content blocks 拼入
          if (imageFiles.length > 0) {
            const content = [
              ...imageFiles.flatMap(f => f.images.map(img => ({
                type: "image",
                source: { type: "base64", media_type: img.mediaType, data: img.base64 }
              }))),
              { type: "text", text }
            ];
            await sendAiReply(fromId, contextToken, content, textFiles, {
              messageId: msg.message_id,
              timestamp: Date.now(),
              userContent: text,
              attachmentNames: allPending.map(f => f.fileName),
              attachmentText: textFiles.map(f => `[${f.fileName}]\n${f.text}`).join("\n\n"),
            });
          } else {
            await sendAiReply(fromId, contextToken, text, textFiles, {
              messageId: msg.message_id,
              timestamp: Date.now(),
              userContent: text,
              attachmentNames: textFiles.map(f => f.fileName),
              attachmentText: textFiles.map(f => `[${f.fileName}]\n${f.text}`).join("\n\n"),
            });
          }
        }
      } else {
        await sendAiReply(fromId, contextToken, text, null, {
          messageId: msg.message_id,
          timestamp: Date.now(),
          userContent: text,
        });
      }
    }
  }
}
// =====================================

// ========== 启动入口 ==========
console.log(`
╔══════════════════════════════════════════════════════════╗
║          微信 ClawBot  ·  WeChat iLink Bot               ║
║  Copyright (c) 2026 SiverKing. All rights reserved.     ║
║  GitHub : https://github.com/SiverKing/weixin-ClawBot-API║
╚══════════════════════════════════════════════════════════╝`);

// 0. 加载配置文件
const botConfig = await loadOrCreateConfig();

// 0.1 初始化飞书自动汇总（缺省禁用，配置不完整不会影响 bot 启动）
initFeishuSummary(botConfig, {
  cwd: process.cwd(),
  callAI: callSummaryAI,
  aiConfig: {
    ...botConfig,
    api_key: botConfig.summary_api_key || botConfig.router_api_key || botConfig.api_key,
    base_url: botConfig.summary_base_url || botConfig.router_base_url || botConfig.base_url,
    model: botConfig.feishu_summary?.summary_model || botConfig.router_model || botConfig.model,
  },
});

// 0.1 初始化调度器模块
initScheduler(botConfig, {
  getLastContact: () => lastContact,
  sendMsg: sendMsgSafe,
  callAI,
  dailyStats,
});

// 0.1 文档解析服务健康检查（非阻塞）
{
  const documentServiceUrl = botConfig.document_service_url || DEFAULT_DOCUMENT_SERVICE_URL;
  try {
    const hc = await fetch(`${documentServiceUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    }).then(r => r.json());
    if (hc?.status === "ok") {
      console.log(`[Document] 服务健康检查通过: ${documentServiceUrl}`);
    } else {
      console.log(`[Document] 服务异常: ${JSON.stringify(hc)}`);
    }
  } catch (e) {
    console.log(`[Document] 服务健康检查失败（${e.message}），文件解析功能将不可用但 bot 主流程不受影响`);
  }
}

// 1. 尝试恢复登录态，有效则跳过扫码（本地测试实例跳过）
if (isLocalEnabled()) {
  botToken = "LOCAL_TEST_TOKEN";
  botBaseUrl = "http://127.0.0.1:0";
  loginTime = Date.now();
  initLocalChannel({
    port: Number(process.env.LOCAL_TEST_PORT),
    snapshotForProbe: (userId) => snapshotForProbe(userId, {
      pendingFiles, fileAnchors, conversationHistory,
      typingTicketCache, dailyStats, welcomedUsers, lastContact,
      lastRouting, lastRequestMeta, lastUsage,
    }),
    resetUser: (userId) => {
      pendingFiles.delete(userId);
      fileAnchors.delete(userId);
      conversationHistory.delete(userId);
      typingTicketCache[userId] && delete typingTicketCache[userId];
      welcomedUsers.delete(userId);
      lastRouting.delete(userId);
      lastRequestMeta.delete(userId);
      lastUsage.delete(userId);
    },
  });
  console.log(`[LOCAL] 测试通道已启用 :${process.env.LOCAL_TEST_PORT}`);
} else {
const savedSession = loadSession();
if (savedSession) {
  botToken = savedSession.botToken;
  botBaseUrl = savedSession.botBaseUrl;
  loginTime = savedSession.loginTime;
  getUpdatesBuf = savedSession.getUpdatesBuf ?? "";
  console.log("[Session] 登录态有效，跳过扫码直接启动");
} else {
  // 2. 获取登录二维码
  const { qrcode, qrcode_img_content } = await fetch(
    `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
  ).then(r => r.json());

  if (qrcode_img_content) {
    const content = String(qrcode_img_content);
    if (content.startsWith("data:image/")) {
      const [header, b64] = content.split(",");
      const ext = header.match(/data:image\/(\w+)/)?.[1] ?? "png";
      fs.writeFileSync(`qrcode.${ext}`, Buffer.from(b64, "base64"));
      console.log(`二维码已保存到 qrcode.${ext}`);
    } else if (content.startsWith("http")) {
      console.log("二维码图片地址:", content);
      console.log("请将图片地址发送给文件传输助手，然后用手机端微信打开链接进行连接！！！");
    } else if (content.startsWith("<svg")) {
      fs.writeFileSync("qrcode.svg", content);
      console.log("二维码已保存到 qrcode.svg，用浏览器打开");
    } else {
      fs.writeFileSync("qrcode.png", Buffer.from(content, "base64"));
      console.log("二维码已保存到 qrcode.png");
    }
  }

  // 3. 等待扫码确认
  console.log("等待扫码...");
  while (true) {
    const status = await fetch(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
    ).then(r => r.json());

    if (status.status === "confirmed") {
      botToken = status.bot_token;
      botBaseUrl = status.baseurl ?? BASE_URL;
      loginTime = Date.now();
      saveSession();
      console.log("登录成功！");
      console.log("=".repeat(40));
      console.log(COMMANDS_MSG);
      console.log("=".repeat(40));
      break;
    }
    await sleep(1000);
  }
}

} // isLocalEnabled else 块结束

// 4. 并发启动消息循环 + 重连定时器 + 调度器
if (!loginTime) loginTime = Date.now();
const tasks = [messageLoop(), schedulerLoop()];
if (!isLocalEnabled() && RECONNECT_CONFIG.timer_enabled) tasks.push(reconnectTimerLoop());
await Promise.all(tasks);
