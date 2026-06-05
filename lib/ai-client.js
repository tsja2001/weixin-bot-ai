import { setTimeout as sleep } from "timers/promises";

let cacheSupported = true;

const RETRY_DELAYS = [2, 4, 8, 16, 32];

export function normalizeUsage(usage = {}) {
  const n = (...keys) => {
    for (const key of keys) {
      const value = usage?.[key];
      if (value != null) return Number(value) || 0;
    }
    return 0;
  };
  return {
    input_tokens: n("input_tokens", "prompt_tokens", "inputTokens"),
    output_tokens: n("output_tokens", "completion_tokens", "outputTokens"),
    cache_creation_input_tokens: n("cache_creation_input_tokens", "cache_creation_tokens"),
    cache_read_input_tokens: n("cache_read_input_tokens", "cache_read_tokens"),
  };
}

export function isCacheSupported() {
  return cacheSupported;
}

export function _setCacheSupported(value) {
  cacheSupported = Boolean(value);
}

export function stripCacheControl({ system, messages }) {
  const strip = (block) => {
    if (block && typeof block === "object" && "cache_control" in block) {
      const { cache_control, ...rest } = block;
      return rest;
    }
    return block;
  };
  const strippedSystem = Array.isArray(system) ? system.map(strip) : system;
  const strippedMessages = (messages || []).map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(strip) };
  });
  return { system: strippedSystem, messages: strippedMessages };
}

export async function callClaude({
  system,
  messages,
  config,
  cache = { enabled: false },
  onLog = console.log,
  fetchImpl = fetch,
}) {
  const headers = {
    "Authorization": `Bearer ${config.api_key}`,
    "content-type": "application/json",
    "User-Agent": "claude-cli/2.0.76 (external, cli)",
  };
  const url = `${config.base_url}/v1/messages`;
  const useCache = Boolean(cache.enabled && cacheSupported);
  let request = useCache ? { system, messages } : stripCacheControl({ system, messages });
  let payload = { model: config.model, max_tokens: 4096, ...request };
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        if (useCache && /cache|unsupported|invalid.*control/i.test(errBody)) {
          cacheSupported = false;
          onLog(`[缓存] 中转疑似不支持 cache_control（HTTP ${res.status}），永久降级为无缓存`);
          request = stripCacheControl({ system, messages });
          payload = { model: config.model, max_tokens: 4096, ...request };
          continue;
        }
        onLog(`[AI] HTTP ${res.status} 响应体: ${errBody.slice(0, 500)}`);
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const text = data.content?.find?.(item => item.type === "text")?.text ?? data.content?.[0]?.text;
      if (!text) throw new Error("响应中未找到文本内容");
      const usage = normalizeUsage(data.usage);
      const hit = usage.cache_read_input_tokens > 0;
      onLog(`[缓存] 写=${usage.cache_creation_input_tokens} 读=${usage.cache_read_input_tokens} (${useCache ? (hit ? "命中" : "未命中") : "未启用"})`);
      return { text, usage };
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_DELAYS.length) {
        onLog(`[AI] 第 ${attempt + 1} 次失败（${error.message}），${RETRY_DELAYS[attempt]}s 后重试`);
        await sleep(RETRY_DELAYS[attempt] * 1000);
      }
    }
  }

  onLog(`[AI] 已重试 ${RETRY_DELAYS.length} 次最终失败: ${lastError?.message}`);
  return { text: "AI 接口暂时不可用，请稍后再试。", usage: normalizeUsage({}) };
}
