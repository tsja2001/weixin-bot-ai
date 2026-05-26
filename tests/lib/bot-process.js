// 启动/停止本地测试 bot 进程
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const INSTANCE_DIR = path.join(PROJECT_ROOT, "instances/test-local");
const BOT_SCRIPT = path.join(PROJECT_ROOT, "bot.js");

export class BotProcess {
  constructor(port) {
    this.port = port;
    this.process = null;
    this.ready = false;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.process = spawn("node", [BOT_SCRIPT], {
        cwd: INSTANCE_DIR,
        env: { ...process.env, LOCAL_TEST_PORT: String(this.port) },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let started = false;
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error(`bot 启动超时 (端口 ${this.port})`));
        }
      }, 30000);

      const onData = (data) => {
        const text = data.toString();
        if (!started && text.includes("HTTP 服务已启动")) {
          started = true;
          this.ready = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      this.process.stdout.on("data", onData);
      this.process.stderr.on("data", onData);

      this.process.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.process.on("exit", (code) => {
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(`bot 进程退出 (code=${code})`));
        }
      });
    });
  }

  async stop() {
    if (this.process) {
      this.process.kill("SIGTERM");
      // Give it a moment, then force kill
      await sleep(2000);
      try { this.process.kill("SIGKILL"); } catch {}
      this.ready = false;
    }
  }
}
