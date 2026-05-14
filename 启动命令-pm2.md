# PM2 管理命令速查

## 启动

```bash
cd /opt/weixin-bot-ai

# 启动全部实例
pm2 start ecosystem.config.cjs

# 启动单个实例
pm2 start ecosystem.config.cjs --only weixin-bot-1
pm2 start ecosystem.config.cjs --only weixin-bot-2
```

## 日常

```bash
pm2 list                    # 查看状态
pm2 logs weixin-bot-1       # 实例1 实时日志
pm2 logs weixin-bot-2       # 实例2 实时日志
pm2 restart weixin-bot-1    # 重启实例1（热更新，有 session 时无需扫码）
pm2 restart weixin-bot-2    # 重启实例2
pm2 stop all                # 停止全部
pm2 start all               # 启动全部
pm2 monit                   # 资源监控面板
```

## 日志文件位置

```
实例1: instances/tsja/logs/bot.log
实例2: instances/wife/logs/bot.log
```

## 热更新

登录态自动保存到各实例目录下的 `session.json`。重启时若 session 有效则跳过扫码直接上线（约 2 秒），用户无感知。session 过期则自动走二维码登录。

## 配置修改

- 修改 `config.json` 后 `pm2 restart` 即可生效。
- 修改 `bot.js` 后 `pm2 restart` 即可生效（热更新，无需扫码）。
- 修改 `ecosystem.config.cjs` 后需重新 start 对应实例。
- 新增实例：在 `ecosystem.config.cjs` 添加条目后 `pm2 start ecosystem.config.cjs --only 新实例名`。
