// pdf-text.js — PDF 文本层提取脚本（视觉之眼 v2.1 配套，--fast 模式路由判断用）
// 用法: bun pdf-text.js <pdf路径>
//
// 依赖内置 node_modules/mupdf（与 render-pdf.js 相同）。
// 逐页提取文本层并统计视觉元素，每页输出一行 JSON：
//   {"page":1,"text":"...","images":2,"vectors":0}
//   - text:    stext.asText() 的文本（含换行）
//   - images:  栅格图片数量（Device.fillImage 回调次数）
//   - vectors: 矢量图形绘制操作数（fillPath/strokePath/fillShade/fillImageMask），
//              整页背景填充按包围盒过滤排除（很多生成器会画全页白底矩形）
// 主脚本据此路由：images/vectors>0 或文本过少/乱码 → 视觉识别；否则零 API 直抽。
//
// 实测说明：stext 的 StructuredTextWalker.onVector 在本版 mupdf.js 不触发（Word 形状、
// 描边矩形均检测不到），因此矢量检测改用 DisplayList.run(Device) 的绘制指令级回调，
// 该路径对描边/填充/着色均实测有效。
// 失败时退出码非 0，stderr 给出原因（含加密 PDF 提示）。
import * as mupdf from "mupdf";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [pdfPathArg] = process.argv.slice(2);
if (!pdfPathArg) {
  console.error("用法: bun pdf-text.js <pdf路径>");
  process.exit(2);
}
const pdfPath = resolve(pdfPathArg);

if (!existsSync(pdfPath)) {
  console.error(`PDF 文件不存在: ${pdfPath}`);
  process.exit(1);
}

let doc;
try {
  doc = mupdf.Document.openDocument(pdfPath, "application/pdf");
} catch (e) {
  console.error(`无法打开 PDF（可能已损坏）: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (doc.needsPassword()) {
  console.error("PDF 已加密，请先解除密码保护（或手动导出无密码副本后重试）。");
  process.exit(1);
}

const n = doc.countPages();
try {
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const [px0, py0, px1, py1] = page.getBounds();
    const pageArea = (px1 - px0) * (py1 - py0);

    // 文本层
    const st = page.toStructuredText();
    const text = st.asText().trim();

    // 视觉元素：显示列表级检测（矢量检测用 Device 回调，背景填充按包围盒过滤）
    let images = 0;
    let vectors = 0;
    const isBackground = (bbox) => {
      if (!Array.isArray(bbox) || bbox.length < 4) return false;
      const [x0, y0, x1, y1] = bbox;
      return (x1 - x0) * (y1 - y0) > pageArea * 0.95; // 覆盖 ≥95% 页面的填充视为背景
    };
    const device = new mupdf.Device({
      fillPath(path) {
        try {
          const bbox = path.getBounds(null, mupdf.Matrix.identity);
          if (!isBackground(bbox)) vectors++;
        } catch {
          vectors++; // 取不到包围盒时保守计入
        }
      },
      strokePath() { vectors++; },      // 描边几乎不会是背景
      fillShade() { vectors++; },
      fillImage() { images++; },
      fillImageMask() { vectors++; },
    });
    try {
      page.toDisplayList(true).run(device, mupdf.Matrix.identity);
    } catch {
      // 显示列表分析失败（异常 PDF 结构）：按无视觉元素处理，文本仍可用
    }

    console.log(JSON.stringify({ page: i + 1, text, images, vectors }));
  }
} catch (e) {
  console.error(`PDF 文本提取失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
