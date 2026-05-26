// 场景 01：纯文本对话 — 基本发送/接收、欢迎消息
const USER = "local:default";

export default {
  name: "01 纯文本对话",
  description: "测试文本消息发送、outbox 接收、欢迎消息",

  tests: [
    {
      name: "首次消息收到欢迎提示",
      async run(client, assert) {
        const res = await client.sendText(USER, "你好");
        assert.ok(res);

        const out = await client.pollOutbox(0, 10000);
        const msgs = out.events.filter(e => e.kind === "message");
        assert(msgs.length > 0, "应至少有一条回复消息");
        assert.includes(msgs[0].text, "连接成功", "欢迎消息应包含 '连接成功'");
        assert.includes(msgs[0].text, "/help", "欢迎消息应包含指令列表");
      },
    },

    {
      name: "第二次消息不再发欢迎提示",
      async run(client, assert) {
        // 先触发欢迎
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        // 记录当前 seq 位置
        const current = await client.getOutbox();
        let since = current.next_seq - 1;

        // 第二次消息应该走 AI 路径
        const res = await client.sendText(USER, "请回复'OK'这两个字，不要多说");
        assert.ok(res);

        // 轮询直到收到 message 事件（可能先收到 typing 事件）
        let msgs = [];
        for (let i = 0; i < 6; i++) {
          const out = await client.pollOutbox(since, 10000);
          msgs = out.events.filter(e => e.kind === "message");
          if (msgs.length > 0) break;
          since = out.next_seq - 1;
        }
        assert(msgs.length > 0, "应至少有一条回复");
        // 第二次不应再发欢迎消息
        const hasWelcome = msgs.some(m => m.text && m.text.includes("连接成功"));
        assert(!hasWelcome, "第二次消息不应再触发欢迎提示");
      },
    },

    {
      name: "发送消息后 outbox 收到事件",
      async run(client, assert) {
        // 先触发欢迎
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const current = await client.getOutbox();
        let since = current.next_seq - 1;

        await client.sendText(USER, "测试");

        // 轮询直到收到事件
        let allEvents = [];
        for (let i = 0; i < 6; i++) {
          const out = await client.pollOutbox(since, 10000);
          allEvents = out.events;
          if (allEvents.length > 0) break;
          since = out.next_seq - 1;
        }
        assert(allEvents.length > 0, "应至少收到一个事件");
      },
    },
  ],
};
