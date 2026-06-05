import crypto from "crypto";

const FIELD_ORDER = [
  "摘要",
  "时间",
  "用户内容",
  "AI回复内容",
  "附件内容",
  "附件名称",
  "输入Token",
  "输出Token",
  "总Token",
  "日期",
  "实例",
  "微信用户ID",
  "记录ID",
  "主模型",
  "摘要模型",
  "同步状态",
  "错误信息",
];

const MAX_TEXT_FIELD_CHARS = 90000;

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return parts;
}

export function formatShanghaiDateTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function formatShanghaiDate(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function truncateField(value, maxChars = MAX_TEXT_FIELD_CHARS) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[已截断，原始长度 ${text.length} 字符]`;
}

function buildRecordId(event) {
  if (event.messageId) return `${event.instanceName}:${event.messageId}`;
  const hash = crypto
    .createHash("sha256")
    .update([
      event.instanceName || "",
      event.fromId || "",
      event.timestamp || "",
      event.userContent || "",
    ].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${event.instanceName || "unknown"}:${event.timestamp || Date.now()}:${event.fromId || "unknown"}:${hash}`;
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0) || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function buildChatTurnRecord(event) {
  const timestamp = event.timestamp || Date.now();
  const usage = normalizeUsage(event.usage);
  const recordId = buildRecordId(event);
  const attachmentNames = Array.isArray(event.attachmentNames)
    ? event.attachmentNames.filter(Boolean).join("\n")
    : String(event.attachmentNames || "");

  const fields = {
    "摘要": event.summary || "未命名对话",
    "时间": formatShanghaiDateTime(timestamp),
    "用户内容": truncateField(event.userContent),
    "AI回复内容": truncateField(event.aiReply),
    "附件内容": truncateField(event.attachmentText),
    "附件名称": truncateField(attachmentNames, 10000),
    "输入Token": usage.inputTokens,
    "输出Token": usage.outputTokens,
    "总Token": usage.totalTokens,
    "日期": formatShanghaiDate(timestamp),
    "实例": event.instanceName || "",
    "微信用户ID": event.fromId || "",
    "记录ID": recordId,
    "主模型": event.model || "",
    "摘要模型": event.summaryModel || "",
    "同步状态": event.syncStatus || "pending",
    "错误信息": event.errorMessage || "",
  };

  return {
    recordId,
    fields: Object.fromEntries(FIELD_ORDER.map(key => [key, fields[key]])),
  };
}

export { FIELD_ORDER };
