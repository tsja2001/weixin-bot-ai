import {
  EXTRACT_MARKER,
  MEMORY_EPISODE_SUMMARY_CHARS,
  MEMORY_MAX_EPISODES,
  MEMORY_MAX_PROFILE,
} from "../constants.js";
import { callDeepSeekJSON } from "../lib/deepseek.js";
import { addEpisode, applyNewFacts, loadMemory, saveMemory } from "./store.js";

function trimSummary(text) {
  const value = String(text || "").trim();
  return value.length > MEMORY_EPISODE_SUMMARY_CHARS
    ? value.slice(0, MEMORY_EPISODE_SUMMARY_CHARS)
    : value;
}

export async function extractAndSaveMemory({
  userId,
  userText,
  aiReply,
  config,
  enabled = true,
  callJSON = callDeepSeekJSON,
  onLog = console.log,
  debugLog,
}) {
  if (!enabled) return null;
  try {
    const { json, usage } = await callJSON({
      config,
      marker: EXTRACT_MARKER,
      messages: [{
        role: "user",
        content: [
          "请从这一轮对话抽取值得长期记住的用户事实，并写一条简短事件摘要。",
          "只返回 JSON：{\"facts\":[],\"episode\":{\"summary\":\"\",\"tags\":[]}}",
          `[用户]\n${userText}`,
          `[助手]\n${aiReply}`,
        ].join("\n"),
      }],
    });
    let memory = loadMemory(userId);
    const facts = Array.isArray(json.facts) ? json.facts : [];
    memory = applyNewFacts(memory, facts, MEMORY_MAX_PROFILE);
    const episode = json.episode || {};
    const summary = trimSummary(episode.summary || "");
    if (summary) {
      memory = addEpisode(memory, summary, episode.tags || [], MEMORY_MAX_EPISODES);
    }
    memory = saveMemory(userId, memory);
    onLog(facts.length > 0
      ? `[记忆] user=${userId} +画像${facts.map(f => `"${typeof f === "string" ? f : f?.text}"`).join(" ")} +事件"${summary}"`
      : `[记忆] user=${userId} 无新增（${summary ? "已写事件摘要" : "无事件摘要"}）`);
    debugLog?.({ event: "memory_extract", user: userId, new_facts: facts, episode: summary, usage });
    return memory;
  } catch (error) {
    onLog(`[记忆] user=${userId} 抽取失败: ${error.message}`);
    debugLog?.({ event: "memory_extract", user: userId, error: error.message });
    return null;
  }
}
