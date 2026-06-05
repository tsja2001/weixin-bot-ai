import { formatShanghaiDate } from "./formatter.js";
import { appendDailyReportDoc } from "./lark-cli.js";

function bulletList(items, emptyText) {
  if (!items.length) return emptyText;
  return items.map(item => `- ${item}`).join("\n");
}

export async function generateDailyReportFromQueue({ config, queue, date = formatShanghaiDate(), callAI, aiConfig }) {
  const items = queue.recordsForDate(date);
  const totalInput = items.reduce((sum, item) => sum + (Number(item.fields["输入Token"]) || 0), 0);
  const totalOutput = items.reduce((sum, item) => sum + (Number(item.fields["输出Token"]) || 0), 0);
  const failed = items.filter(item => item.status === "failed");
  const attachmentItems = items.filter(item => item.fields["附件名称"]);
  const summaries = items.map(item => item.fields["摘要"]).filter(Boolean);

  let aiSection = "";
  if (items.length > 0 && callAI) {
    const source = items.slice(0, 80).map((item, index) => [
      `${index + 1}. ${item.fields["摘要"]}`,
      `用户：${String(item.fields["用户内容"] || "").slice(0, 300)}`,
      `回复：${String(item.fields["AI回复内容"] || "").slice(0, 300)}`,
    ].join("\n")).join("\n\n");
    try {
      const result = await callAI([
        "根据下面的聊天记录生成今日简报，包含主要话题、重要结论、待办事项。要求简洁、分段。",
        source,
      ].join("\n\n"), aiConfig, []);
      aiSection = typeof result === "string" ? result : result?.text || "";
    } catch (e) {
      console.log(`[飞书汇总] 日报 AI 生成失败: ${e.message}`);
    }
  }

  const markdown = [
    `# ${date} 聊天简报`,
    "",
    `今日总对话数：${items.length}`,
    `输入 token：${totalInput}`,
    `输出 token：${totalOutput}`,
    `总 token：${totalInput + totalOutput}`,
    "",
    "## 主要话题",
    aiSection || bulletList(summaries.slice(0, 12), "暂无可汇总话题。"),
    "",
    "## 涉及附件的对话",
    bulletList(attachmentItems.map(item => `${item.fields["摘要"]}（${String(item.fields["附件名称"]).replace(/\n/g, "、")}）`).slice(0, 20), "今日无附件对话。"),
    "",
    "## 异常或失败记录",
    bulletList(failed.map(item => `${item.recordId}: ${item.error || "同步失败"}`), "今日无同步失败记录。"),
  ].join("\n");

  if (config.daily_doc_token) {
    await appendDailyReportDoc(config, markdown, `${date} 聊天简报`);
  }

  return { date, markdown, count: items.length };
}
