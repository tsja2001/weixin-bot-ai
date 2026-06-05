import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

import { normalizeFeishuSummaryConfig } from "../../feishu-summary/config.js";
import { buildChatTurnRecord, FIELD_ORDER } from "../../feishu-summary/formatter.js";
import { sanitizeSummary, generateSummary } from "../../feishu-summary/summarizer.js";
import { FeishuSummaryQueue } from "../../feishu-summary/queue.js";
import { upsertChatRecord } from "../../feishu-summary/lark-cli.js";

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch(error => {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

function fakeRunner(calls, responses) {
  return (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const response = responses.shift() || { code: 0, stdout: "{}" };
    queueMicrotask(() => {
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", response.code);
    });
    return child;
  };
}

await test("配置缺失时禁用且不抛异常", () => {
  const cfg = normalizeFeishuSummaryConfig({}, { cwd: "/tmp" });
  assert.equal(cfg.enabled, false);
});

await test("完整配置会标准化队列路径", () => {
  const cfg = normalizeFeishuSummaryConfig({
    feishu_summary: {
      enabled: true,
      profile: "cli_test",
      chatbox_folder_token: "fld_x",
      base_app_token: "base_x",
      table_id: "tbl_x",
    },
  }, { cwd: "/work/instance" });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.summary_model, "deepseek-v4-flash");
  assert.equal(cfg.queue_file, "/work/instance/logs/feishu_summary_queue.jsonl");
});

await test("字段格式化保持前四列顺序并计算 token", () => {
  const record = buildChatTurnRecord({
    instanceName: "tsja",
    fromId: "wx_1",
    messageId: "msg_1",
    timestamp: new Date("2026-06-05T10:30:00+08:00"),
    userContent: "帮我总结",
    aiReply: "好的",
    usage: { input_tokens: 11, output_tokens: 7 },
    summary: "工作总结",
    summaryModel: "deepseek-v4-flash",
    model: "claude-opus",
  });
  assert.deepEqual(Object.keys(record.fields).slice(0, 4), FIELD_ORDER.slice(0, 4));
  assert.equal(record.fields["总Token"], 18);
  assert.equal(record.fields["记录ID"], "tsja:msg_1");
});

await test("摘要清洗去掉前缀、引号并截断", () => {
  assert.equal(sanitizeSummary("摘要：“这是一个很长很长的摘要标题”", 8), "这是一个很长很长");
});

await test("摘要生成失败时使用本地兜底", async () => {
  const summary = await generateSummary(
    { userContent: "请根据文件提炼三个重点" },
    { maxChars: 6, callAI: async () => { throw new Error("boom"); } },
  );
  assert.equal(summary, "请根据文件提");
});

await test("队列保留 pending/failed 并忽略已同步", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-summary-"));
  const queue = new FeishuSummaryQueue(path.join(dir, "queue.jsonl"));
  queue.enqueue({ recordId: "r1", fields: { "日期": "2026-06-05" } });
  queue.enqueue({ recordId: "r2", fields: { "日期": "2026-06-05" } });
  queue.markSynced("r1", {});
  queue.markFailed("r2", new Error("network"));
  assert.deepEqual(queue.pendingRecords().map(r => r.recordId), ["r2"]);
  assert.equal(queue.recordsForDate("2026-06-05").length, 2);
});

await test("lark-cli 写入显式使用 profile 并按记录ID查重", async () => {
  const calls = [];
  const runner = fakeRunner(calls, [
    { code: 0, stdout: JSON.stringify({ data: { record_id_list: ["rec_old"] } }) },
    { code: 0, stdout: JSON.stringify({ data: { record_id: "rec_old" } }) },
  ]);
  await upsertChatRecord({
    profile: "cli_test",
    base_app_token: "base_x",
    table_id: "tbl_x",
  }, {
    recordId: "tsja:msg_1",
    fields: { "记录ID": "tsja:msg_1", "摘要": "测试" },
  }, { runner });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["--profile", "cli_test"]);
  assert.deepEqual(calls[1].slice(0, 2), ["--profile", "cli_test"]);
  assert(calls[1].includes("--record-id"));
  assert(calls[1].includes("rec_old"));
});
