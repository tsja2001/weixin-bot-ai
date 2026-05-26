// 场景 03：指令处理 — /help, /time, /清空文件, /重新连接
const USER = "local:default";

export default {
  name: "03 指令处理",
  description: "测试所有 bot 指令的识别和响应",

  tests: [
    {
      name: "/help 返回指令列表",
      async run(client, assert) {
        // 先触发欢迎，避免 /help 被欢迎逻辑拦截
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c = await client.getOutbox();
        const since = c.next_seq - 1;

        const res = await client.sendText(USER, "/help");
        assert.ok(res);

        const out = await client.pollOutbox(since, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        assert(msgs.length > 0, "应有一条回复");
        assert.includes(msgs[0].text, "可用指令", "/help 应返回指令列表");
        assert.includes(msgs[0].text, "/time", "应包含 /time");
      },
    },

    {
      name: "/指令 别名同样有效",
      async run(client, assert) {
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c = await client.getOutbox();
        const since = c.next_seq - 1;

        await client.sendText(USER, "/指令");
        const out = await client.pollOutbox(since, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        assert.includes(msgs[0].text, "可用指令", "/指令 也应返回指令列表");
      },
    },

    {
      name: "/time 返回剩余时间",
      async run(client, assert) {
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c = await client.getOutbox();
        const since = c.next_seq - 1;

        await client.sendText(USER, "/time");
        const out = await client.pollOutbox(since, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        assert.includes(msgs[0].text, "剩余时间", "/time 应返回剩余时间");
      },
    },

    {
      name: "/清空文件 在没有文件时返回提示",
      async run(client, assert) {
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c = await client.getOutbox();
        const since = c.next_seq - 1;

        await client.sendText(USER, "/清空文件");
        const out = await client.pollOutbox(since, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        assert(
          msgs[0]?.text?.includes("没有文件") || msgs[0]?.text?.includes("文件上下文"),
          "/清空文件 应提示没有文件"
        );
      },
    },

    {
      name: "/重新连接 进入确认流程",
      async run(client, assert) {
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c = await client.getOutbox();
        const since = c.next_seq - 1;

        await client.sendText(USER, "/重新连接");
        const out = await client.pollOutbox(since, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        const text = msgs[0]?.text || "";
        assert(
          text.includes("确认") || text.includes("Y"),
          `/重新连接 应请求确认，实际: ${text.slice(0, 100)}`
        );
      },
    },
  ],
};
