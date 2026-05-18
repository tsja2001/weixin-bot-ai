// ========== 定时任务调度器模块 ==========
// 支持任务类型:
//   text         — 直接发送固定文本
//   daily_report — 发送当日消息数+token 统计
//   ai_greeting  — 调用 AI 生成问候语后发送
//
// 任务格式: { time: "HH:mm", action: "...", content: "..." }
// =========================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 依赖注入 ──
let _config;
let _delegate; // { getLastContact, sendMsg, callAI, dailyStats }

export function init(config, delegate) {
  _config = config;
  _delegate = delegate;
}

// ── 时间解析 ──
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

function resetStatsIfNewDay(stats) {
  const today = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (stats.date !== today) {
    stats.date = today;
    stats.messageCount = 0;
    stats.inputTokens = 0;
    stats.outputTokens = 0;
  }
}

// ── 任务执行 ──
async function executeTask(task) {
  console.log(`[调度] 执行任务: ${task.time} ${task.action}`);
  const contact = _delegate.getLastContact();
  if (!contact || !contact.fromId || !contact.contextToken) {
    console.log("[调度] 无可用联系人，跳过发送");
    return;
  }
  const { fromId, contextToken } = contact;

  switch (task.action) {
    case "text":
      await _delegate.sendMsg(fromId, contextToken, task.content);
      break;

    case "daily_report": {
      const stats = _delegate.dailyStats;
      resetStatsIfNewDay(stats);
      const report = [
        `[每日报告] ${stats.date}`,
        `消息数：${stats.messageCount} 条`,
        `输入 token：${stats.inputTokens.toLocaleString()}`,
        `输出 token：${stats.outputTokens.toLocaleString()}`,
        `合计 token：${(stats.inputTokens + stats.outputTokens).toLocaleString()}`,
      ].join("\n");
      console.log(report);
      await _delegate.sendMsg(fromId, contextToken, report);
      stats.messageCount = 0;
      stats.inputTokens = 0;
      stats.outputTokens = 0;
      break;
    }

    case "ai_greeting": {
      const fallback = task.fallback || "早上好！";
      let greeting;
      try {
        greeting = await _delegate.callAI(
          task.content,
          _config,
          [] // 问候语无需对话历史
        );
      } catch (e) {
        console.log(`[调度] AI 问候生成失败: ${e.message}，使用 fallback`);
        greeting = fallback;
      }
      // 发送前做一次修剪，避免 AI 输出带引号或过长
      greeting = greeting.trim().replace(/^["']|["']$/g, "");
      await _delegate.sendMsg(fromId, contextToken, greeting);
      break;
    }

    default:
      console.log(`[调度] 未知任务类型: ${task.action}`);
  }
}

// ── 主循环 ──
export async function loop() {
  const tasks = _config.scheduled_tasks;
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
        await executeTask(task);
      }
    }
  }
}
