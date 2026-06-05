import {
  MEMORY_RECALL_MAX_EPISODES,
  SECRETARY_FILE_PREVIEW_CHARS,
  SECRETARY_MARKER,
  SECRETARY_TIMEOUT_MS,
} from "./constants.js";
import { callDeepSeekJSON } from "./lib/deepseek.js";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(block => block.type === "text").map(block => block.text).join("\n");
  return String(content || "");
}

function fallback(memory, files, reason) {
  return {
    profileIds: (memory.profile || []).map(item => item.id),
    episodeIds: (memory.episodes || []).slice(0, MEMORY_RECALL_MAX_EPISODES).map(item => item.id),
    fileIds: (files || []).map(item => item.id),
    reason,
    fallback: true,
    usage: {},
    latencyMs: 0,
  };
}

export async function selectContext({
  userId,
  userContent,
  history = [],
  memory = { profile: [], episodes: [] },
  files = [],
  config,
  enabled = true,
  callJSON = callDeepSeekJSON,
  onLog = console.log,
  debugLog,
}) {
  if (!enabled) return fallback(memory, files, "secretary_disabled");
  const started = Date.now();
  try {
    const candidates = {
      files: files.map(file => ({
        id: file.id,
        fileName: file.fileName,
        preview: String(file.content || "").slice(0, SECRETARY_FILE_PREVIEW_CHARS),
      })),
      profile: (memory.profile || []).map(item => ({ id: item.id, text: item.text, hits: item.hits || 0 })),
      episodes: (memory.episodes || []).map(item => ({ id: item.id, summary: item.summary, tags: item.tags || [] })),
      recentHistory: history.slice(-6),
      userMessage: textOf(userContent),
    };
    const { json, usage } = await callJSON({
      config,
      marker: SECRETARY_MARKER,
      timeoutMs: SECRETARY_TIMEOUT_MS,
      messages: [{
        role: "user",
        content: [
          "请从候选上下文中选择本轮回答需要的 profileIds、episodeIds、fileIds。",
          "只返回 JSON：{\"profileIds\":[],\"episodeIds\":[],\"fileIds\":[],\"reason\":\"...\"}",
          JSON.stringify(candidates),
        ].join("\n"),
      }],
    });
    const result = {
      profileIds: Array.isArray(json.profileIds) ? json.profileIds : [],
      episodeIds: Array.isArray(json.episodeIds) ? json.episodeIds : [],
      fileIds: Array.isArray(json.fileIds) ? json.fileIds : [],
      reason: json.reason || "ok",
      fallback: false,
      usage,
      latencyMs: Date.now() - started,
    };
    onLog(`[秘书] user=${userId} 候选(文件=${files.length},记忆=${(memory.profile || []).length},事件=${(memory.episodes || []).length}) → 文件=[${result.fileIds.join(",")}] 事件=[${result.episodeIds.join(",")}] 画像=${result.profileIds.length} (${result.latencyMs}ms) reason=${result.reason}`);
    debugLog?.({
      event: "secretary_decision",
      user: userId,
      candidates: { files: files.length, profile: (memory.profile || []).length, episodes: (memory.episodes || []).length },
      selected: { files: result.fileIds, profile: result.profileIds, episodes: result.episodeIds },
      reason: result.reason,
      latency_ms: result.latencyMs,
      usage,
    });
    return result;
  } catch (error) {
    const result = fallback(memory, files, error.message);
    result.latencyMs = Date.now() - started;
    onLog(`[秘书] user=${userId} 降级(${error.message}) → 带全部文件+近${MEMORY_RECALL_MAX_EPISODES}事件`);
    debugLog?.({ event: "secretary_decision", user: userId, reason: error.message, fallback: true, latency_ms: result.latencyMs });
    return result;
  }
}
