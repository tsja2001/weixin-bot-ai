import path from "path";

const DEFAULTS = {
  summary_model: "deepseek-v4-flash",
  summary_max_chars: 20,
  sync_mode: "async",
  queue_file: "logs/feishu_summary_queue.jsonl",
  daily_report_time: "20:00",
};

export function normalizeFeishuSummaryConfig(config = {}, runtimeInfo = {}) {
  const raw = config.feishu_summary;
  const logPrefix = runtimeInfo.logPrefix || "[飞书汇总]";

  if (!raw || raw.enabled !== true) {
    return { enabled: false, reason: "未启用 feishu_summary" };
  }

  const normalized = {
    ...DEFAULTS,
    ...raw,
  };

  const missing = [];
  for (const key of ["profile", "chatbox_folder_token", "base_app_token", "table_id"]) {
    if (!normalized[key]) missing.push(key);
  }

  if (missing.length > 0) {
    console.log(`${logPrefix} 配置不完整，已禁用。缺少: ${missing.join(", ")}`);
    return { enabled: false, reason: `缺少配置: ${missing.join(", ")}` };
  }

  const cwd = runtimeInfo.cwd || process.cwd();
  normalized.queue_file = path.isAbsolute(normalized.queue_file)
    ? normalized.queue_file
    : path.join(cwd, normalized.queue_file);
  normalized.summary_max_chars = Number(normalized.summary_max_chars) || DEFAULTS.summary_max_chars;
  normalized.summary_model = normalized.summary_model || DEFAULTS.summary_model;
  normalized.sync_mode = normalized.sync_mode || DEFAULTS.sync_mode;
  normalized.daily_report_time = normalized.daily_report_time || DEFAULTS.daily_report_time;
  normalized.enabled = true;

  return normalized;
}
