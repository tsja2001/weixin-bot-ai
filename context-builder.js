import { CACHE_MIN_CHARS } from "./constants.js";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(block => block.type === "text").map(block => block.text).join("\n");
  return String(content || "");
}

function maybeCached(text, enabled) {
  const block = { type: "text", text };
  if (enabled && text.length >= CACHE_MIN_CHARS) {
    block.cache_control = { type: "ephemeral" };
  }
  return block;
}

function formatMemory(profile = [], episodes = []) {
  const parts = [];
  if (profile.length > 0) {
    parts.push("[长期画像]\n" + profile.map(item => `- (${item.id}) ${item.text}`).join("\n"));
  }
  if (episodes.length > 0) {
    parts.push("[相关往事]\n" + episodes.map(item => `- (${item.id}) ${item.summary}`).join("\n"));
  }
  return parts.join("\n\n");
}

function formatFiles(files = []) {
  return files.map(file => [
    `===== 文件: ${file.fileName} (${file.id}) =====`,
    file.content || "",
  ].join("\n")).join("\n\n");
}

export function buildRequest({
  prompt,
  userContent,
  history = [],
  files = [],
  profile = [],
  episodes = [],
  promptCacheEnabled = false,
  userId,
}) {
  const system = [maybeCached(prompt || "", promptCacheEnabled)];
  const memoryText = formatMemory(profile, episodes);
  if (memoryText) system.push({ type: "text", text: memoryText });
  const fileText = formatFiles(files);
  if (fileText) system.push(maybeCached(`[本轮相关文件上下文]\n${fileText}`, promptCacheEnabled));

  const userMessage = typeof userContent === "string"
    ? { role: "user", content: userContent }
    : { role: "user", content: userContent };

  const messages = [...history.map(item => ({ role: item.role, content: item.content })), userMessage];
  const meta = {
    user: userId,
    system_chars: system.reduce((sum, block) => sum + (block.text?.length || 0), 0),
    cached_blocks: system.filter(block => block.cache_control).length,
    file_count: files.length,
    profile_count: profile.length,
    episode_count: episodes.length,
    history_messages: history.length,
    approx_tokens: Math.ceil((system.map(b => b.text).join("\n").length + textOf(userContent).length) / 3),
  };
  return { system, messages, meta };
}
