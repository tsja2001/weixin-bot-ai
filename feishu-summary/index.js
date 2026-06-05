import { normalizeFeishuSummaryConfig } from "./config.js";
import { buildChatTurnRecord, formatShanghaiDate } from "./formatter.js";
import { generateSummary } from "./summarizer.js";
import { FeishuSummaryQueue } from "./queue.js";
import { upsertChatRecord } from "./lark-cli.js";
import { generateDailyReportFromQueue } from "./daily-report.js";

let state = {
  enabled: false,
  config: null,
  queue: null,
  runtimeInfo: {},
  dailyTimerStarted: false,
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseTimeToMs(timeStr) {
  const [h, m] = String(timeStr || "20:00").split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) * 60 * 1000;
}

function getMsUntilNextShanghai(timeStr) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const nowMs = now - midnight;
  let diff = parseTimeToMs(timeStr) - nowMs;
  if (diff <= 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}

async function dailyReportLoop() {
  while (state.enabled) {
    const wait = getMsUntilNextShanghai(state.config.daily_report_time);
    const nextTime = new Date(Date.now() + wait).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    console.log(`[飞书汇总] 下一个每日简报: ${state.config.daily_report_time}, 预计 ${nextTime}`);
    await sleep(wait);
    try {
      await generateDailyReport(formatShanghaiDate());
    } catch (e) {
      console.log(`[飞书汇总] 每日简报生成失败: ${e.message}`);
    }
  }
}

async function syncRecord(record) {
  try {
    const syncedRecord = {
      ...record,
      fields: {
        ...record.fields,
        "同步状态": "synced",
        "错误信息": "",
      },
    };
    const result = await upsertChatRecord(state.config, syncedRecord);
    state.queue.markSynced(record.recordId, result.data || {});
    console.log(`[飞书汇总] 已同步记录: ${record.recordId}`);
  } catch (e) {
    state.queue.markFailed(record.recordId, e);
    console.log(`[飞书汇总] 同步失败: ${record.recordId} ${e.message}`);
  }
}

export function initFeishuSummary(config, runtimeInfo = {}) {
  const normalized = normalizeFeishuSummaryConfig(config, runtimeInfo);
  if (!normalized.enabled) {
    state = { enabled: false, config: normalized, queue: null, runtimeInfo };
    console.log(`[飞书汇总] 未启用: ${normalized.reason}`);
    return state;
  }

  const queue = new FeishuSummaryQueue(normalized.queue_file);
  state = { enabled: true, config: normalized, queue, runtimeInfo, dailyTimerStarted: true };
  console.log(`[飞书汇总] 已启用，profile=${normalized.profile}, queue=${normalized.queue_file}`);

  for (const record of queue.pendingRecords()) {
    setTimeout(() => syncRecord(record), 0);
  }
  setTimeout(() => dailyReportLoop(), 0);

  return state;
}

export async function recordChatTurn(event) {
  if (!state.enabled) return null;

  const summary = await generateSummary(event, {
    callAI: state.runtimeInfo.callAI,
    aiConfig: state.runtimeInfo.aiConfig,
    model: state.config.summary_model,
    maxChars: state.config.summary_max_chars,
  });

  const record = buildChatTurnRecord({
    ...event,
    summary,
    summaryModel: state.config.summary_model,
    syncStatus: "pending",
  });
  state.queue.enqueue(record);

  if (state.config.sync_mode === "sync") {
    await syncRecord(record);
  } else {
    setTimeout(() => syncRecord(record), 0);
  }
  return record;
}

export async function generateDailyReport(date = formatShanghaiDate()) {
  if (!state.enabled) return null;
  return generateDailyReportFromQueue({
    config: state.config,
    queue: state.queue,
    date,
    callAI: state.runtimeInfo.callAI,
    aiConfig: state.runtimeInfo.aiConfig,
  });
}

export function getFeishuSummaryState() {
  return state;
}
