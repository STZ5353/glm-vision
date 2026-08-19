#!/usr/bin/env python
"""
pdf2png.py — 把 PDF 每一页渲染为 PNG（视觉之眼配套脚本）

用法: uv run --with pymupdf python pdf2png.py <pdf路径> <输出目录> [dpi] [最大边长px]

- 默认 dpi=150（文字清晰），单页最大边自动压到 4000px 内
  （智谱图片 API 限制: 单张 ≤5M、像素 ≤6000x6000）
- 逐页输出 page-001.png / page-002.png ...，并把每个输出文件路径打印到 stdout
- 渲染失败时退出码非 0，stderr 给出原因
"""
import os
import sys

import pymupdf  # PyMuPDF（新版导入名；旧版兼容别名 fitz）


def main() -> None:
    if len(sys.argv) < 3:
        print("用法: uv run --with pymupdf python pdf2png.py <pdf路径> <输出目录> [dpi] [最大边长px]", file=sys.stderr)
        sys.exit(2)

    pdf_path = sys.argv[1]
    out_dir = sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    max_side = int(sys.argv[4]) if len(sys.argv) > 4 else 4000

    if not os.path.isfile(pdf_path):
        print(f"PDF 文件不存在: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)

    try:
        doc = pymupdf.open(pdf_path)
    except Exception as e:  # 文件损坏/加密等情况
        print(f"无法打开 PDF（可能已损坏或加密）: {e}", file=sys.stderr)
        sys.exit(1)

    if doc.needs_pass:
        print("PDF 已加密，请先解除密码保护。", file=sys.stderr)
        sys.exit(1)

    try:
        for i, page in enumerate(doc):
            zoom = dpi / 72.0
            rect = page.rect
            if max(rect.width, rect.height) * zoom > max_side:
                zoom *= max_side / (max(rect.width, rect.height) * zoom)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            out_path = os.path.join(out_dir, f"page-{i + 1:03d}.png")
            pix.save(out_path)
            print(out_path)
    finally:
        doc.close()


if __name__ == "__main__":
    main()
