import assert from "assert";
import { _setCacheSupported, isCacheSupported, normalizeUsage, stripCacheControl } from "../../lib/ai-client.js";

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

await test("normalizeUsage 解析缓存字段，缺失补 0", () => {
  const usage = normalizeUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 1800,
    cache_read_input_tokens: 30,
  });
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.cache_creation_input_tokens, 1800);
  assert.equal(usage.cache_read_input_tokens, 30);
  assert.equal(normalizeUsage().cache_read_input_tokens, 0);
});

await test("缓存支持开关可切换", () => {
  assert.equal(isCacheSupported(), true);
  _setCacheSupported(false);
  assert.equal(isCacheSupported(), false);
  _setCacheSupported(true);
});

await test("stripCacheControl 移除 system 与 message blocks 中的 cache_control", () => {
  const stripped = stripCacheControl({
    system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "y", cache_control: { type: "ephemeral" } }] }],
  });
  assert.equal(stripped.system[0].cache_control, undefined);
  assert.equal(stripped.messages[0].content[0].cache_control, undefined);
});
