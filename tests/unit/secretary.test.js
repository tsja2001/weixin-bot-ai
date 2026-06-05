import assert from "assert";
import { selectContext } from "../../secretary.js";

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

const memory = {
  profile: [{ id: "p1", text: "喜欢简洁" }],
  episodes: [{ id: "e1", summary: "聊过项目" }],
};
const files = [{ id: "f1", fileName: "a.txt", content: "项目内容" }];

await test("selectContext 使用 DeepSeek 选择结果", async () => {
  const result = await selectContext({
    userId: "u",
    userContent: "总结项目",
    memory,
    files,
    config: {},
    callJSON: async () => ({ json: { profileIds: ["p1"], episodeIds: [], fileIds: ["f1"], reason: "match" }, usage: { input_tokens: 1 } }),
    onLog: () => {},
  });
  assert.deepEqual(result.fileIds, ["f1"]);
  assert.equal(result.fallback, false);
});

await test("selectContext 失败时降级为全部文件和近期事件", async () => {
  const result = await selectContext({
    userId: "u",
    userContent: "x",
    memory,
    files,
    config: {},
    callJSON: async () => { throw new Error("timeout"); },
    onLog: () => {},
  });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.fileIds, ["f1"]);
  assert.deepEqual(result.episodeIds, ["e1"]);
});
