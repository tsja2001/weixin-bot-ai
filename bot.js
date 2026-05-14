import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath, pathToFileURL } from "url";
import mammoth from "mammoth";

// ========== 常量 ==========
const BASE_URL = "https://ilinkai.weixin.qq.com";
const CONFIG_FILE = "config.json";
const SESSION_FILE = "session.json";
const DEBUG_LOG_FILE = "logs/debug_messages.jsonl";
const DEFAULT_PROMPT = "你是一个有帮助的AI助手，请用中文简洁地回复。字数尽量少一些";

// 欢迎消息（首次连接或 /help 时发送）
const COMMANDS_MSG = [
  "连接成功！",
  "可用指令：",
  "/help  /指令   - 查看全部指令列表",
  "/time          - 查询当前连接剩余时间",
  "/重新连接       - 立即触发重新连接（需确认）",
  "",
  "非指令输入即为 AI 对话"
].join("\n");

// 自动重连配置
const RECONNECT_CONFIG = {
  session_duration:    24 * 3600,  // 会话总时长（秒）
  warning_before:       2 * 3600,  // 提前多久发出警告
  reminder_interval:      30 * 60, // 用户回 N 后多久再问
  force_before:           30 * 60, // 最后多久强制重连
  qrcode_scan_timeout:       600,  // 等待扫码超时
};

// 对话记忆配置
const HISTORY_MAX_TURNS = 10;           // 保留最近 N 轮对话
const HISTORY_TTL_MS = 60 * 60 * 1000;  // 无活动多久后清空（毫秒）
const HISTORY_MAX_CONTENT_LEN = 2000;   // 历史中单条消息最大字数
const PDF_TEXT_MIN_CHARS = 200;         // 超过此长度优先使用 PDF 文本层，避免文本 PDF 误走 OCR
const PDF_OCR_RENDER_SCALE = 1.35;      // 多页扫描件 OCR 渲染倍率，控制识别速度和内存
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PDFJS_WASM_URL = pathToFileURL(path.join(APP_DIR, "node_modules/pdfjs-dist/wasm")).href + "/";

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

async function extractTextFromFile({ buffer, fileName }) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    console.log(`[文件] mammoth 提取: ${text.length} 字符`);
    if (result.messages.length > 0) {
      console.log(`[文件] mammoth 警告:`, result.messages.map(m => m.message).join("; "));
    }
    return { text, type: "docx" };
  }
  if (ext === "txt") {
    const text = buffer.toString("utf-8").trim();
    console.log(`[文件] txt 提取: ${text.length} 字符`);
    return { text, type: "txt" };
  }
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const text = wb.SheetNames.map(name => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      return `## Sheet: ${name}\n\n${csv}`;
    }).join("\n\n");
    console.log(`[文件] xlsx 提取: ${text.length} 字符, ${wb.SheetNames.length} sheets`);
    return { text, type: "xlsx" };
  }
  if (ext === "pptx") {
    const tmpPath = `logs/tmp_${Date.now()}.pptx`;
    try {
      fs.writeFileSync(tmpPath, buffer);
      const PPTXParser = (await import("node-pptx-parser")).default;
      const parser = new PPTXParser(tmpPath);
      const slides = await parser.extractText();
      const text = slides.map((s, i) => {
        const slideText = Array.isArray(s.text) ? s.text.join("\n") : s.text;
        return `## Slide ${i + 1}\n\n${slideText}`;
      }).join("\n\n");
      console.log(`[文件] pptx 提取: ${text.length} 字符, ${slides.length} slides`);
      return { text, type: "pptx" };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
  return { text: null, type: ext, error: `不支持的文件类型: .${ext}` };
}
// ===============================================

// ========== PDF 处理 ==========
async function ocrImages(imageBuffers) {
  const url = `${botConfig.ocr_service_url}/ocr/batch`;
  const formData = new FormData();
  imageBuffers.forEach((buf, i) => {
    formData.append("files", new Blob([buf]), `page_${i + 1}.png`);
  });
  const res = await fetch(url, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`OCR 服务返回 HTTP ${res.status}`);
  const data = await res.json();
  return data.pages; // [{page, text}, ...]
}

async function ocrImage(imageBuffer, pageNo) {
  const url = `${botConfig.ocr_service_url}/ocr/image`;
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer]), `page_${pageNo}.png`);
  const res = await fetch(url, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`OCR 服务返回 HTTP ${res.status}`);
  const data = await res.json();
  return { page: pageNo, text: data.text ?? "" };
}

function normalizePdfText(text) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfText(doc) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = normalizePdfText(content.items.map(item => item.str).join(" "));
    pages.push({ page: i, text });
  }
  const fullText = normalizePdfText(
    pages
      .filter(p => p.text)
      .map(p => `## 第 ${p.page} 页\n\n${p.text}`)
      .join("\n\n")
  );
  return { pages, fullText };
}

async function renderPdfPageToPng(page, scale) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function extractFromPdf(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Buffer extends Uint8Array in Node.js, so instanceof alone doesn't guard.
  // pdfjs-dist v5+ requires a pure Uint8Array, not a Buffer.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const doc = await pdfjsLib.getDocument({ data, wasmUrl: PDFJS_WASM_URL, useWasm: false }).promise;
  const pageCount = doc.numPages;
  console.log(`[PDF] 解析完成: ${pageCount} 页`);

  if (pageCount <= 3) {
    const images = [];

    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const pngBuffer = await renderPdfPageToPng(page, 2.0);
      const base64 = pngBuffer.toString("base64");
      images.push({ mediaType: "image/png", base64 });

      console.log(`[PDF] 第 ${i}/${pageCount} 页渲染完成: ${(pngBuffer.length / 1024).toFixed(1)}KB`);
    }

    return { mode: "image", pageCount, images };
  }

  // >3 pages: 检查 OCR 服务是否可用
  if (!botConfig.ocr_service_url) {
    return { mode: "ocr_needed", pageCount };
  }

  const t0 = Date.now();
  const extractedText = await extractPdfText(doc);
  if (extractedText.fullText.length >= PDF_TEXT_MIN_CHARS) {
    console.log(`[PDF] 文本层提取完成: ${extractedText.fullText.length} 字，跳过 OCR`);
    return { mode: "ocr_text", pageCount, text: extractedText.fullText, source: "pdf_text" };
  }

  let pages;
  try {
    pages = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const pngBuffer = await renderPdfPageToPng(page, PDF_OCR_RENDER_SCALE);
      console.log(`[PDF] 第 ${i}/${pageCount} 页渲染完成: ${(pngBuffer.length / 1024).toFixed(1)}KB，开始 OCR...`);
      const pageResult = await ocrImage(pngBuffer, i);
      pages.push(pageResult);
      console.log(`[PDF] 第 ${i}/${pageCount} 页 OCR 完成: ${pageResult.text.length} 字`);
    }
    console.log(`[PDF] OCR 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`[PDF] OCR 调用失败: ${e.message}`);
    throw new Error(`OCR 服务暂时不可用: ${e.message}`);
  }

  const fullText = pages.map(p => `## 第 ${p.page} 页\n\n${p.text}`).join("\n\n");
  if (!fullText.trim()) {
    return { mode: "ocr_text", pageCount, text: "(未能识别出文字内容)" };
  }
  return { mode: "ocr_text", pageCount, text: fullText };
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
      return cfg;
    }

    // 已有配置文件
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    console.log(`\n${sep}`);
    console.log("  检测到配置文件，当前配置如下：");
    console.log(sep);
    console.log(`  API Key  : ${maskKey(cfg.api_key ?? "")}`);
    console.log(`  API 地址 : ${cfg.base_url ?? ""}`);
    console.log(`  模型     : ${cfg.model ?? ""}`);
    const p = cfg.prompt ?? "";
    console.log(`  提示词   : ${p.slice(0, 50)}${p.length > 50 ? "..." : ""}`);
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
const pendingFiles = new Map();  // {fromId: {fileName, text, timestamp}}
const PENDING_FILE_TTL_MS = 30 * 60 * 1000;  // 30 分钟未回复则清空
// ================================================================

// ========== 对话上下文记忆 ==========
const conversationHistory = new Map();

function getHistoryForUser(fromId) {
  const entry = conversationHistory.get(fromId);
  if (!entry) return [];
  // 超过 TTL 则清空，避免跨话题混淆
  if (Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
    conversationHistory.delete(fromId);
    return [];
  }
  entry.lastActivity = Date.now();
  return entry.messages;
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
  if (!typingTicketCache[fromId]) {
    const cfg = await apiPost("ilink/bot/getconfig", {
      ilink_user_id: fromId, context_token: contextToken,
      base_info: { channel_version: "1.0.2" }
    });
    typingTicketCache[fromId] = cfg.typing_ticket ?? "";
  }
  return typingTicketCache[fromId];
}

// AI 回复完整流程：正在输入 → 调 AI → 发送 → 停止输入 → 记入历史
async function sendAiReply(fromId, contextToken, userContent) {
  const ticket = await ensureTypingTicket(fromId, contextToken);

  // status=1 显示"正在输入..."
  if (ticket) {
    await apiPost("ilink/bot/sendtyping", {
      ilink_user_id: fromId, typing_ticket: ticket, status: 1
    }).catch(() => {});
  }

  // 调用 AI
  const history = getHistoryForUser(fromId);
  const reply = await callAI(userContent, botConfig, history);
  resetStatsIfNewDay();
  dailyStats.messageCount++;
  addToHistory(fromId, userContent, reply);

  // 发送回复
  await sendMsgSafe(fromId, contextToken, reply);
  console.log(`\n╔══ AI 回复 ══════════════════════════════════\n${reply}\n──────────────────────────────────────────`);

  // status=2 取消"正在输入..."
  if (ticket) {
    await apiPost("ilink/bot/sendtyping", {
      ilink_user_id: fromId, typing_ticket: ticket, status: 2
    }).catch(() => {});
  }

  return reply;
}
// =========================================

// ========== AI API 调用 ==========
async function callAI(userContent, config, history = []) {
  const headers = {
    "Authorization": `Bearer ${config.api_key}`,
    "content-type": "application/json",
    "User-Agent": "claude-cli/2.0.76 (external, cli)",
  };

  const userMessage = typeof userContent === "string"
    ? { role: "user", content: userContent }
    : { role: "user", content: userContent };

  const payload = {
    model: config.model,
    max_tokens: 4096,
    system: config.prompt,
    messages: [...history, userMessage],
  };

  const retryDelays = [2, 4, 8, 16, 32]; // 秒
  const maxRetries = 5;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${config.base_url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (!text) throw new Error("响应中未找到文本内容");

      if (attempt > 0) {
        console.log(`[AI] 第 ${attempt} 次重试成功: ${text.slice(0, 80)}...`);
      }

      // 累计 token 消耗
      if (data.usage) {
        dailyStats.inputTokens += data.usage.input_tokens ?? data.usage.prompt_tokens ?? 0;
        dailyStats.outputTokens += data.usage.output_tokens ?? data.usage.completion_tokens ?? 0;
      }

      return text;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = retryDelays[attempt];
        console.log(`[AI] 第 ${attempt + 1} 次失败（${e.message}），${delay}s 后重试...`);
        await sleep(delay * 1000);
      }
    }
  }
  console.log(`[AI] 已重试 ${maxRetries} 次，最终失败: ${lastError.message}`);
  return "AI 接口暂时不可用，请稍后再试。";
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
// ===============================

// ========== 定时任务调度器 ==========
// 从 config.json 的 scheduled_tasks 读取任务列表
// 任务格式: { time: "08:45", action: "text"|"daily_report", content: "..." }
//   text         — 直接发送 content 字符串
//   daily_report — 发送当日消息数+token 统计

function parseTimeToMs(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return (h * 60 + m) * 60 * 1000;
}

function getMsUntilNext(targetMsFromMidnight) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const nowMs = now - midnight;
  let diff = targetMsFromMidnight - nowMs;
  if (diff <= 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}

async function executeScheduledTask(task) {
  console.log(`[调度] 执行任务: ${task.time} ${task.action}`);
  const { fromId, contextToken } = lastContact;
  if (!fromId || !contextToken) {
    console.log("[调度] 无可用联系人，跳过发送");
    return;
  }

  switch (task.action) {
    case "text":
      await sendMsgSafe(fromId, contextToken, task.content);
      break;
    case "daily_report":
      resetStatsIfNewDay();
      {
        const today = dailyStats.date;
        const report = [
          `[每日报告] ${today}`,
          `消息数：${dailyStats.messageCount} 条`,
          `输入 token：${dailyStats.inputTokens.toLocaleString()}`,
          `输出 token：${dailyStats.outputTokens.toLocaleString()}`,
          `合计 token：${(dailyStats.inputTokens + dailyStats.outputTokens).toLocaleString()}`,
        ].join("\n");
        console.log(report);
        await sendMsgSafe(fromId, contextToken, report);
        dailyStats.messageCount = 0;
        dailyStats.inputTokens = 0;
        dailyStats.outputTokens = 0;
      }
      break;
    default:
      console.log(`[调度] 未知任务类型: ${task.action}`);
  }
}

async function schedulerLoop() {
  const tasks = botConfig.scheduled_tasks;
  if (!tasks || tasks.length === 0) {
    console.log("[调度] 未配置定时任务，调度器休眠");
    while (true) await sleep(24 * 60 * 60 * 1000);
  }

  while (true) {
    let minWait = Infinity;
    let nextTask = null;

    for (const task of tasks) {
      const targetMs = parseTimeToMs(task.time);
      const wait = getMsUntilNext(targetMs);
      if (wait < minWait) { minWait = wait; nextTask = task; }
    }

    const nextTime = new Date(Date.now() + minWait).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    console.log(`[调度] 下一个任务: ${nextTask.time} (${nextTask.action}), 预计 ${nextTime}`);
    await sleep(minWait);

    // 同时刻的任务一起执行
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const currentTimeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    for (const task of tasks) {
      if (task.time === currentTimeStr) {
        await executeScheduledTask(task);
      }
    }
  }
}
// ===================================

// ========== 消息处理主循环 ==========
async function messageLoop() {
  console.log("开始监听消息...");
  let consecutiveFailures = 0;

  while (true) {
    // ── 长轮询获取消息 ──
    let result;
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

    getUpdatesBuf = result.get_updates_buf ?? getUpdatesBuf;
    const msgs = result.msgs ?? [];

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
          const ext = fileData.fileName.split(".").pop()?.toLowerCase();

          if (ext === "pdf") {
            // 先发中间反馈（OCR 处理耗时）
            await sendMsgSafe(fromId, contextToken,
              `已收到「${fileItem.file_name}」，正在处理，请稍候...`);

            let result;
            try {
              result = await extractFromPdf(fileData.buffer);
            } catch (e) {
              console.log(`[PDF] 处理失败: ${e.message}`);
              console.log(`[PDF] 错误栈: ${e.stack}`);
              await sendMsgSafe(fromId, contextToken, `[Bot] PDF 处理失败: ${e.message}`);
              continue;
            }

            if (result.mode === "image") {
              pendingFiles.set(fromId, {
                type: "image",
                fileName: fileItem.file_name,
                images: result.images,
                timestamp: Date.now(),
              });
              await sendMsgSafe(fromId, contextToken,
                `已收到「${fileItem.file_name}」（${result.pageCount}页），已转换为图片，请告诉我您的要求。`);
            } else if (result.mode === "ocr_text") {
              if (result.text === "(未能识别出文字内容)") {
                await sendMsgSafe(fromId, contextToken,
                  `已收到「${fileItem.file_name}」（${result.pageCount}页），但未能识别出文字内容，可能是扫描质量较低或纯图片页面。`);
              } else {
                pendingFiles.set(fromId, {
                  fileName: fileItem.file_name,
                  text: result.text,
                  timestamp: Date.now(),
                });
                const charCount = result.text.length;
                await sendMsgSafe(fromId, contextToken,
                  `已收到「${fileItem.file_name}」（${result.pageCount}页），OCR识别出约 ${charCount} 字内容，请告诉我您的要求。`);
              }
            } else {
              await sendMsgSafe(fromId, contextToken,
                `已收到「${fileItem.file_name}」（${result.pageCount}页），超过3页的PDF识别功能暂未配置OCR服务。`);
            }
          } else {
            const extracted = await extractTextFromFile(fileData);
            if (extracted.text) {
              pendingFiles.set(fromId, {
                fileName: fileItem.file_name,
                text: extracted.text,
                timestamp: Date.now(),
              });
              const charCount = extracted.text.length;
              const preview = extracted.text.slice(0, 50);
              const reply = `已收到「${fileItem.file_name}」，解析出约 ${charCount} 字内容，开头预览：\n\n---\n${preview}${extracted.text.length > 200 ? "\n…(后续内容已就绪)" : ""}\n---\n\n请告诉我您的要求，我会结合文件内容一并处理。`;
              console.log(`\n╔══ 文件内容（已暂存，等用户指令） ════════════════\n${extracted.text.slice(0, 500)}${extracted.text.length > 500 ? "...(截断)" : ""}\n──────────────────────────────────────────`);
              await sendMsgSafe(fromId, contextToken, reply);
            } else {
              await sendMsgSafe(fromId, contextToken,
                `[Bot] 收到文件 "${fileItem.file_name}"，但无法解析 .${extracted.type} 格式。目前支持: .docx, .txt, .pdf, .xlsx, .pptx`);
            }
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
            pendingFiles.set(fromId, {
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

      // 5. 以上都不匹配 → AI 对话（检查是否有待处理的文件/图片）
      const pendingFile = pendingFiles.get(fromId);
      if (pendingFile) {
        pendingFiles.delete(fromId);
        // 检查 TTL，超时则忽略
        if (Date.now() - pendingFile.timestamp > PENDING_FILE_TTL_MS) {
          console.log(`[文件] ${fromId} 的待处理文件已超时，丢弃`);
          await sendAiReply(fromId, contextToken, text);
        } else if (pendingFile.type === "image") {
          const content = [
            ...pendingFile.images.map(img => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.base64 }
            })),
            { type: "text", text: `[用户上传了: ${pendingFile.fileName}]\n${text}` }
          ];
          console.log(`\n╔══ 合并图片+用户要求（传给AI） ══════════════\n图片=${pendingFile.fileName} 要求=${text.slice(0, 100)}\n──────────────────────────────────────────`);
          await sendAiReply(fromId, contextToken, content);
        } else {
          // text 类型（向后兼容无 type 字段的旧 pending 数据）
          const combined = `[用户之前发送了文件: ${pendingFile.fileName}]\n\n${pendingFile.text}\n\n[用户要求]\n${text}`;
          console.log(`\n╔══ 合并文件+用户要求（传给AI） ══════════════\n文件=${pendingFile.fileName} 要求=${text.slice(0, 100)}\n──────────────────────────────────────────`);
          await sendAiReply(fromId, contextToken, combined);
        }
      } else {
        await sendAiReply(fromId, contextToken, text);
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

// 0.1 OCR 服务健康检查（非阻塞）
if (botConfig.ocr_service_url) {
  try {
    const hc = await fetch(`${botConfig.ocr_service_url}/health`, {
      signal: AbortSignal.timeout(5000),
    }).then(r => r.json());
    if (hc?.status === "ok") {
      console.log(`[OCR] 服务健康检查通过: ${botConfig.ocr_service_url} (${hc.model})`);
    } else {
      console.log(`[OCR] 服务异常: ${JSON.stringify(hc)}`);
    }
  } catch (e) {
    console.log(`[OCR] 服务健康检查失败（${e.message}），OCR 功能将不可用但 bot 主流程不受影响`);
  }
}

// 1. 尝试恢复登录态，有效则跳过扫码
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

// 4. 并发启动消息循环 + 重连定时器 + 调度器
if (!loginTime) loginTime = Date.now();
await Promise.all([messageLoop(), reconnectTimerLoop(), schedulerLoop()]);
