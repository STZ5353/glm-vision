// render-pdf.js — PDF → PNG 渲染脚本（视觉之眼 v2.0 配套）
// 用法: bun render-pdf.js <pdf路径> <输出目录> [缩放倍率=2] [最大边长px=4000]
//
// 依赖内置 node_modules/mupdf（MuPDF.js v1.28.0，wasm 运行时，三平台通用，无需安装）。
// 智谱图片 API 限制单张像素 ≤6000x6000、base64 后 ≤5M，
// 因此默认 2 倍缩放（约 144dpi）且长边自动压到 4000px 内。
//
// 输出：每个渲染页的绝对路径，一行一个（主脚本据此逐页识别）；
// 失败时退出码非 0，stderr 给出原因（含加密 PDF 提示）。
import * as mupdf from "mupdf";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [pdfPathArg, outDirArg, zoomArg, maxSideArg] = process.argv.slice(2);
if (!pdfPathArg || !outDirArg) {
  console.error("用法: bun render-pdf.js <pdf路径> <输出目录> [缩放倍率=2] [最大边长px=4000]");
  process.exit(2);
}
const pdfPath = resolve(pdfPathArg);
const outDir = resolve(outDirArg);
const zoom = zoomArg ? parseFloat(zoomArg) : 2;
const maxSide = maxSideArg ? parseInt(maxSideArg, 10) : 4000;

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
if (n === 0) {
  console.error("PDF 没有页面");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const files = [];
try {
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    // 页面尺寸（pt）：长边超过 maxSide/zoom 时降低缩放，避免超过 API 像素上限
    const [x0, y0, x1, y1] = page.getBounds();
    let z = zoom;
    const maxPt = Math.max(x1 - x0, y1 - y0);
    if (maxPt * z > maxSide) z = maxSide / maxPt;
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(z, z),
      mupdf.ColorSpace.DeviceRGB,
      false, // alpha
      true   // showExtras: 保留注释/链接等附加内容
    );
    const out = `${outDir}/page-${String(i + 1).padStart(3, "0")}.png`;
    await Bun.write(out, pixmap.asPNG());
    files.push(out);
  }
} catch (e) {
  console.error(`PDF 渲染失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
console.log(files.join("\n"));
