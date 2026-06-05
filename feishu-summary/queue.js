import fs from "fs";
import path from "path";

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendLine(filePath, entry) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

export class FeishuSummaryQueue {
  constructor(filePath) {
    this.filePath = filePath;
  }

  enqueue(record) {
    appendLine(this.filePath, { op: "enqueue", status: "pending", recordId: record.recordId, record });
  }

  markSynced(recordId, result = {}) {
    appendLine(this.filePath, { op: "status", status: "synced", recordId, result });
  }

  markFailed(recordId, error) {
    appendLine(this.filePath, {
      op: "status",
      status: "failed",
      recordId,
      error: error?.message || String(error),
      retryable: error?.retryable !== false,
    });
  }

  readLatest() {
    if (!fs.existsSync(this.filePath)) return [];
    const latest = new Map();
    const lines = fs.readFileSync(this.filePath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.recordId) continue;
        const prev = latest.get(entry.recordId) || {};
        if (entry.op === "enqueue") {
          latest.set(entry.recordId, {
            ...prev,
            recordId: entry.recordId,
            record: entry.record,
            status: prev.status || "pending",
            enqueuedAt: entry.ts,
          });
        } else if (entry.op === "status") {
          latest.set(entry.recordId, {
            ...prev,
            recordId: entry.recordId,
            status: entry.status,
            result: entry.result,
            error: entry.error,
            retryable: entry.retryable,
            updatedAt: entry.ts,
          });
        }
      } catch (e) {
        console.log(`[飞书汇总] 队列跳过损坏行: ${e.message}`);
      }
    }
    return [...latest.values()].filter(item => item.record);
  }

  pendingRecords() {
    return this.readLatest()
      .filter(item => item.status === "pending" || (item.status === "failed" && item.retryable !== false))
      .map(item => item.record);
  }

  recordsForDate(date) {
    return this.readLatest()
      .filter(item => item.record?.fields?.["日期"] === date)
      .map(item => ({ ...item, fields: item.record.fields }));
  }
}
