# PM2 管理命令速查

## 启动

```bash
cd /opt/weixin-bot-ai
pm2 start ecosystem.config.js
```

## 日常

```bash
pm2 list                    # 查看状态
pm2 logs weixin-bot-1       # 实例1 实时日志
pm2 logs weixin-bot-2       # 实例2 实时日志
pm2 restart weixin-bot-1    # 重启实例1
pm2 restart weixin-bot-2    # 重启实例2
pm2 stop all                # 停止全部
pm2 start all               # 启动全部
pm2 monit                   # 资源监控面板
```

## 日志文件位置

```
实例1: weixin-ClawBot-API/logs/bot.log
实例2: weixin-ClawBot-API-2/logs/bot.log
```

## 配置修改

修改 `config.json` 后重启对应实例即可生效。
修改 `ecosystem.config.js` 后需 `pm2 delete all && pm2 start ecosystem.config.js && pm2 save`。
