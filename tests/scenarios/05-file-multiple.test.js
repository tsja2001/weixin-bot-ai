// 场景 05：多文件合并 — 多个文件暂存后一起传给 AI
const USER = "local:default";

export default {
  name: "05 多文件合并",
  description: "测试连续上传多个文件后合并传递给 AI",

  tests: [
    {
      name: "连续上传两个文件后 pendingFiles 累加",
      async run(client, assert) {
        // 第一个文件 (需要 fixtures 里有文件)
        // 此测试依赖 fixtures 中的实际文件
        // 跳过，后续补充
      },
    },
  ],
};
