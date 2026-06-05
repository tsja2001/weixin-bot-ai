import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { extractAndSaveMemory } from "../../memory/extract.js";
import { loadMemory } from "../../memory/store.js";

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "extract-"));

await test("extractAndSaveMemory 写入事实和事件", async () => {
  await extractAndSaveMemory({
    userId: "local:default",
    userText: "我在国企工作，喜欢简约风",
    aiReply: "记住了",
    config: {},
    callJSON: async () => ({ json: { facts: ["在国企工作"], episode: { summary: "聊到工作偏好", tags: ["工作"] } }, usage: {} }),
    onLog: () => {},
  });
  const memory = loadMemory("local:default");
  assert.equal(memory.profile[0].text, "在国企工作");
  assert.equal(memory.episodes[0].summary, "聊到工作偏好");
});
