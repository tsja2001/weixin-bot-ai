module.exports = {
  apps: [
    {
      name: "weixin-bot-1",
      cwd: "/opt/weixin-bot-ai/weixin-ClawBot-API",
      script: "bot.js",
      interpreter: "node",
      out_file: "logs/bot.log",
      error_file: "logs/bot-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "weixin-bot-2",
      cwd: "/opt/weixin-bot-ai/weixin-ClawBot-API-2",
      script: "bot.js",
      interpreter: "node",
      out_file: "logs/bot.log",
      error_file: "logs/bot-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
