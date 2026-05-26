// 场景 02：多轮对话记忆 — 上下文保持、历史截断
import { HISTORY_MAX_TURNS } from "../lib/constants.js";

const USER = "local:default";

export default {
  name: "02 多轮对话记忆",
  description: "测试 bot 记住上下文、历史截断行为",

  tests: [
    {
      name: "bot 能记住前一轮的信息",
      async run(client, assert) {
        // 第一轮：告诉 bot 信息，让它回复时确认
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c1 = await client.getOutbox();
        const s1 = c1.next_seq - 1;

        await client.sendText(USER, "请记住：我的名字是小明。请回复'记住了，你叫小明'来确认。");
        await client.pollOutbox(s1, 30000);

        // 第二轮：询问
        const c2 = await client.getOutbox();
        const s2 = c2.next_seq - 1;

        await client.sendText(USER, "我刚才说我叫什么名字？请直接回答名字。");
        const out = await client.pollOutbox(s2, 30000);
        const msgs = out.events.filter(e => e.kind === "message");
        assert(msgs.length > 0, "应至少有一条回复");
        const reply = msgs.map(m => m.text).join(" ");
        assert(
          reply.includes("小明") || reply.includes("Ming"),
          `期望回复提及"小明"，实际回复: ${reply.slice(0, 200)}`
        );
      },
    },

    {
      name: "对话历史不超过设定的最大轮数",
      async run(client, assert) {
        // 先触发欢迎
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        // 发送 HISTORY_MAX_TURNS + 2 轮对话
        for (let i = 0; i < HISTORY_MAX_TURNS + 2; i++) {
          const c = await client.getOutbox();
          const s = c.next_seq - 1;
          await client.sendText(USER, `msg${i + 1}`);
          await client.pollOutbox(s, 15000);
        }

        const state = await client.getState(USER);
        assert.exists(state.conversation_history, "应有对话历史");
        const msgCount = state.conversation_history?.message_count || 0;
        const maxMessages = HISTORY_MAX_TURNS * 2;
        assert(msgCount <= maxMessages + 4,
          `消息数 ${msgCount} 不应大幅超过上限 ${maxMessages}（+4 容差）`);
      },
    },
  ],
};
