import { spawn } from "child_process";

function runCommand(command, args, options = {}) {
  const runner = options.runner || spawn;
  return new Promise((resolve) => {
    const child = runner(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options.spawnOptions,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      resolve({ ok: false, code: null, stdout, stderr, error });
    });
    child.on("close", code => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function classifyRetryable(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.message || ""}`.toLowerCase();
  return [
    "rate limit",
    "too many requests",
    "429",
    "timeout",
    "network",
    "econnreset",
    "etimedout",
    "temporarily",
  ].some(token => text.includes(token));
}

function parseJson(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function extractRecordId(data) {
  const candidates = [
    data?.record_id,
    data?.record?.record_id,
    data?.data?.record_id,
    data?.data?.record?.record_id,
    data?.records?.[0]?.record_id,
    data?.data?.records?.[0]?.record_id,
    data?.items?.[0]?.record_id,
    data?.data?.items?.[0]?.record_id,
    data?.record_id_list?.[0],
    data?.data?.record_id_list?.[0],
  ];
  return candidates.find(Boolean) || null;
}

async function findExistingRecordId(config, businessRecordId, options = {}) {
  const args = [
    "--profile", config.profile,
    "base", "+record-search",
    "--as", "user",
    "--base-token", config.base_app_token,
    "--table-id", config.table_id,
    "--keyword", businessRecordId,
    "--search-field", "记录ID",
    "--field-id", "记录ID",
    "--limit", "1",
    "--format", "json",
  ];
  const result = await runCommand(options.command || "lark-cli", args, options);
  if (!result.ok) return null;
  return extractRecordId(parseJson(result.stdout));
}

export async function upsertChatRecord(config, record, options = {}) {
  if (!config.profile) throw new Error("缺少 lark-cli profile");
  const existingRecordId = await findExistingRecordId(config, record.recordId, options);
  const args = [
    "--profile", config.profile,
    "base", "+record-upsert",
    "--as", "user",
    "--base-token", config.base_app_token,
    "--table-id", config.table_id,
    "--json", JSON.stringify(record.fields),
    "--format", "json",
  ];
  if (existingRecordId) args.push("--record-id", existingRecordId);
  if (config.dry_run) args.push("--dry-run");

  const result = await runCommand(options.command || "lark-cli", args, options);
  const parsed = parseJson(result.stdout);
  if (!result.ok) {
    const error = new Error(result.stderr.trim() || result.stdout.trim() || result.error?.message || `lark-cli exited ${result.code}`);
    error.retryable = classifyRetryable(result);
    error.result = result;
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr, data: parsed };
}

export async function appendDailyReportDoc(config, markdown, title, options = {}) {
  if (!config.daily_doc_token) return null;
  const args = [
    "--profile", config.profile,
    "docs", "+update",
    "--as", "user",
    "--api-version", "v2",
    "--doc", config.daily_doc_token,
    "--mode", "append",
    "--markdown", markdown,
    "--format", "json",
  ];
  if (title) args.push("--new-title", title);
  const result = await runCommand(options.command || "lark-cli", args, options);
  if (!result.ok) {
    const error = new Error(result.stderr.trim() || result.stdout.trim() || `lark-cli exited ${result.code}`);
    error.retryable = classifyRetryable(result);
    error.result = result;
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr, data: parseJson(result.stdout) };
}
