import assert from "assert";
import { ageFileAnchors, buildFileAnchors, selectFilesByIds, upsertFileAnchors } from "../../file-context.js";

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

await test("buildFileAnchors 生成稳定 id 并截断内容", () => {
  const anchors = buildFileAnchors([{ fileName: "a.txt", text: "x".repeat(60000) }]);
  assert.equal(anchors.length, 1);
  assert.ok(anchors[0].id.startsWith("f_"));
  assert.ok(anchors[0].content.length <= 50000);
});

await test("upsertFileAnchors 按 id 覆盖", () => {
  const first = buildFileAnchors([{ fileName: "a.txt", text: "abc" }]);
  const second = upsertFileAnchors(first, [{ fileName: "a.txt", text: "abc" }]);
  assert.equal(second.length, 1);
});

await test("selectFilesByIds 和 idle 淘汰", () => {
  const files = [{ id: "f1", fileName: "1", content: "a", idleTurns: 0 }, { id: "f2", fileName: "2", content: "b", idleTurns: 5 }];
  assert.deepEqual(selectFilesByIds(files, ["f1"]).map(f => f.id), ["f1"]);
  const aged = ageFileAnchors(files, ["f1"], 6);
  assert.deepEqual(aged.map(f => f.id), ["f1"]);
  assert.equal(aged[0].idleTurns, 0);
});
