# OCR CPU 优化方案 A 测试规划

本文只规划“方案 A：在现有 rapidocr-onnxruntime + CPUExecutionProvider 基础上优化”，不涉及 OpenVINO、核显或更换 OCR 引擎。目标是在动代码前先建立可重复的基准测试，确保优化前后能用同一套指标证明是否真的变快，以及是否牺牲了可接受范围外的识别效果。

## 1. 当前基线

当前 OCR 服务：

```text
目录：/opt/weixin-bot-ai/ocr-service
入口：ocr-service/main.py
OCR：rapidocr-onnxruntime==1.3.24
ONNXRuntime：CPUExecutionProvider
设备：Intel N100，4 核 CPU
```

当前 PDF OCR 主链路：

```text
bot.js
  -> PDF.js 解析 PDF
  -> 超过 3 页先尝试文本层
  -> 文本层不足 200 字才逐页渲染 PNG
  -> 每页调用 ocr-service /ocr/image
  -> 拼接每页 OCR 文本
```

当前关键参数：

```text
PDF_TEXT_MIN_CHARS = 200
PDF_OCR_RENDER_SCALE = 1.35
RapidOCR 默认：use_det=true, use_cls=true, use_rec=true
RapidOCR 默认线程：intra_op_num_threads=-1, inter_op_num_threads=-1
RapidOCR 默认识别 batch：rec_batch_num=6
RapidOCR 默认方向分类 batch：cls_batch_num=6
```

## 2. 方案 A 可调项

本轮只考虑这些 CPU 侧优化：

```text
1. RapidOCR 线程数
   intra_op_num_threads
   inter_op_num_threads

2. 关闭方向分类器
   use_cls=false
   适合页面基本都是正向扫描件的场景

3. 调整识别 batch
   rec_batch_num
   cls_batch_num

4. 调整 PDF 渲染倍率
   PDF_OCR_RENDER_SCALE

5. 控制 PDF OCR 页级并发
   当前是逐页串行
   后续可测试并发 2
```

本轮不做：

```text
1. 不换 rapidocr-openvino
2. 不安装 onnxruntime-openvino
3. 不启用 Intel 核显
4. 不改变 3 页以内 PDF 走 AI vision 的策略
5. 不改变 DOCX/TXT/XLSX/PPTX 的解析逻辑
```

## 3. 测试样本

测试样本全部来自：

```text
/opt/weixin-bot-ai/temp
```

当前样本：

```text
1. 金378-金隅集团发〔2025〕364号-关于印发《招标采购管理办法》的通知（全部是扫描件）.pdf
   大小：约 1.6MB
   特点：全部扫描件
   用途：主要 OCR 性能测试样本

2. AI馆:平台介绍提示词（都是文本）.pdf
   大小：约 196KB
   特点：文本层 PDF
   用途：验证文本层提取路径，确保不误走 OCR

3. “x”重组优化工作（第一页是扫描，后面是文本）.pdf
   大小：约 1.0MB
   特点：混合 PDF，第一页扫描，后续文本
   用途：验证当前“全文文本层阈值”策略对混合 PDF 的行为
```

## 4. 必须采集的指标

每次测试至少采集：

```text
文件名
文件大小
页数
处理模式：pdf_text / ocr / image
文本层字数
是否触发 OCR
PDF 渲染倍率
OCR 服务配置
总耗时 ms
文本层提取耗时 ms
PDF 渲染总耗时 ms
OCR 总耗时 ms
每页渲染耗时 ms
每页 OCR 耗时 ms
每页 PNG 大小 KB
每页 OCR 字数
全文 OCR 字数
错误信息
```

建议额外采集系统状态：

```text
CPU 型号
CPU 核心数
可用 ONNXRuntime providers
内存占用
测试时间
git commit 或工作区标记
```

## 5. 识别质量对比口径

速度提升不能只看耗时，也要保证输出没有明显劣化。

本轮不做复杂人工标注，先用“轻量质量门槛”：

```text
1. 同一文件优化后全文字数不低于基线的 95%
2. 每页字数不低于基线的 90%，空白页除外
3. 关键样本的前 3 页和最后 1 页人工抽查，确认没有大面积乱码
4. 对纯文本层 PDF，优化前后输出字数应一致或基本一致
```

对纯扫描 PDF重点看：

```text
总耗时是否下降
OCR 字数是否接近
页面是否仍能正常渲染
```

对文本层 PDF重点看：

```text
是否仍然跳过 OCR
处理耗时是否没有明显变慢
输出字数是否一致
```

对混合 PDF重点看：

```text
当前策略是否因为后续页文本层超过 200 字而跳过 OCR
第一页扫描内容是否会丢失
```

说明：混合 PDF 暴露的是“策略问题”，不一定属于 OCR 性能优化范围。如果测试发现第一页扫描内容被跳过，应单独开“混合 PDF 分页策略优化”，不要混进本轮 CPU 优化。

## 6. 基准测试脚本规划

建议新增脚本：

```text
tools/ocr_benchmark.mjs
```

脚本职责：

```text
1. 遍历 temp 目录下指定 PDF
2. 使用和 bot.js 相同的 PDF.js 配置加载 PDF
3. 提取文本层并计时
4. 根据测试模式决定是否强制 OCR
5. 渲染每页为 PNG 并计时
6. 调用 ocr-service /ocr/image 并计时
7. 输出 JSONL 明细和 Markdown 汇总
```

建议输出目录：

```text
benchmarks/ocr/
```

每轮输出：

```text
benchmarks/ocr/YYYYMMDD-HHMMSS-baseline.jsonl
benchmarks/ocr/YYYYMMDD-HHMMSS-baseline-summary.md
benchmarks/ocr/YYYYMMDD-HHMMSS-optimized.jsonl
benchmarks/ocr/YYYYMMDD-HHMMSS-optimized-summary.md
```

JSONL 每行建议结构：

```json
{
  "runId": "20260514-130000-baseline",
  "fileName": "xxx.pdf",
  "page": 15,
  "mode": "ocr",
  "renderScale": 1.35,
  "renderMs": 123,
  "ocrMs": 395,
  "imageBytes": 16691,
  "chars": 0,
  "error": null
}
```

汇总 Markdown 建议包含：

```text
配置快照
按文件汇总表
按页最慢 Top 10
OCR 字数异常页
错误列表
```

## 7. 测试模式规划

脚本至少支持三种模式：

```text
auto
  模拟 bot.js 当前策略：
  >3 页先读文本层，文本层 >= 200 字跳过 OCR，否则 OCR

force-ocr
  强制所有页渲染 + OCR：
  用来测试扫描 PDF 和混合 PDF 的 OCR 性能

text-only
  只测文本层：
  用来确认文本 PDF 不应进入 OCR
```

针对当前三个样本建议这样跑：

```text
纯扫描 PDF：
  auto
  force-ocr

纯文本 PDF：
  auto
  text-only

混合 PDF：
  auto
  force-ocr
  text-only
```

## 8. 测试轮次

每个配置至少跑 3 轮：

```text
第 1 轮：预热，不纳入最终统计
第 2 轮：有效数据
第 3 轮：有效数据
第 4 轮：有效数据
```

最终取：

```text
平均值
中位数
最快值
最慢值
```

原因：

```text
N100 NAS 上可能同时跑微信 bot、PM2、系统服务和文件服务，单轮耗时波动较大。
```

## 9. 优化配置矩阵

### 9.1 基线配置

```text
名称：baseline
PDF_OCR_RENDER_SCALE=1.35
use_cls=true
intra_op_num_threads=-1
inter_op_num_threads=-1
rec_batch_num=6
cls_batch_num=6
PDF 页级并发=1
```

### 9.2 CPU 线程优化

```text
名称：cpu-threads-4-1
PDF_OCR_RENDER_SCALE=1.35
use_cls=true
intra_op_num_threads=4
inter_op_num_threads=1
rec_batch_num=6
cls_batch_num=6
PDF 页级并发=1
```

目标：

```text
减少 ONNXRuntime 默认线程调度不稳定，贴合 N100 4 核。
```

### 9.3 关闭方向分类器

```text
名称：no-cls
PDF_OCR_RENDER_SCALE=1.35
use_cls=false
intra_op_num_threads=4
inter_op_num_threads=1
rec_batch_num=6
PDF 页级并发=1
```

目标：

```text
减少一次方向分类模型调用。
```

风险：

```text
如果扫描页有倒置、旋转 180 度，识别质量会明显下降。
```

### 9.4 提高识别 batch

```text
名称：batch-12
PDF_OCR_RENDER_SCALE=1.35
use_cls=false
intra_op_num_threads=4
inter_op_num_threads=1
rec_batch_num=12
cls_batch_num=6
PDF 页级并发=1
```

目标：

```text
减少多行文字识别时的调用开销，提高吞吐。
```

风险：

```text
内存略增，过大可能反而变慢。
```

### 9.5 降低 PDF 渲染倍率

```text
名称：scale-1.2
PDF_OCR_RENDER_SCALE=1.2
use_cls=false
intra_op_num_threads=4
inter_op_num_threads=1
rec_batch_num=12
PDF 页级并发=1
```

目标：

```text
减少渲染输出 PNG 尺寸，降低 PDF 渲染耗时和 OCR 输入尺寸。
```

风险：

```text
小字号、低清晰度扫描件识别率可能下降。
```

### 9.6 页级并发 2

```text
名称：page-concurrency-2
PDF_OCR_RENDER_SCALE=1.2
use_cls=false
intra_op_num_threads=4
inter_op_num_threads=1
rec_batch_num=12
PDF 页级并发=2
```

目标：

```text
让 PDF 渲染和 OCR 请求有一定重叠，减少总等待时间。
```

风险：

```text
N100 只有 4 核，并发过高容易让单页 OCR 变慢、内存增加、系统响应变差。
```

## 10. 推荐实施顺序

不要一次把所有优化都合进去。建议按以下顺序：

```text
1. 先写 benchmark 脚本，不改生产逻辑。
2. 跑 baseline，保存报告。
3. 增加 OCR 服务环境变量配置能力，但默认值保持现状。
4. 跑 cpu-threads-4-1。
5. 跑 no-cls。
6. 跑 batch-12。
7. 跑 scale-1.2。
8. 如前面收益仍不够，再测试 page-concurrency-2。
9. 选总耗时更短且质量达标的配置作为默认。
10. 更新 DOC 文档和 ocr-demo 说明。
```

## 11. 代码改造规划

### 11.1 OCR 服务配置环境变量

在 `ocr-service/main.py` 中支持：

```text
OCR_USE_CLS=true|false
OCR_INTRA_THREADS=4
OCR_INTER_THREADS=1
OCR_REC_BATCH_NUM=12
OCR_CLS_BATCH_NUM=6
```

初始化 RapidOCR 时转换成 kwargs：

```python
RapidOCR(
    use_cls=False,
    intra_op_num_threads=4,
    inter_op_num_threads=1,
    rec_batch_num=12,
    cls_batch_num=6,
)
```

注意：实际 key 要以 rapidocr-onnxruntime 当前版本 `parse_parameters.py` 支持的参数为准。

### 11.2 Bot PDF 参数环境变量

在 `bot.js` 中支持：

```text
PDF_OCR_RENDER_SCALE=1.2
PDF_OCR_PAGE_CONCURRENCY=1 或 2
```

初期只加 `PDF_OCR_RENDER_SCALE` 环境变量即可。页级并发属于第二阶段。

### 11.3 OCR Demo 同步

`ocr-demo/server.js` 已支持：

```text
PDF_RENDER_SCALE
PDF_TEXT_MIN_CHARS
```

如果主 bot 加页级并发，demo 可暂不跟进，避免测试台复杂化。

## 12. 验收标准

优化方案进入默认配置前，至少满足：

```text
1. 纯扫描 PDF force-ocr 总耗时下降 >= 20%
2. 纯扫描 PDF 全文字数 >= 基线 95%
3. 任一非空页 OCR 字数不低于基线 90%，除非人工确认基线误识别更多
4. 纯文本 PDF auto 模式仍跳过 OCR
5. 混合 PDF auto 模式行为有明确记录，不因 CPU 优化改变
6. OCR 服务连续处理 3 轮样本无 500 错误
7. N100 NAS 上测试期间内存不持续上涨
```

如果只能提升 5%-10%，不建议牺牲识别质量或引入并发复杂度。

## 13. 风险与回滚

### 13.1 关闭方向分类器风险

风险：

```text
倒置页面识别失败。
```

回滚：

```text
OCR_USE_CLS=true
pm2 restart ocr-service --update-env
```

### 13.2 降低渲染倍率风险

风险：

```text
小字识别下降。
```

回滚：

```text
PDF_OCR_RENDER_SCALE=1.35
pm2 restart weixin-bot-1 weixin-bot-2 weixin-bot-test --update-env
```

### 13.3 页级并发风险

风险：

```text
CPU 打满，反而更慢。
```

回滚：

```text
PDF_OCR_PAGE_CONCURRENCY=1
```

## 14. 最终报告模板

最终优化完成后应形成一份报告：

```text
DOC/OCR_CPU优化方案A测试报告.md
```

建议结构：

```text
1. 测试环境
2. 测试样本
3. 基线配置
4. 优化配置
5. 总耗时对比
6. 每页耗时对比
7. 字数和质量对比
8. 最终采用配置
9. 回滚方式
10. 后续是否进入方案 B OpenVINO
```

## 15. 预期结论

在 N100 上，最可能有效的组合是：

```text
OCR_USE_CLS=false
OCR_INTRA_THREADS=4
OCR_INTER_THREADS=1
OCR_REC_BATCH_NUM=12
PDF_OCR_RENDER_SCALE=1.2 或 1.35
PDF_OCR_PAGE_CONCURRENCY=1
```

是否启用页级并发 2，需要以基准测试结果为准。N100 核心数有限，盲目并发可能让单页耗时增加，总耗时未必下降。

