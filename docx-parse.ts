/**
 * docx-parse.ts — 纯 TypeScript 的 .docx 文本解析与视觉内容探测（视觉之眼 v2.0 配套）
 *
 * 零依赖（node:zlib + node:fs），bun 直接运行，跨 Win/macOS/Linux。
 * docx 本质是 ZIP 容器：用最小 ZIP 读取器取出 word/document.xml 等条目，
 * 按文档流顺序把段落（含标题/列表层级）与表格转成 Markdown，
 * 并探测嵌入图片（word/media/*）与绘图元素（w:drawing/w:pict/w:object）数量。
 *
 * 相比 v1.2 的 uv+python-docx 方案：
 *   - 无需 Python/联网，解压即用
 *   - 补充页眉页脚、文本框内容提取（python-docx 方案遗漏的两类）
 * 已知局限（与 python-docx 方案一致或更优）：
 *   - 表格合并单元格（vMerge/gridSpan）按展开单元格近似处理
 *   - 批注/脚注/尾注不提取
 *
 * 导出 parseDocx(path) → { markdown, media, drawings, textboxes, headers, isOle }
 * 导出 extractDocxMedia(path) → 嵌入图片列表（Word 降级链"图片直抽"路径用）
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------- 最小 ZIP 读取器（支持 stored / deflate，不支持 zip64） ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

class ZipError extends Error {}

function readZip(buf: Buffer): { entries: Map<string, ZipEntry>; get: (name: string) => Buffer } {
  if (buf.length < 22) throw new ZipError("文件过小，不是有效的 ZIP/docx");
  // 定位 End of Central Directory（允许尾部有注释，从末尾向前最多扫 64KB）
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("未找到 ZIP 目录（文件可能已损坏或实为 .doc 旧格式）");
  const count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("zip64 格式不支持");

  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new ZipError("ZIP 中央目录损坏");
    const method = buf.readUInt16LE(cdOffset + 10);
    const compressedSize = buf.readUInt32LE(cdOffset + 20);
    const uncompressedSize = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipError("zip64 格式不支持");
    const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString("utf-8");
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    get(name: string): Buffer {
      const e = entries.get(name);
      if (!e) throw new ZipError(`ZIP 中缺少条目: ${name}`);
      if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) throw new ZipError(`条目 ${name} 本地头损坏`);
      const nameLen = buf.readUInt16LE(e.localOffset + 26);
      const extraLen = buf.readUInt16LE(e.localOffset + 28);
      const start = e.localOffset + 30 + nameLen + extraLen;
      const data = buf.subarray(start, start + e.compressedSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return inflateRawSync(data);
      throw new ZipError(`条目 ${name} 使用了不支持的压缩方式 (${e.method})`);
    },
  };
}

// ---------- XML 文本提取 ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** 从 XML 片段提取可见文本：w:t 拼接、w:tab→制表符、w:br/w:cr→换行、w:instrText 忽略 */
function extractText(xml: string): string {
  let out = "";
  const re = /<w:(t|tab|br|cr)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1];
    if (tag === "t") out += m[2] ?? "";
    else if (tag === "tab") out += "\t";
    else out += "\n"; // br / cr
  }
  return decodeEntities(out);
}

/** 按文档流顺序切出 body 级 <w:p> 与 <w:tbl> 块（嵌套表格按深度配对，不会截断） */
function extractBlocks(xml: string): Array<{ kind: "p" | "tbl"; start: number; end: number }> {
  const blocks: Array<{ kind: "p" | "tbl"; start: number; end: number }> = [];
  const openRe = /<w:(p|tbl)\b[^>]*>/g;
  const closeRe = /<\/w:(p|tbl)>/g;
  const tokens: Array<{ pos: number; kind: "open" | "close"; tag: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml)) !== null) tokens.push({ pos: m.index, kind: "open", tag: m[1] });
  while ((m = closeRe.exec(xml)) !== null) tokens.push({ pos: m.index, kind: "close", tag: m[1] });
  tokens.sort((a, b) => a.pos - b.pos);

  const stack: string[] = [];
  let blockStart = -1;
  let blockKind = "";
  for (const t of tokens) {
    if (stack.length === 0 && t.kind === "open") {
      blockStart = t.pos;
      blockKind = t.tag === "p" ? "p" : "tbl";
      stack.push(t.tag);
    } else if (t.kind === "open") {
      stack.push(t.tag);
    } else if (t.kind === "close" && stack.length > 0) {
      const expected = stack.pop();
      if (expected !== t.tag) {
        // 配对异常（畸形 XML）：回退为按原栈继续，容错处理
        stack.push(expected as string);
        continue;
      }
      if (stack.length === 0 && blockStart >= 0) {
        blocks.push({ kind: blockKind as "p" | "tbl", start: blockStart, end: t.pos + `</w:${t.tag}>`.length });
      }
    }
  }
  return blocks;
}

// ---------- 主解析 ----------

export interface DocxParseResult {
  markdown: string;
  media: number;
  drawings: number;
  textboxes: string[];
  headers: string[];
  isOle: boolean;
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function parseDocx(path: string): DocxParseResult {
  const buf = readFileSync(path);
  // .doc 旧格式（OLE 复合文档）直接标记，由主脚本走 Word/LibreOffice 转换路径
  if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)) {
    return { markdown: "", media: 0, drawings: 0, textboxes: [], headers: [], isOle: true };
  }

  let zip: ReturnType<typeof readZip>;
  try {
    zip = readZip(buf);
  } catch (e) {
    throw new Error(
      `无法解析 docx（可能已损坏或实为 .doc 旧格式）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let xml: string;
  try {
    xml = zip.get("word/document.xml").toString("utf-8");
  } catch {
    throw new Error("docx 中缺少 word/document.xml（文件可能损坏）");
  }

  // 视觉内容探测
  const media = [...zip.entries.keys()].filter((n) => n.startsWith("word/media/")).length;
  const drawings =
    (xml.match(/<w:drawing\b/g) ?? []).length +
    (xml.match(/<w:pict\b/g) ?? []).length +
    (xml.match(/<w:object\b/g) ?? []).length;

  // 正文块（段落 + 表格，按文档流顺序）
  const lines: string[] = [];
  for (const b of extractBlocks(xml)) {
    const frag = xml.slice(b.start, b.end);
    if (b.kind === "p") {
      const pPr = frag.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/)?.[1] ?? "";
      const styleName = pPr.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? "";
      const text = extractText(frag);
      if (!text.trim()) continue;
      const lower = styleName.toLowerCase();
      if (lower.startsWith("heading")) {
        const lv = lower.slice("heading".length).trim();
        const level = /^\d+$/.test(lv) ? Math.min(parseInt(lv, 10), 6) : 1;
        lines.push("#".repeat(level) + " " + text);
      } else if (lower === "title") {
        lines.push("# " + text);
      } else if (lower.includes("list") || lower.includes("bullet")) {
        lines.push("- " + text);
      } else {
        lines.push(text);
      }
    } else {
      // 表格 → Markdown（单元格内段落以换行拼接）
      const rows: string[][] = [];
      const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let tr: RegExpExecArray | null;
      while ((tr = trRe.exec(frag)) !== null) {
        const cells: string[] = [];
        const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let tc: RegExpExecArray | null;
        while ((tc = tcRe.exec(tr[1])) !== null) {
          const cellXml = tc[1].replace(/<\/w:p>/g, "</w:p>\n");
          cells.push(extractText(cellXml).replace(/\s*\n\s*/g, "\n").replace(/\|/g, "\\|").trim());
        }
        rows.push(cells);
      }
      if (rows.length === 0) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const padded = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
      lines.push("| " + padded[0].join(" | ") + " |");
      lines.push("| " + Array(width).fill("---").join(" | ") + " |");
      for (const row of padded.slice(1)) lines.push("| " + row.join(" | ") + " |");
    }
  }

  // 文本框内容（w:txbxContent）
  const textboxes: string[] = [];
  const txbRe = /<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g;
  let txb: RegExpExecArray | null;
  while ((txb = txbRe.exec(xml)) !== null) {
    const t = extractText(txb[1]).trim();
    if (t) textboxes.push(t);
  }

  // 页眉页脚
  const headers: string[] = [];
  for (const name of [...zip.entries.keys()]) {
    const hm = name.match(/^word\/(header|footer)\d*\.xml$/);
    if (!hm) continue;
    try {
      const t = extractText(zip.get(name).toString("utf-8")).trim();
      if (t) headers.push(`${hm[1] === "header" ? "页眉" : "页脚"}: ${t}`);
    } catch {
      // 单个页眉损坏不阻断整体解析
    }
  }

  return { markdown: lines.join("\n"), media, drawings, textboxes, headers, isOle: false };
}

/** 抽取 docx 中全部嵌入图片（word/media/*），供 Word 降级链的"图片直抽"路径使用 */
export function extractDocxMedia(path: string): Array<{ name: string; data: Buffer }> {
  const buf = readFileSync(path);
  const zip = readZip(buf);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const name of [...zip.entries.keys()]) {
    if (!name.startsWith("word/media/")) continue;
    try {
      out.push({ name: name.split("/").pop() ?? name, data: zip.get(name) });
    } catch {
      // 单个图片损坏则跳过，不阻断其余
    }
  }
  return out;
}
