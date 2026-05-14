# OCR Demo 启动说明

`ocr-demo` 是本项目里的本地 OCR 测试台，用浏览器上传图片或 PDF，查看渲染预览、OCR 文字和耗时。它本身不做 OCR 模型推理，而是调用 Python OCR 服务：

```text
ocr-demo 页面 -> ocr-demo Node 服务 -> ocr-service FastAPI 服务 -> RapidOCR
```

## 1. 先启动 OCR 服务

在项目根目录执行：

```bash
cd /opt/weixin-bot-ai
pm2 start ecosystem.config.cjs --only ocr-service
```

如果已经启动过，可以检查状态：

```bash
pm2 status
curl http://127.0.0.1:8765/health
```

正常会返回类似：

```json
{"status":"ok","model":"rapidocr-onnxruntime"}
```

## 2. 启动 OCR Demo

进入 demo 目录：

```bash
cd /opt/weixin-bot-ai/ocr-demo
npm start
```

默认监听地址：

```text
http://127.0.0.1:8899
```

如果是在局域网其他电脑访问，把 `127.0.0.1` 换成这台机器的内网 IP，例如：

```text
http://192.168.x.x:8899
```

## 3. 常用环境变量

可以临时改端口或 OCR 服务地址：

```bash
PORT=8898 OCR_SERVICE_URL=http://127.0.0.1:8765 npm start
```

可选项：

```text
PORT                 OCR Demo 页面端口，默认 8899
OCR_SERVICE_URL      Python OCR 服务地址，默认 http://127.0.0.1:8765
PDF_TEXT_MIN_CHARS   PDF 自动模式中文本层阈值，默认 200
PDF_RENDER_SCALE     PDF OCR 渲染倍率，默认 1.35
```

## 4. 页面测试模式

页面左侧可以选择：

```text
单张图片 OCR
多图 batch OCR
PDF 自动：有文本层则跳过 OCR
PDF 只读文本层
PDF 强制逐页 OCR
```

扫描版 PDF 建议选 `PDF 强制逐页 OCR`，可以看到每页渲染预览、OCR 字数、渲染耗时和 OCR 耗时。

## 5. 常见问题

如果页面顶部显示 OCR 服务异常，先确认 `ocr-service` 是否在线：

```bash
pm2 status
curl http://127.0.0.1:8765/health
```

如果端口 `8899` 被占用，换端口启动：

```bash
PORT=8898 npm start
```

如果 PDF 预览空白，优先看终端日志是否有 PDF 渲染错误。当前 demo 已配置 `pdfjs-dist/wasm` 的本地解码资源，可处理 JBIG2/CCITT 这类扫描 PDF 图像。
