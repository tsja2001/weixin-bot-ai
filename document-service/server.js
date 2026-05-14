import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import mammoth from "mammoth";

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(SERVICE_DIR);
const PDFJS_WASM_URL = pathToFileURL(path.join(APP_DIR, "node_modules/pdfjs-dist/wasm")).href + "/";

const PORT = Number(process.env.DOCUMENT_SERVICE_PORT || process.env.PORT || 8770);
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || "http://127.0.0.1:8765";
const PDF_TEXT_MIN_CHARS = parseNumberEnv("PDF_TEXT_MIN_CHARS", 200);
const PDF_SHORT_RENDER_SCALE = parseNumberEnv("PDF_SHORT_RENDER_SCALE", 2.0);
const PDF_OCR_RENDER_SCALE = parseNumberEnv("PDF_OCR_RENDER_SCALE", 1.35);
const PDF_OCR_PAGE_CONCURRENCY = parseIntRangeEnv("PDF_OCR_PAGE_CONCURRENCY", 1, 1, 2);

function parseNumberEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.log(`[配置] ${name}=${raw} 无效，使用默认值 ${defaultValue}`);
    return defaultValue;
  }
  return value;
}

function parseIntRangeEnv(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.log(`[配置] ${name}=${raw} 无效，使用默认值 ${defaultValue}`);
    return defaultValue;
  }
  return value;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, details) {
  sendJson(res, status, { ok: false, error: message, details });
}

function readBody(req, maxBytes = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`请求体超过限制 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizePdfText(text) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function callOcrImage(buffer, pageNo) {
  const formData = new FormData();
  formData.append("file", new Blob([buffer]), `page_${pageNo}.png`);

  const startedAt = Date.now();
  const response = await fetch(`${OCR_SERVICE_URL}/ocr/image`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(120000),
  });
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OCR 服务返回 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return { page: pageNo, text: data.text ?? "", lines: data.lines || [], elapsedMs };
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

async function loadPdf(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return pdfjsLib.getDocument({ data, wasmUrl: PDFJS_WASM_URL, useWasm: false }).promise;
}

async function extractPdfText(doc) {
  const pages = [];
  const startedAt = Date.now();
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
  return { pages, fullText, chars: fullText.length, elapsedMs: Date.now() - startedAt };
}

async function renderPdfPageToPng(page, scale) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function parsePdf(buffer) {
  const doc = await loadPdf(buffer);
  const pageCount = doc.numPages;
  console.log(`[PDF] 解析完成: ${pageCount} 页`);

  if (pageCount <= 3) {
    const images = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const pngBuffer = await renderPdfPageToPng(page, PDF_SHORT_RENDER_SCALE);
      images.push({ mediaType: "image/png", base64: pngBuffer.toString("base64") });
      console.log(`[PDF] 第 ${i}/${pageCount} 页渲染完成: ${(pngBuffer.length / 1024).toFixed(1)}KB`);
    }
    return { mode: "image", type: "pdf", pageCount, images };
  }

  const startedAt = Date.now();
  const extractedText = await extractPdfText(doc);
  if (extractedText.fullText.length >= PDF_TEXT_MIN_CHARS) {
    console.log(`[PDF] 文本层提取完成: ${extractedText.fullText.length} 字，跳过 OCR`);
    return {
      mode: "ocr_text",
      type: "pdf",
      pageCount,
      text: extractedText.fullText,
      source: "pdf_text",
      textLayerChars: extractedText.chars,
      textLayerMs: extractedText.elapsedMs,
    };
  }

  if (!OCR_SERVICE_URL) {
    return { mode: "ocr_needed", type: "pdf", pageCount };
  }

  console.log(`[PDF] 开始 OCR: renderScale=${PDF_OCR_RENDER_SCALE}, pageConcurrency=${PDF_OCR_PAGE_CONCURRENCY}`);
  const pages = await mapWithConcurrency(
    Array.from({ length: pageCount }, (_, index) => index + 1),
    PDF_OCR_PAGE_CONCURRENCY,
    async (pageNo) => {
      const page = await doc.getPage(pageNo);
      const pngBuffer = await renderPdfPageToPng(page, PDF_OCR_RENDER_SCALE);
      console.log(`[PDF] 第 ${pageNo}/${pageCount} 页渲染完成: ${(pngBuffer.length / 1024).toFixed(1)}KB，开始 OCR...`);
      const pageResult = await callOcrImage(pngBuffer, pageNo);
      console.log(`[PDF] 第 ${pageNo}/${pageCount} 页 OCR 完成: ${pageResult.text.length} 字`);
      return pageResult;
    }
  );

  const fullText = pages.map(page => `## 第 ${page.page} 页\n\n${page.text}`).join("\n\n");
  console.log(`[PDF] OCR 完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (!fullText.trim()) {
    return { mode: "ocr_text", type: "pdf", pageCount, text: "(未能识别出文字内容)", source: "ocr" };
  }
  return { mode: "ocr_text", type: "pdf", pageCount, text: fullText, source: "ocr" };
}

async function parseOfficeFile(buffer, fileName, ext) {
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    console.log(`[文件] mammoth 提取: ${text.length} 字符`);
    return {
      mode: "text",
      type: "docx",
      text,
      warnings: result.messages.map(message => message.message),
    };
  }

  if (ext === "txt") {
    const text = buffer.toString("utf-8").trim();
    console.log(`[文件] txt 提取: ${text.length} 字符`);
    return { mode: "text", type: "txt", text };
  }

  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const text = wb.SheetNames.map(name => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      return `## Sheet: ${name}\n\n${csv}`;
    }).join("\n\n");
    console.log(`[文件] xlsx 提取: ${text.length} 字符, ${wb.SheetNames.length} sheets`);
    return { mode: "text", type: ext, text, sheets: wb.SheetNames };
  }

  if (ext === "pptx") {
    const tmpPath = path.join(os.tmpdir(), `weixin-doc-${process.pid}-${Date.now()}.pptx`);
    try {
      fs.writeFileSync(tmpPath, buffer);
      const PPTXParser = (await import("node-pptx-parser")).default;
      const parser = new PPTXParser(tmpPath);
      const slides = await parser.extractText();
      const text = slides.map((slide, i) => {
        const slideText = Array.isArray(slide.text) ? slide.text.join("\n") : slide.text;
        return `## Slide ${i + 1}\n\n${slideText}`;
      }).join("\n\n");
      console.log(`[文件] pptx 提取: ${text.length} 字符, ${slides.length} slides`);
      return { mode: "text", type: "pptx", text, slideCount: slides.length };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  return { mode: "unsupported", type: ext, text: null, error: `不支持的文件类型: .${ext}` };
}

async function parseDocument(buffer, fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return parsePdf(buffer);
  return parseOfficeFile(buffer, fileName, ext);
}

async function handleApi(req, res, url) {
  if (url.pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, {
      status: "ok",
      service: "document-service",
      ocrServiceUrl: OCR_SERVICE_URL,
      config: {
        pdfTextMinChars: PDF_TEXT_MIN_CHARS,
        pdfShortRenderScale: PDF_SHORT_RENDER_SCALE,
        pdfOcrRenderScale: PDF_OCR_RENDER_SCALE,
        pdfOcrPageConcurrency: PDF_OCR_PAGE_CONCURRENCY,
      },
    });
  }

  if (url.pathname === "/parse" && req.method === "POST") {
    const startedAt = Date.now();
    const buffer = await readBody(req);
    const fileName = decodeURIComponent(req.headers["x-file-name"] || "document");
    const result = await parseDocument(buffer, fileName);
    return sendJson(res, 200, {
      ok: result.mode !== "unsupported",
      fileName,
      bytes: buffer.length,
      elapsedMs: Date.now() - startedAt,
      ...result,
    });
  }

  return sendError(res, 404, "API 不存在");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    await handleApi(req, res, url);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || "服务器错误", error.stack);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Document Service: http://127.0.0.1:${PORT}`);
  console.log(`Using OCR service: ${OCR_SERVICE_URL}`);
});
