// 测试入口 — 启动 bot，加载所有场景，顺序执行，生成报告
import { BotProcess } from "./lib/bot-process.js";
import { LocalClient } from "./lib/client.js";
import { Reporter } from "./lib/reporter.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "scenarios");
const PORT = parseInt(process.env.TEST_PORT || "19527", 10);
const DEFAULT_USER = "local:default";

// 加载所有场景文件
async function loadScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith(".js"))
    .sort();
  const scenarios = [];
  for (const f of files) {
    const mod = await import(`./scenarios/${f}`);
    scenarios.push(mod.default || mod);
  }
  return scenarios;
}

async function runTest(client, suite, testCase) {
  const start = Date.now();
  try {
    await testCase.run(client, assert);
    const duration = Date.now() - start;
    suite.reporter.addResult(suite, testCase.name, true, duration);
    process.stdout.write(" ✓");
  } catch (e) {
    const duration = Date.now() - start;
    const msg = e.message || String(e);
    suite.reporter.addResult(suite, testCase.name, false, duration, msg);
    process.stdout.write(` ✗\n     ${msg}`);
  }
}

// 宽松断言工具 — AI 回复不确定，所以不精确匹配
function assert(condition, message) {
  if (!condition) throw new Error(message || "断言失败");
}

assert.includes = (haystack, needle, message) => {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(message || `期望包含 "${needle}" 但未找到`);
  }
};

assert.notEmpty = (value, message) => {
  if (!value || (typeof value === "string" && !value.trim())) {
    throw new Error(message || "期望非空值");
  }
};

assert.ok = (res, message) => {
  if (!res || !res.ok) {
    throw new Error(message || `期望 ok=true，收到: ${JSON.stringify(res)}`);
  }
};

assert.error = (res, message) => {
  if (!res || !res.error) {
    throw new Error(message || `期望有 error 字段，收到: ${JSON.stringify(res)}`);
  }
};

assert.exists = (value, message) => {
  if (value === null || value === undefined) {
    throw new Error(message || "期望值存在但为 null/undefined");
  }
};

// ── 主流程 ──
async function main() {
  const reporter = new Reporter();
  const bot = new BotProcess(PORT);
  const client = new LocalClient(PORT);

  console.log("启动测试 bot...");
  await bot.start();
  console.log(`bot 已启动 (端口 ${PORT})\n`);

  // 验证健康检查
  const hc = await client.health();
  if (!hc.ok) {
    console.error("bot 健康检查失败");
    await bot.stop();
    process.exit(1);
  }

  const scenarios = await loadScenarios();
  console.log(`加载了 ${scenarios.length} 个测试场景\n`);

  for (const scenario of scenarios) {
    const suite = reporter.addSuite(scenario.name, scenario.description);
    suite.reporter = reporter;
    console.log(`\n${scenario.name}`);
    console.log(`  ${scenario.description}`);

    for (const testCase of scenario.tests) {
      process.stdout.write(`    ${testCase.name}...`);
      // 每个测试前重置状态，确保独立
      await client.reset(DEFAULT_USER);
      // 稍微等 reset 生效
      await new Promise(r => setTimeout(r, 500));
      await runTest(client, suite, testCase);
    }
    console.log("");
  }

  console.log("\n停止 bot...");
  await bot.stop();

  const { text, json } = reporter.summary();
  console.log("\n" + text);

  // 写入报告文件
  const reportDir = path.join(__dirname, "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(reportDir, `report-${ts}.txt`), text);
  fs.writeFileSync(path.join(reportDir, `report-${ts}.json`), JSON.stringify(json, null, 2));
  // 最新
  try { fs.unlinkSync(path.join(reportDir, "latest.txt")); } catch {}
  try { fs.unlinkSync(path.join(reportDir, "latest.json")); } catch {}
  fs.writeFileSync(path.join(reportDir, "latest.txt"), text);
  fs.writeFileSync(path.join(reportDir, "latest.json"), JSON.stringify(json, null, 2));

  console.log(`\n报告已保存到 ${reportDir}/`);

  // 退出码
  process.exit(json.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("测试运行失败:", e);
  process.exit(2);
});
