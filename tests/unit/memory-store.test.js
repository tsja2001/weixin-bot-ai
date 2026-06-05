import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
const { loadMemory, saveMemory, memoryPath, applyNewFacts, addEpisode, touchProfile } = await import("../../memory/store.js");

await test("不存在时返回空结构", () => {
  const memory = loadMemory("local:default");
  assert.equal(memory.version, 1);
  assert.deepEqual(memory.profile, []);
  assert.deepEqual(memory.episodes, []);
});

await test("保存后能读回，文件名安全化", () => {
  const memory = loadMemory("local:default");
  memory.profile.push({ id: "p1", text: "测试", createdAt: 1, updatedAt: 1, hits: 0 });
  saveMemory("local:default", memory);
  assert.ok(fs.existsSync(memoryPath("local:default")));
  assert.ok(!path.basename(memoryPath("local:default")).includes(":"));
  assert.equal(loadMemory("local:default").profile[0].text, "测试");
});

await test("applyNewFacts 去重并尊重上限", () => {
  let memory = { profile: [], episodes: [] };
  memory = applyNewFacts(memory, ["喜欢简约风", "喜欢简约风", "在国企工作"], 50);
  assert.equal(memory.profile.length, 2);
  memory = { profile: Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, text: `老${i}`, createdAt: i, updatedAt: i, hits: 0 })), episodes: [] };
  memory = applyNewFacts(memory, ["新事实"], 3);
  assert.equal(memory.profile.length, 3);
  assert.ok(memory.profile.some(f => f.text === "新事实"));
  assert.ok(!memory.profile.some(f => f.text === "老0"));
});

await test("addEpisode 新的在前并尊重上限", () => {
  let memory = { profile: [], episodes: [] };
  memory = addEpisode(memory, "事件A", ["t"], 2);
  memory = addEpisode(memory, "事件B", [], 2);
  memory = addEpisode(memory, "事件C", [], 2);
  assert.equal(memory.episodes.length, 2);
  assert.equal(memory.episodes[0].summary, "事件C");
  assert.ok(!memory.episodes.some(e => e.summary === "事件A"));
});

await test("touchProfile 增加 hits", () => {
  const memory = touchProfile({ profile: [{ id: "p1", text: "x", createdAt: 1, updatedAt: 1, hits: 0 }], episodes: [] }, ["p1", "nope"]);
  assert.equal(memory.profile[0].hits, 1);
});
