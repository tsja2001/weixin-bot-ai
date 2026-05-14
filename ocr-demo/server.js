import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PDFJS_WASM_URL = pathToFileURL(path.join(__dirname, "../node_modules/pdfjs-dist/wasm")).href + "/";
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || "http://127.0.0.1:8765";
const PORT = Number(process.env.PORT || 8899);
const PDF_TEXT_MIN_CHARS = Number(process.env.PDF_TEXT_MIN_CHARS || 200);
const PDF_RENDER_SCALE = Number(process.env.PDF_RENDER_SCALE || 1.35);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, details) {
  sendJson(res, status, { ok: false, error: message, details });
}

function readBody(req, maxBytes = 80 * 1024 * 1024) {
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

async function callOcrImage(buffer, fileName = "image.png") {
  const formData = new FormData();
  formData.append("file", new Blob([buffer]), fileName);

  const startedAt = Date.now();
  const response = await fetch(`${OCR_SERVICE_URL}/ocr/image`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(120000),
  });
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OCR /ocr/image HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  return { ...data, elapsedMs };
}

async function callOcrBatch(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", new Blob([file.buffer]), file.name || "image.png");
  }

  const startedAt = Date.now();
  const response = await fetch(`${OCR_SERVICE_URL}/ocr/batch`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(180000),
  });
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OCR /ocr/batch HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  return { ...data, elapsedMs };
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

  return {
    pages,
    text: fullText,
    chars: fullText.length,
    elapsedMs: Date.now() - startedAt,
  };
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

async function ocrPdfPages(doc, { includeImages = true } = {}) {
  const startedAt = Date.now();
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const pageStartedAt = Date.now();
    const page = await doc.getPage(i);
    const imageBuffer = await renderPdfPage(page, PDF_RENDER_SCALE);
    const renderMs = Date.now() - pageStartedAt;

    const ocr = await callOcrImage(imageBuffer, `page_${i}.png`);
    pages.push({
      page: i,
      text: ocr.text || "",
      lines: ocr.lines || [],
      chars: (ocr.text || "").length,
      imageBytes: imageBuffer.length,
      renderMs,
      ocrMs: ocr.elapsedMs,
      image: includeImages ? `data:image/png;base64,${imageBuffer.toString("base64")}` : null,
    });
  }

  const text = normalizePdfText(
    pages.map(page => `## 第 ${page.page} 页\n\n${page.text}`).join("\n\n")
  );

  return {
    pages,
    text,
    chars: text.length,
    elapsedMs: Date.now() - startedAt,
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    const startedAt = Date.now();
    const response = await fetch(`${OCR_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    return sendJson(res, 200, {
      ok: true,
      ocrServiceUrl: OCR_SERVICE_URL,
      elapsedMs: Date.now() - startedAt,
      service: data,
    });
  }

  if (url.pathname === "/api/ocr/image" && req.method === "POST") {
    const buffer = await readBody(req);
    const fileName = decodeURIComponent(req.headers["x-file-name"] || "image.png");
    const result = await callOcrImage(buffer, fileName);
    return sendJson(res, 200, {
      ok: true,
      endpoint: "/ocr/image",
      fileName,
      bytes: buffer.length,
      text: result.text || "",
      lines: result.lines || [],
      chars: (result.text || "").length,
      elapsedMs: result.elapsedMs,
    });
  }

  if (url.pathname === "/api/ocr/batch" && req.method === "POST") {
    const raw = await readBody(req);
    const body = JSON.parse(raw.toString("utf-8"));
    const files = (body.files || []).map(file => ({
      name: file.name,
      buffer: Buffer.from(file.dataBase64, "base64"),
    }));
    if (files.length === 0) return sendError(res, 400, "files 不能为空");

    const result = await callOcrBatch(files);
    return sendJson(res, 200, {
      ok: true,
      endpoint: "/ocr/batch",
      fileCount: files.length,
      pages: result.pages || [],
      chars: (result.pages || []).reduce((sum, page) => sum + (page.text || "").length, 0),
      elapsedMs: result.elapsedMs,
    });
  }

  if (url.pathname === "/api/pdf" && req.method === "POST") {
    const mode = url.searchParams.get("mode") || "auto";
    const includeImages = url.searchParams.get("images") !== "0";
    const buffer = await readBody(req);
    const fileName = decodeURIComponent(req.headers["x-file-name"] || "document.pdf");

    const doc = await loadPdf(buffer);
    const textLayer = await extractPdfText(doc);
    const base = {
      ok: true,
      fileName,
      pageCount: doc.numPages,
      mode,
      bytes: buffer.length,
      textLayer,
      thresholdChars: PDF_TEXT_MIN_CHARS,
      renderScale: PDF_RENDER_SCALE,
    };

    if (mode === "text") {
      return sendJson(res, 200, { ...base, selected: "text", result: textLayer });
    }

    if (mode === "auto" && textLayer.chars >= PDF_TEXT_MIN_CHARS) {
      return sendJson(res, 200, { ...base, selected: "text", result: textLayer });
    }

    if (!["auto", "ocr"].includes(mode)) {
      return sendError(res, 400, "mode 只支持 auto/text/ocr");
    }

    const ocr = await ocrPdfPages(doc, { includeImages });
    return sendJson(res, 200, { ...base, selected: "ocr", result: ocr });
  }

  return sendError(res, 404, "API 不存在");
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || "服务器错误", error.stack);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OCR Demo: http://127.0.0.1:${PORT}`);
  console.log(`Using OCR service: ${OCR_SERVICE_URL}`);
});
