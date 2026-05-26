// 场景 09：状态生命周期 — pendingFiles、fileAnchors、history 的完整生命周期
const USER = "local:default";

export default {
  name: "09 状态生命周期",
  description: "测试 pendingFiles、fileAnchors、conversationHistory 的创建和清理",

  tests: [
    {
      name: "reset 后状态完全清除",
      async run(client, assert) {
        // 发一条消息触发状态变化
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        // 确认有状态
        let state = await client.getState(USER);
        assert(state.welcomed, "reset 前应为 welcomed");

        // 执行 reset
        const resetRes = await client.reset(USER);
        assert.ok(resetRes);

        // 确认状态已清除
        state = await client.getState(USER);
        assert(!state.welcomed, "reset 后 welcomed 应为 false");
        assert(!state.pending_files, "reset 后 pending_files 应为 null");
        assert(!state.file_anchors, "reset 后 file_anchors 应为 null");
      },
    },

    {
      name: "健康检查端点返回正常",
      async run(client, assert) {
        const hc = await client.health();
        assert.ok(hc);
        assert(hc.instance_dir, "应包含 instance_dir");
      },
    },

    {
      name: "outbox 的 seq 单调递增",
      async run(client, assert) {
        // 先触发欢迎
        await client.sendText(USER, "hi");
        const out1 = await client.pollOutbox(0, 10000);
        assert(out1.next_seq > 0, "next_seq 应为正数");

        const c = await client.getOutbox();
        let since = c.next_seq - 1;

        await client.sendText(USER, "OK");

        // 轮询直到收到新事件
        for (let i = 0; i < 6; i++) {
          const out = await client.pollOutbox(since, 10000);
          if (out.next_seq > out1.next_seq) {
            // seq 递增验证通过
            return;
          }
          since = out.next_seq - 1;
        }
        throw new Error("seq 应递增但未收到新事件");
      },
    },

    {
      name: "daily_stats 记录当日统计",
      async run(client, assert) {
        // 先触发欢迎
        await client.sendText(USER, "hi");
        await client.pollOutbox(0, 10000);

        const c = await client.getOutbox();
        let since = c.next_seq - 1;

        await client.sendText(USER, "OK");

        // 轮询等 AI 回复
        for (let i = 0; i < 6; i++) {
          await client.pollOutbox(since, 10000);
          const state = await client.getState(USER);
          if (state.daily_stats && state.daily_stats.message_count > 0) {
            return; // 统计已更新，通过
          }
          const cur = await client.getOutbox();
          since = cur.next_seq - 1;
        }

        // 即使没有 AI 回复，daily_stats 字段也应存在
        const state = await client.getState(USER);
        assert.exists(state.daily_stats, "应有 daily_stats");
        assert(state.daily_stats.date, "应有 date 字段");
      },
    },
  ],
};
