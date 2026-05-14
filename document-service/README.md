# Document Service

Node 文档解析服务，供 `bot.js` 调用。

```text
bot.js -> document-service /parse-stream -> ocr-service /ocr/image
```

## API

```bash
curl http://127.0.0.1:8770/health

curl -X POST http://127.0.0.1:8770/parse \
  -H "x-file-name: demo.pdf" \
  --data-binary @demo.pdf

curl -N -X POST http://127.0.0.1:8770/parse-stream \
  -H "x-file-name: demo.pdf" \
  --data-binary @demo.pdf
```

请求体是原始文件二进制，`x-file-name` 使用 URL 编码文件名。`/parse-stream`
返回 NDJSON，OCR 时会先返回进度事件，最后返回解析结果。

## 环境变量

```text
DOCUMENT_SERVICE_PORT      服务端口，默认 8770
OCR_SERVICE_URL            OCR 服务地址，默认 http://127.0.0.1:8765
PDF_TEXT_MIN_CHARS         PDF 文本层阈值，默认 200
PDF_OCR_RENDER_SCALE       多页 PDF OCR 渲染倍率，默认 1.35
PDF_OCR_PAGE_CONCURRENCY   多页 PDF OCR 页级并发，支持 1 或 2，默认 1
```
