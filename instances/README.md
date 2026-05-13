# 实例配置目录

每个子目录对应一个微信 Bot 实例，只需包含：

- `config.json` — AI 接口配置（api_key/base_url/model/prompt/scheduled_tasks）
- `logs/` — 运行时自动创建

## 新增实例

```bash
mkdir instances/新用户名
cp instances/tsja/config.json instances/新用户名/config.json
# 编辑 instances/新用户名/config.json 修改配置
pm2 start ecosystem.config.js --only weixin-bot-N  # 在 ecosystem.config.js 中添加对应 app
```
