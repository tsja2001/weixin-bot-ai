// 场景 07：多用户隔离 — 不同 local:xxx 的状态完全独立
const USER_A = "local:user_a";
const USER_B = "local:user_b";

export default {
  name: "07 多用户隔离",
  description: "测试不同 local: 前缀用户的状态完全隔离",

  tests: [
    {
      name: "不同用户的 welcomed 状态独立",
      async run(client, assert) {
        // 用户 A 发消息
        await client.sendText(USER_A, "hi");
        await client.pollOutbox(0, 10000);
        const stateA = await client.getState(USER_A);
        assert(stateA.welcomed, "用户A 应已 welcomed");

        // 用户 B 发消息前，A 的 state 应保留
        assert.exists(stateA.last_contact, "用户A 应有 last_contact");

        // 用户 B 发消息
        await client.sendText(USER_B, "hi");
        await client.pollOutbox(0, 10000);
        const stateB = await client.getState(USER_B);
        assert(stateB.welcomed, "用户B 应已 welcomed");

        // 清理
        await client.reset(USER_A);
        await client.reset(USER_B);
      },
    },

    {
      name: "reset 某个用户不影响另一用户",
      async run(client, assert) {
        // 两个用户都发消息
        await client.sendText(USER_A, "hi");
        await client.pollOutbox(0, 10000);
        await client.sendText(USER_B, "hi");
        await client.pollOutbox(0, 10000);

        // 只 reset 用户 A
        await client.reset(USER_A);

        const stateA = await client.getState(USER_A);
        const stateB = await client.getState(USER_B);

        assert(!stateA.welcomed, "reset 后用户A 不应 welcomed");
        assert(stateB.welcomed, "用户B 应仍 welcomed");

        await client.reset(USER_B);
      },
    },
  ],
};
