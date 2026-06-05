import fs from "fs";
import { callClaude } from "../lib/ai-client.js";

const cfg = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const big = "测试缓存的长文本。".repeat(400);
const system = [{ type: "text", text: `你是测试助手。${big}`, cache_control: { type: "ephemeral" } }];
const messages = [{ role: "user", content: "只回复 OK 两个字。" }];

console.log("第 1 次（应写缓存）...");
const first = await callClaude({ system, messages, config: cfg, cache: { enabled: true } });
console.log("usage1:", JSON.stringify(first.usage));

console.log("第 2 次（应命中缓存）...");
const second = await callClaude({ system, messages, config: cfg, cache: { enabled: true } });
console.log("usage2:", JSON.stringify(second.usage));

if (second.usage.cache_read_input_tokens > 0) {
  console.log("中转支持 prompt caching，建议 prompt_cache.enabled=true");
} else {
  console.log("未观测到 cache_read，中转可能不支持。prompt_cache 可先设 false。");
}
