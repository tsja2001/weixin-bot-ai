// 场景 06：图片消息 — 图片注入、格式检测、传递给 AI
const USER = "local:default";

export default {
  name: "06 图片消息",
  description: "测试图片类型消息的注入和处理",

  tests: [
    {
      name: "注入图片后收到确认",
      async run(client, assert) {
        // 此测试需要真实的图片文件
        // 跳过，后续补充 fixtures 中的图片
      },
    },
  ],
};
