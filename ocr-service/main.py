from fastapi import FastAPI, File, UploadFile, HTTPException
from rapidocr_onnxruntime import RapidOCR
from PIL import Image, UnidentifiedImageError
import io

app = FastAPI()
ocr = RapidOCR()

@app.post("/ocr/image")
async def ocr_image(file: UploadFile = File(...)):
    """对单张图片做 OCR，返回文本"""
    buf = await file.read()
    try:
        img = Image.open(io.BytesIO(buf))
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="无法识别图片文件，请上传 JPG/PNG/WebP 等图片，PDF 请走 PDF OCR 模式")
    result, _ = ocr(img)
    if not result:
        return {"text": "", "lines": []}
    lines = [item[1] for item in result]
    return {"text": "\n".join(lines), "lines": lines}

@app.post("/ocr/batch")
async def ocr_batch(files: list[UploadFile] = File(...)):
    """批量 OCR，给 PDF 多页用，返回每页文本"""
    pages = []
    for i, file in enumerate(files):
        buf = await file.read()
        try:
            img = Image.open(io.BytesIO(buf))
        except UnidentifiedImageError:
            raise HTTPException(status_code=400, detail=f"第 {i + 1} 个文件不是可识别的图片")
        result, _ = ocr(img)
        text = "\n".join([item[1] for item in result]) if result else ""
        pages.append({"page": i + 1, "text": text})
    return {"pages": pages}

@app.get("/health")
async def health():
    return {"status": "ok", "model": "rapidocr-onnxruntime"}
