import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMP_DIR = path.join(APP_DIR, "temp");
const OUTPUT_DIR = path.join(APP_DIR, "benchmarks", "ocr");
const PDFJS_WASM_URL = pathToFileURL(path.join(APP_DIR, "node_modules/pdfjs-dist/wasm")).href + "/";

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || "http://127.0.0.1:8765";
const PDF_TEXT_MIN_CHARS = parseNumberEnv("PDF_TEXT_MIN_CHARS", 200);
const PDF_OCR_RENDER_SCALE = parseNumberEnv("PDF_OCR_RENDER_SCALE", 1.35);
const PDF_OCR_PAGE_CONCURRENCY = parseIntRangeEnv("PDF_OCR_PAGE_CONCURRENCY", 1, 1, 2);

const args = parseArgs(process.argv.slice(2));
const mode = args.mode || "auto";
const label = args.label || mode;
const runs = Number.parseInt(args.runs || "1", 10);
const warmups = Number.parseInt(args.warmups || "0", 10);

if (!["auto", "force-ocr", "text-only"].includes(mode)) {
  throw new Error("--mode 只支持 auto/force-ocr/text-only");
}

if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs 必须是正整数");
if (!Number.isInteger(warmups) || warmups < 0) throw new Error("--warmups 必须是非负整数");

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "1";
    } else {
      result[key] = next;
      i++;
    }
  }
  return result;
}

function parseNumberEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
  return value;
}

function parseIntRangeEnv(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function nowRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
    "-",
    label,
  ].join("");
}

function getGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: APP_DIR, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function normalizePdfText(text) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function loadPdf(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return pdfjsLib.getDocument({ data, wasmUrl: PDFJS_WASM_URL, useWasm: false }).promise;
}

async function extractPdfText(doc) {
  const startedAt = performance.now();
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = normalizePdfText(content.items.map(item => item.str).join(" "));
    pages.push({ page: i, text, chars: text.length });
  }
  const fullText = normalizePdfText(
    pages
      .filter(page => page.text)
      .map(page => `## 第 ${page.page} 页\n\n${page.text}`)
      .join("\n\n")
  );
  return { pages, text: fullText, chars: fullText.length, elapsedMs: Math.round(performance.now() - startedAt) };
}

async function renderPdfPage(page, scale) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function callOcrImage(buffer, pageNo) {
  const formData = new FormData();
  formData.append("file", new Blob([buffer]), `page_${pageNo}.png`);

  const startedAt = performance.now();
  const response = await fetch(`${OCR_SERVICE_URL}/ocr/image`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(120000),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OCR HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return {
    page: pageNo,
    text: data.text || "",
    lines: data.lines || [],
    elapsedMs,
    serviceElapsedMs: data.elapsedMs ?? null,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

async function getOcrHealth() {
  try {
    const startedAt = performance.now();
    const response = await fetch(`${OCR_SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    return { ok: response.ok, elapsedMs: Math.round(performance.now() - startedAt), data };
  } catch (error) {
    return { ok: false, elapsedMs: null, error: error.message };
  }
}

async function benchmarkFile(filePath, runId, runIndex, isWarmup) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const startedAt = performance.now();
  let doc;
  let textLayer;
  const pageRows = [];
  let selectedMode = "unknown";
  let error = null;
  let renderTotalMs = 0;
  let ocrTotalMs = 0;
  let ocrChars = 0;

  try {
    doc = await loadPdf(fileBuffer);
    textLayer = await extractPdfText(doc);

    if (mode === "text-only") {
      selectedMode = "pdf_text";
    } else if (mode === "auto" && doc.numPages <= 3) {
      selectedMode = "image";
    } else if (mode === "auto" && textLayer.chars >= PDF_TEXT_MIN_CHARS) {
      selectedMode = "pdf_text";
    } else {
      selectedMode = "ocr";
      const pages = await mapWithConcurrency(
        Array.from({ length: doc.numPages }, (_, index) => index + 1),
        PDF_OCR_PAGE_CONCURRENCY,
        async (pageNo) => {
          const page = await doc.getPage(pageNo);
          const renderStartedAt = performance.now();
          const imageBuffer = await renderPdfPage(page, PDF_OCR_RENDER_SCALE);
          const renderMs = Math.round(performance.now() - renderStartedAt);
          const ocr = await callOcrImage(imageBuffer, pageNo);
          return {
            page: pageNo,
            renderMs,
            ocrMs: ocr.elapsedMs,
            serviceOcrMs: ocr.serviceElapsedMs,
            imageBytes: imageBuffer.length,
            chars: ocr.text.length,
            lines: ocr.lines.length,
            error: null,
          };
        }
      );

      for (const page of pages) {
        renderTotalMs += page.renderMs;
        ocrTotalMs += page.ocrMs;
        ocrChars += page.chars;
        pageRows.push(page);
      }
    }
  } catch (caught) {
    error = caught.message;
  }

  const totalMs = Math.round(performance.now() - startedAt);
  const base = {
    runId,
    runIndex,
    warmup: isWarmup,
    fileName,
    fileBytes: fileBuffer.length,
    pageCount: doc?.numPages ?? null,
    mode: selectedMode,
    requestedMode: mode,
    textLayerChars: textLayer?.chars ?? null,
    triggeredOcr: selectedMode === "ocr",
    renderScale: PDF_OCR_RENDER_SCALE,
    pageConcurrency: PDF_OCR_PAGE_CONCURRENCY,
    totalMs,
    textLayerMs: textLayer?.elapsedMs ?? null,
    renderTotalMs,
    ocrTotalMs,
    ocrChars,
    error,
  };

  return {
    fileRow: { recordType: "file", ...base },
    pageRows: pageRows.map(page => ({ recordType: "page", ...base, ...page })),
  };
}

function listPdfFiles() {
  if (args.files) {
    return args.files.split(",").map(file => path.resolve(APP_DIR, file.trim()));
  }
  return fs.readdirSync(TEMP_DIR)
    .filter(name => name.toLowerCase().endsWith(".pdf"))
    .sort()
    .map(name => path.join(TEMP_DIR, name));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

function summarize(fileRows, pageRows, runMeta) {
  const effective = fileRows.filter(row => !row.warmup);
  const byFile = new Map();
  for (const row of effective) {
    if (!byFile.has(row.fileName)) byFile.set(row.fileName, []);
    byFile.get(row.fileName).push(row);
  }

  const lines = [];
  lines.push(`# OCR Benchmark ${runMeta.runId}`);
  lines.push("");
  lines.push("## 配置快照");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(runMeta, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## 按文件汇总");
  lines.push("");
  lines.push("| 文件 | 模式 | 页数 | OCR | 文本层字数 | OCR字数 | 平均ms | 中位ms | 最快ms | 最慢ms | 错误 |");
  lines.push("| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");

  for (const [fileName, rows] of byFile) {
    const totals = rows.map(row => row.totalMs);
    const first = rows[0];
    const avg = Math.round(totals.reduce((sum, value) => sum + value, 0) / totals.length);
    lines.push([
      fileName,
      first.mode,
      first.pageCount ?? "",
      first.triggeredOcr ? "yes" : "no",
      first.textLayerChars ?? "",
      Math.round(rows.reduce((sum, row) => sum + row.ocrChars, 0) / rows.length),
      avg,
      percentile(totals, 0.5),
      Math.min(...totals),
      Math.max(...totals),
      rows.map(row => row.error).filter(Boolean).join("; "),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  const effectivePages = pageRows.filter(row => !row.warmup);
  lines.push("");
  lines.push("## 按页最慢 Top 10");
  lines.push("");
  lines.push("| 文件 | 页 | 渲染ms | OCRms | PNG KB | 字数 | 错误 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const row of [...effectivePages].sort((a, b) => (b.ocrMs || 0) - (a.ocrMs || 0)).slice(0, 10)) {
    lines.push(`| ${row.fileName} | ${row.page} | ${row.renderMs} | ${row.ocrMs} | ${(row.imageBytes / 1024).toFixed(1)} | ${row.chars} | ${row.error || ""} |`);
  }

  lines.push("");
  lines.push("## OCR 字数异常页");
  lines.push("");
  const abnormal = effectivePages.filter(row => row.error || row.chars === 0);
  if (abnormal.length === 0) {
    lines.push("无。");
  } else {
    lines.push("| 文件 | 页 | 字数 | 错误 |");
    lines.push("| --- | ---: | ---: | --- |");
    for (const row of abnormal) {
      lines.push(`| ${row.fileName} | ${row.page} | ${row.chars} | ${row.error || ""} |`);
    }
  }

  lines.push("");
  lines.push("## 错误列表");
  lines.push("");
  const errors = effective.filter(row => row.error);
  if (errors.length === 0) {
    lines.push("无。");
  } else {
    for (const row of errors) lines.push(`- ${row.fileName}: ${row.error}`);
  }

  return lines.join("\n");
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const runId = nowRunId();
const jsonlPath = path.join(OUTPUT_DIR, `${runId}.jsonl`);
const summaryPath = path.join(OUTPUT_DIR, `${runId}-summary.md`);
const files = listPdfFiles();
const health = await getOcrHealth();
const runMeta = {
  recordType: "run",
  runId,
  mode,
  label,
  startedAt: new Date().toISOString(),
  fileCount: files.length,
  runs,
  warmups,
  ocrServiceUrl: OCR_SERVICE_URL,
  pdfTextMinChars: PDF_TEXT_MIN_CHARS,
  renderScale: PDF_OCR_RENDER_SCALE,
  pageConcurrency: PDF_OCR_PAGE_CONCURRENCY,
  cpuModel: os.cpus()[0]?.model || "unknown",
  cpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
  gitCommit: getGitCommit(),
  ocrService: health,
};

fs.appendFileSync(jsonlPath, JSON.stringify(runMeta) + "\n");

const fileRows = [];
const pageRows = [];
for (let runIndex = 0; runIndex < warmups + runs; runIndex++) {
  const isWarmup = runIndex < warmups;
  for (const filePath of files) {
    console.log(`[${runId}] ${isWarmup ? "warmup" : "run"} ${runIndex + 1}/${warmups + runs}: ${path.basename(filePath)}`);
    const result = await benchmarkFile(filePath, runId, runIndex + 1, isWarmup);
    fileRows.push(result.fileRow);
    pageRows.push(...result.pageRows);
    fs.appendFileSync(jsonlPath, JSON.stringify(result.fileRow) + "\n");
    for (const row of result.pageRows) fs.appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
  }
}

fs.writeFileSync(summaryPath, summarize(fileRows, pageRows, runMeta), "utf-8");
console.log(`JSONL: ${jsonlPath}`);
console.log(`Summary: ${summaryPath}`);
