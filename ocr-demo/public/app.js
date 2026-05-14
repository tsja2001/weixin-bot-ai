const modeSelect = document.querySelector("#mode");
const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const fileList = document.querySelector("#fileList");
const runBtn = document.querySelector("#runBtn");
const clearBtn = document.querySelector("#clearBtn");
const healthBtn = document.querySelector("#healthBtn");
const serviceStatus = document.querySelector("#serviceStatus");
const results = document.querySelector("#results");
const metrics = document.querySelector("#metrics");
const progress = document.querySelector("#progress");
const pageTemplate = document.querySelector("#pageTemplate");

let selectedFiles = [];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setBusy(isBusy) {
  runBtn.disabled = isBusy;
  clearBtn.disabled = isBusy;
  modeSelect.disabled = isBusy;
  progress.classList.toggle("hidden", !isBusy);
}

function renderFileList() {
  fileList.innerHTML = "";
  selectedFiles.forEach(file => {
    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML = `<span title="${file.name}">${file.name}</span><span>${formatBytes(file.size)}</span>`;
    fileList.appendChild(item);
  });
}

function setFiles(files) {
  selectedFiles = Array.from(files);
  renderFileList();
}

function setMetrics(items = []) {
  metrics.innerHTML = "";
  items.forEach(item => {
    const chip = document.createElement("span");
    chip.className = "metric";
    chip.textContent = item;
    metrics.appendChild(chip);
  });
}

function showError(error) {
  results.className = "results";
  results.innerHTML = "";
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = error?.message || String(error);
  results.appendChild(box);
}

function isPdf(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImage(file) {
  return file.type.startsWith("image/");
}

function validateSelection(mode, files) {
  if (files.length === 0) {
    throw new Error("请先选择文件");
  }
  if (mode === "image" && (files.length !== 1 || !isImage(files[0]))) {
    throw new Error("单张图片 OCR 只能上传 1 张图片，请不要在这个模式上传 PDF。");
  }
  if (mode === "batch" && files.some(file => !isImage(file))) {
    throw new Error("多图 batch OCR 只能上传图片文件。");
  }
  if (mode.startsWith("pdf-") && (files.length !== 1 || !isPdf(files[0]))) {
    throw new Error("PDF 模式只能上传 1 个 PDF 文件。");
  }
}

function addSummary(title, text) {
  const box = document.createElement("section");
  box.className = "summary";
  const h = document.createElement("strong");
  h.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = text || "";
  box.append(h, pre);
  results.appendChild(box);
}

function addPageResult({ page, title, text, image, meta }) {
  const node = pageTemplate.content.firstElementChild.cloneNode(true);
  const preview = node.querySelector(".preview");
  const metaEl = node.querySelector(".page-meta");
  const textarea = node.querySelector("textarea");

  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = title || `第 ${page} 页`;
    preview.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = "无页面预览";
    preview.appendChild(placeholder);
  }

  metaEl.textContent = meta || title || `第 ${page} 页`;
  textarea.value = text || "";
  results.appendChild(node);
}

async function checkHealth() {
  serviceStatus.textContent = "正在检查服务...";
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "健康检查失败");
    serviceStatus.textContent = `OCR 服务正常：${data.service.model}，${data.elapsedMs}ms`;
  } catch (error) {
    serviceStatus.textContent = `OCR 服务异常：${error.message}`;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function postRawFile(url, file) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function runImage(file) {
  const data = await postRawFile("/api/ocr/image", file);
  setMetrics([
    "/ocr/image",
    `${formatBytes(data.bytes)}`,
    `${data.chars} 字`,
    `${data.elapsedMs}ms`,
  ]);
  addPageResult({
    page: 1,
    title: file.name,
    text: data.text,
    image: URL.createObjectURL(file),
    meta: `${file.name} · ${data.lines.length} 行 · ${data.chars} 字 · OCR ${data.elapsedMs}ms`,
  });
}

async function runBatch(files) {
  const payloadFiles = [];
  for (const file of files) {
    payloadFiles.push({
      name: file.name,
      dataBase64: await readFileAsBase64(file),
    });
  }

  const res = await fetch("/api/ocr/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: payloadFiles }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

  setMetrics([
    "/ocr/batch",
    `${data.fileCount} 张`,
    `${data.chars} 字`,
    `${data.elapsedMs}ms`,
  ]);

  data.pages.forEach((page, index) => {
    addPageResult({
      page: page.page,
      title: files[index]?.name || `第 ${page.page} 张`,
      text: page.text,
      image: files[index] ? URL.createObjectURL(files[index]) : null,
      meta: `${files[index]?.name || `第 ${page.page} 张`} · ${(page.text || "").length} 字`,
    });
  });
}

async function runPdf(file, mode) {
  const url = `/api/pdf?mode=${mode}&images=1`;
  const data = await postRawFile(url, file);
  const result = data.result;

  setMetrics([
    `PDF ${data.selected === "ocr" ? "OCR" : "文本层"}`,
    `${data.pageCount} 页`,
    `${result.chars} 字`,
    `${result.elapsedMs}ms`,
  ]);

  addSummary(
    `整体文本 · ${data.selected === "ocr" ? "OCR 输出" : "PDF 文本层"} · ${result.chars} 字`,
    result.text
  );

  result.pages.forEach(page => {
    const timing = data.selected === "ocr"
      ? `渲染 ${page.renderMs}ms · OCR ${page.ocrMs}ms · ${formatBytes(page.imageBytes)}`
      : `文本层 · ${page.chars} 字`;
    addPageResult({
      page: page.page,
      title: `第 ${page.page} 页`,
      text: page.text,
      image: page.image,
      meta: `第 ${page.page} 页 · ${page.chars} 字 · ${timing}`,
    });
  });
}

async function run() {
  const mode = modeSelect.value;
  results.className = "results";
  results.innerHTML = "";
  setMetrics([]);
  setBusy(true);

  try {
    validateSelection(mode, selectedFiles);

    if (mode === "image") {
      await runImage(selectedFiles[0]);
    } else if (mode === "batch") {
      await runBatch(selectedFiles);
    } else {
      const file = selectedFiles[0];
      const pdfMode = mode === "pdf-ocr" ? "ocr" : mode === "pdf-text" ? "text" : "auto";
      await runPdf(file, pdfMode);
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

fileInput.addEventListener("change", event => setFiles(event.target.files));
runBtn.addEventListener("click", run);
clearBtn.addEventListener("click", () => {
  selectedFiles = [];
  fileInput.value = "";
  renderFileList();
  setMetrics([]);
  results.className = "results empty";
  results.textContent = "等待上传文件。";
});
healthBtn.addEventListener("click", checkHealth);

dropzone.addEventListener("dragover", event => {
  event.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", event => {
  event.preventDefault();
  dropzone.classList.remove("dragover");
  setFiles(event.dataTransfer.files);
});

checkHealth();
