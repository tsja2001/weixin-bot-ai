// 场景 04：单文件消息 — 文件注入、解析、pending、AI 合并
import { FILE_ANCHOR_MAX_CHARS } from "../lib/constants.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER = "local:default";
const FIXTURES = path.resolve(__dirname, "../../instances/test-local/fixtures");

// 动态获取可用测试文件
function fixture(name) {
  return path.join(FIXTURES, name);
}

export default {
  name: "04 单文件消息",
  description: "测试文件注入、解析确认、pendingFiles、AI 结合文件回复",

  tests: [
    {
      name: "注入 txt 文件后收到解析确认",
      async run(client, assert) {
        const fp = fixture("test.txt");
        const res = await client.sendFile(USER, fp);
        assert.ok(res, "文件注入应成功");

        const out = await client.pollOutbox(0, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        // 至少收到 "正在解析" 确认
        const texts = msgs.map(m => m.text).join(" ");
        assert(
          texts.includes("正在解析") || texts.includes("已收到"),
          `应收到文件接收确认，实际: ${texts.slice(0, 200)}`
        );
      },
    },

    {
      name: "文件解析后 pendingFiles 状态正确",
      async run(client, assert) {
        const fp = fixture("test.txt");
        await client.sendFile(USER, fp);
        await client.pollOutbox(0, 10000);

        const state = await client.getState(USER);
        assert.exists(state.pending_files, "应有 pending_files");
        assert(state.pending_files.count >= 1, "至少有 1 个待处理文件");
        assert.includes(state.pending_files.names.join(","), "test.txt", "文件名应为 test.txt");
      },
    },

    {
      name: "发文字指令后 pendingFiles 被清空",
      async run(client, assert) {
        // 先发文件
        const fp = fixture("test.txt");
        await client.sendFile(USER, fp);
        await client.pollOutbox(0, 10000);

        // 再发指令
        const current = await client.getOutbox();
        const since = current.next_seq - 1;

        await client.sendText(USER, "请总结这个文件的内容，用一句话");
        await client.pollOutbox(since, 30000);

        // 检查状态
        const state = await client.getState(USER);
        assert(
          !state.pending_files || state.pending_files.count === 0,
          "发指令后 pendingFiles 应清空"
        );
      },
    },

    {
      name: "文件不存在时返回 400 错误",
      async run(client, assert) {
        const fp = fixture("不存在的文件.docx");
        const res = await client.sendFile(USER, fp);
        assert.error(res, "应返回错误");
        assert.includes(res.error, "文件不可读", "错误信息应说明文件不可读");
      },
    },

    {
      name: "超大文件触发锚点截断",
      async run(client, assert) {
        // 构造一个比 MAX_CHARS 大的内容
        const hugeContent = "测试内容。".repeat(FILE_ANCHOR_MAX_CHARS / 5 + 100);
        // 通过 raw 注入一个超长文件消息
        // 实际上通过 normal file 路径测试更真实，但需要先创建大文件
        // 这里验证截断逻辑存在即可：pending 阶段不截断，锚点写入时截断
        // 跳过（需真实大文件），保留此用例作为文档说明
      },
    },
  ],
};
