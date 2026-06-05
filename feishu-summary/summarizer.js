function sanitizeSummary(text, maxChars) {
  let summary = String(text || "")
    .trim()
    .replace(/^摘要[:：]\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[。！？!?；;，,、\s]+$/g, "")
    .trim();
  if (summary.length > maxChars) summary = summary.slice(0, maxChars);
  return summary || "未命名对话";
}

function fallbackSummary(event, maxChars) {
  const source = String(event.userContent || event.aiReply || "").trim();
  return sanitizeSummary(source.slice(0, maxChars), maxChars);
}

export async function generateSummary(event, options = {}) {
  const maxChars = Number(options.maxChars || 20);
  const callAI = options.callAI;
  if (!callAI) return fallbackSummary(event, maxChars);

  const prompt = [
    `请为下面这轮微信对话生成 ${maxChars} 个中文字符以内的短摘要。`,
    "要求：不要加引号，不要写“摘要：”，不要堆叠标点，只输出摘要本身。",
    "",
    `用户内容：${String(event.userContent || "").slice(0, 1000)}`,
    event.attachmentNames?.length ? `附件名称：${event.attachmentNames.join("、")}` : "",
    `AI回复：${String(event.aiReply || "").slice(0, 500)}`,
  ].filter(Boolean).join("\n");

  try {
    const result = await callAI(prompt, {
      ...options.aiConfig,
      model: options.model || options.aiConfig?.model,
    }, []);
    const text = typeof result === "string" ? result : result?.text;
    return sanitizeSummary(text, maxChars);
  } catch (e) {
    console.log(`[飞书汇总] 摘要生成失败，使用本地摘要: ${e.message}`);
    return fallbackSummary(event, maxChars);
  }
}

export { sanitizeSummary };
