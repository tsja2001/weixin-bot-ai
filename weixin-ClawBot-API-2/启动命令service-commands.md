# 服务管理命令

## 查看状态
launchctl list | grep clawbot

## 停止服务
launchctl unload ~/Library/LaunchAgents/com.weixin.clawbot-api.plist
launchctl unload ~/Library/LaunchAgents/com.weixin.clawbot-api-2.plist

## 启动服务
launchctl load ~/Library/LaunchAgents/com.weixin.clawbot-api.plist
launchctl load ~/Library/LaunchAgents/com.weixin.clawbot-api-2.plist

## 重启一号
launchctl unload ~/Library/LaunchAgents/com.weixin.clawbot-api.plist && \
launchctl load ~/Library/LaunchAgents/com.weixin.clawbot-api.plist

## 重启二号
launchctl unload ~/Library/LaunchAgents/com.weixin.clawbot-api-2.plist && \
launchctl load ~/Library/LaunchAgents/com.weixin.clawbot-api-2.plist

## 查看实时日志
tail -f logs/bot.log                        # 一号
tail -f ../weixin-ClawBot-API-2/logs/bot.log  # 二号

## 查看错误日志
tail -f logs/bot-error.log                        # 一号
tail -f ../weixin-ClawBot-API-2/logs/bot-error.log  # 二号
