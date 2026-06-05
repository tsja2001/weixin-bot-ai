import assert from "assert";
import { buildRequest } from "../../context-builder.js";

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

await test("buildRequest 组装 system blocks、文件和历史", () => {
  const req = buildRequest({
    prompt: "你是助手。" + "x".repeat(1600),
    userContent: "帮我总结",
    history: [{ role: "assistant", content: "之前聊过" }],
    files: [{ id: "f1", fileName: "a.txt", content: "内容" }],
    profile: [{ id: "p1", text: "喜欢简洁" }],
    episodes: [{ id: "e1", summary: "聊过项目" }],
    promptCacheEnabled: true,
  });
  assert.equal(req.messages.length, 2);
  assert.equal(req.system[0].cache_control.type, "ephemeral");
  assert.ok(req.system.some(block => block.text.includes("a.txt")));
  assert.equal(req.meta.file_count, 1);
});
