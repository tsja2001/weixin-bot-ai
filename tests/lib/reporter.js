// 测试报告生成器
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Reporter {
  constructor() {
    this.suites = [];
    this.startTime = Date.now();
  }

  addSuite(name, description) {
    const suite = { name, description, tests: [], startTime: Date.now() };
    this.suites.push(suite);
    return suite;
  }

  addResult(suite, testName, passed, durationMs, error) {
    suite.tests.push({
      name: testName,
      passed,
      duration_ms: durationMs,
      error: error || null,
    });
  }

  summary() {
    const totalDuration = Date.now() - this.startTime;
    let totalTests = 0;
    let passed = 0;
    let failed = 0;

    for (const s of this.suites) {
      for (const t of s.tests) {
        totalTests++;
        if (t.passed) passed++;
        else failed++;
      }
    }

    const lines = [];
    lines.push("=".repeat(60));
    lines.push("  测试报告");
    lines.push("=".repeat(60));
    lines.push(`  时间: ${new Date().toISOString()}`);
    lines.push(`  耗时: ${(totalDuration / 1000).toFixed(1)}s`);
    lines.push(`  测试: ${totalTests} | 通过: ${passed} | 失败: ${failed}`);
    lines.push("=".repeat(60));
    lines.push("");

    for (const s of this.suites) {
      const suitePassed = s.tests.filter(t => t.passed).length;
      const suiteFailed = s.tests.filter(t => !t.passed).length;
      const icon = suiteFailed === 0 ? "✓" : "✗";
      lines.push(`${icon} ${s.name} (${suitePassed}/${s.tests.length})`);
      lines.push(`  ${s.description}`);

      for (const t of s.tests) {
        const status = t.passed ? "✓" : "✗";
        const time = `${t.duration_ms}ms`;
        lines.push(`    ${status} ${t.name} (${time})`);
        if (t.error) {
          lines.push(`      错误: ${t.error}`);
        }
      }
      lines.push("");
    }

    lines.push("=".repeat(60));
    if (failed === 0) {
      lines.push("  全部通过");
    } else {
      lines.push(`  ${failed} 个测试失败`);
    }
    lines.push("=".repeat(60));

    return {
      text: lines.join("\n"),
      json: {
        timestamp: new Date().toISOString(),
        duration_ms: totalDuration,
        total: totalTests,
        passed,
        failed,
        suites: this.suites.map(s => ({
          name: s.name,
          description: s.description,
          tests: s.tests,
        })),
      },
    };
  }

  async writeReport(outputDir) {
    const reportDir = outputDir || path.join(__dirname, "../reports");
    fs.mkdirSync(reportDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const { text, json } = this.summary();

    // 文本报告
    const txtPath = path.join(reportDir, `report-${timestamp}.txt`);
    fs.writeFileSync(txtPath, text, "utf-8");

    // JSON 报告
    const jsonPath = path.join(reportDir, `report-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");

    // 最新符号链接
    const latestTxt = path.join(reportDir, "latest.txt");
    const latestJson = path.join(reportDir, "latest.json");
    try { fs.unlinkSync(latestTxt); } catch {}
    try { fs.unlinkSync(latestJson); } catch {}
    fs.symlinkSync(`report-${timestamp}.txt`, latestTxt);
    fs.symlinkSync(`report-${timestamp}.json`, latestJson);

    return { txtPath, jsonPath };
  }
}
