import { SECRETARY_TIMEOUT_MS } from "../constants.js";

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek 响应不是 JSON");
    return JSON.parse(match[0]);
  }
}

export async function callDeepSeekJSON({
  config,
  messages,
  marker,
  timeoutMs = SECRETARY_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const apiKey = config.router_api_key || config.api_key;
  const baseUrl = process.env.ROUTER_BASE_URL || config.router_base_url || config.base_url;
  const model = config.router_model || "deepseek-chat";
  if (!apiKey || !baseUrl) throw new Error("DeepSeek 配置缺失");

  const res = await fetchImpl(`${stripTrailingSlash(baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: marker || "Return strict JSON." },
        ...messages,
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content;
  if (!content) throw new Error("DeepSeek 响应缺少 content");
  return { json: parseJSON(content), usage: data.usage || {} };
}
