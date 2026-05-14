from fastapi import FastAPI, File, UploadFile, HTTPException
from rapidocr_onnxruntime import RapidOCR
from PIL import Image, UnidentifiedImageError
import io
import os
import time

try:
    import onnxruntime as ort
except Exception:
    ort = None

app = FastAPI()


def parse_bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "no", "n", "off"}:
        return False
    raise ValueError(f"{name} 必须是 true/false，当前值: {raw}")


def parse_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} 必须是整数，当前值: {raw}") from exc


OCR_CONFIG = {
    "use_cls": parse_bool_env("OCR_USE_CLS", True),
    "intra_op_num_threads": parse_int_env("OCR_INTRA_THREADS", -1),
    "inter_op_num_threads": parse_int_env("OCR_INTER_THREADS", -1),
    "rec_batch_num": parse_int_env("OCR_REC_BATCH_NUM", 6),
    "cls_batch_num": parse_int_env("OCR_CLS_BATCH_NUM", 6),
}

ocr = RapidOCR(**OCR_CONFIG)


def extract_lines(result):
    if not result:
        return []
    return [item[1] for item in result]

@app.post("/ocr/image")
async def ocr_image(file: UploadFile = File(...)):
    """对单张图片做 OCR，返回文本"""
    buf = await file.read()
    try:
        img = Image.open(io.BytesIO(buf))
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="无法识别图片文件，请上传 JPG/PNG/WebP 等图片，PDF 请走 PDF OCR 模式")
    started_at = time.perf_counter()
    result, _ = ocr(img)
    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    lines = extract_lines(result)
    return {"text": "\n".join(lines), "lines": lines, "elapsedMs": elapsed_ms}

@app.post("/ocr/batch")
async def ocr_batch(files: list[UploadFile] = File(...)):
    """批量 OCR，给 PDF 多页用，返回每页文本"""
    pages = []
    started_at = time.perf_counter()
    for i, file in enumerate(files):
        buf = await file.read()
        try:
            img = Image.open(io.BytesIO(buf))
        except UnidentifiedImageError:
            raise HTTPException(status_code=400, detail=f"第 {i + 1} 个文件不是可识别的图片")
        page_started_at = time.perf_counter()
        result, _ = ocr(img)
        elapsed_ms = round((time.perf_counter() - page_started_at) * 1000)
        lines = extract_lines(result)
        pages.append({"page": i + 1, "text": "\n".join(lines), "lines": lines, "elapsedMs": elapsed_ms})
    total_elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    return {"pages": pages, "elapsedMs": total_elapsed_ms}

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": "rapidocr-onnxruntime",
        "config": OCR_CONFIG,
        "providers": ort.get_available_providers() if ort else [],
    }
