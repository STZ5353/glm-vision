#!/usr/bin/env bun
/**
 * glm-vision.ts — 视觉之眼 v2.1 核心脚本
 *
 * 读取本地图片 / PDF / Word / 图片 URL → 调用智谱 GLM 视觉模型（默认免费的 glm-4.6v-flash）
 * → 输出结构化文字描述。零 npm 依赖，仅需 bun 运行时（三平台通用）。
 *
 * v2.0 相对 v1.2 的变更：
 *   - 全链零安装零联网：PDF 渲染改为内置 mupdf-wasm（render-pdf.js），
 *     Word 文本解析改为纯 TS（docx-parse.ts），移除 uv/Python 依赖
 *   - 新增 Word（三级降级链）、多图对比（compare）、SVG 源码分析、图片 URL 直传
 *   - 新增免费模型自动降级链（429 时沿链切换）+ 按模型能力表开关深度思考
 *   - 新增像素尺寸预检（≤6000x6000，官方硬限制）、GLM_VISION_BASE_URL（可换 OpenAI
 *     兼容端点或本地 mock 测试）
 *   - 移除全部策略性数量上限（5图/3PDF/20页），仅保留 API 物理限制预检与警告
 *   - 断点续跑缓存集中到技能目录 .cache/，key 含文件 mtime/size，内容变化自动失效
 *
 * 用法:
 *   bun glm-vision.ts 图.png                     # auto 模式（默认，按扩展名路由）
 *   bun glm-vision.ts detail 图.png [图2.png...] # 详细描述（逐张独立识别）
 *   bun glm-vision.ts compare a.png b.png       # 多图同请求对比（含 URL 可混用）
 *   bun glm-vision.ts ocr 截图.png              # OCR 文字提取
 *   bun glm-vision.ts analyze 图表.png          # 图表/数据深度分析
 *   bun glm-vision.ts prompt 插画.jpg           # 反推 AI 绘画提示词
 *   bun glm-vision.ts pdf 文档.pdf              # PDF 逐页识别（断点续跑）
 *   bun glm-vision.ts docx 报告.docx            # Word 三级降级链
 *   bun glm-vision.ts detail 图.png --question "图里有几辆车？"
 *   bun glm-vision.ts pdf 文档.pdf --parallel 2 # 并发识别（免费版限流风险自负）
 *   bun glm-vision.ts 文档.pdf --save           # 结果另存 <文件名>.vision.md
 *
 * 深度思考: glm-4.6v-flash 官方支持。默认 detail/analyze/pdf/docx/compare 开启、
 *   ocr/prompt/svg 关闭；--think / --no-think 显式覆盖。
 *   降级到不支持 thinking 的模型（如 glm-4v-flash）时自动省略该参数。
 *
 * API Key 读取优先级（命中即止，惰性解析——纯文本 Word 路径无需 Key）:
 *   1. 命令行 --api-key 参数（不推荐，会留在 shell 历史）
 *   2. 环境变量 ZHIPU_API_KEY
 *   3. 环境变量 GLM_API_KEY
 *   4. 脚本同目录 .glm-vision.json   内容: {"apiKey": "你的Key"}
 *   5. 用户主目录 ~/.glm-vision.json
 */
import {
  readFileSync, writeFileSync, existsSync, statSync,
  mkdtempSync, rmSync, mkdirSync,
} from "node:fs";
import { dirname, join, extname, basename, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "bun";
import { parseDocx, extractDocxMedia } from "./docx-parse.ts";

const BUN = process.execPath || "bun";
const SKILL_DIR = dirname(import.meta.path);
const DEFAULT_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const API_URL = process.env.GLM_VISION_BASE_URL || DEFAULT_API_URL;
const MODEL = process.env.GLM_VISION_MODEL || "glm-4.6v-flash";
const FALLBACK = (process.env.GLM_VISION_FALLBACK ?? "glm-4v-flash,glm-4.6v-flashx")
  .split(",").map((s) => s.trim()).filter(Boolean);
const NO_THINK_MODELS = new Set(
  (process.env.GLM_VISION_NO_THINK_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const API_TIMEOUT = Number(process.env.GLM_VISION_TIMEOUT) || 180_000; // 思考+长输出较慢
const WORD_TIMEOUT = 90_000;   // Word COM 转换最长 90 秒
const OFFICE_TIMEOUT = 120_000; // LibreOffice 转换最长 120 秒
const MAX_TOKENS_ENV = Number(process.env.GLM_VISION_MAX_TOKENS) || 0;

// API 物理限制（不可放开）：单图 base64 后 ≤5M（base64 膨胀约 1.33 倍，原始 >5MB 必超限）、
// 像素 ≤6000x6000。策略性数量上限已在 v2.0 按用户决定全部移除。
const WARN_SIZE_MB = 3.5;
const REJECT_SIZE_MB = 5;
const MAX_PIXELS = 6000;
const COMPARE_TOTAL_MB = 20;   // compare 模式总 base64 体积警告阈值
const CACHE_DIR = process.env.GLM_VISION_CACHE_DIR || join(SKILL_DIR, ".cache");
const CACHE_SUFFIX = ".json";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const WORD_EXTS = new Set([".docx", ".doc"]);
const ALLOWED_EXT = new Set([...IMAGE_EXT, ".svg", ".pdf", ...WORD_EXTS]);
const URL_RE = /^https?:\/\//i;

// ---------- 模型能力表 ----------
// thinking: 是否支持 thinking 参数（不支持则完全省略该字段，比发送 disabled 更安全）
// maxTokens: 该模型输出上限（glm-4v-flash 仅 1024，超出报 400 错误码 1210）
const MODEL_CAP: Record<string, { thinking: boolean; maxTokens: number }> = {
  "glm-4.6v-flash": { thinking: true, maxTokens: 8192 },
  "glm-4v-flash": { thinking: false, maxTokens: 1024 },
  "glm-4.6v-flashx": { thinking: true, maxTokens: 8192 },
};
const CAP_DEFAULT = { thinking: true, maxTokens: 8192 };

// ---------- 模式定义（prompt / 温度 / 思考默认） ----------
const PROMPTS: Record<string, string> = {
  detail: `你是一名专业的图像分析专家。请对这张图片进行尽可能详细、完整的描述，供一个没有视觉能力的人理解图片。要求：
1. 先一句话判定图片类型（照片/截图/流程图/架构图/图表/表格/绘画/其他）。
2. 若是流程图、架构图、示意图等结构化图形：逐个节点描述，明确节点之间的连接关系、箭头方向、层级结构、数据流或控制流，不要遗漏任何文字标注。
3. 逐字提取图中出现的所有文字（含代码、命令、数字、标注），代码和命令必须原样保留。
4. 描述布局、颜色、风格等视觉特征。
5. 若存在你无法确定的内容，明确写"无法确定"，禁止编造。
请用中文回答。`,
  ocr: `请对这张图片执行 OCR 文字提取。要求：
1. 逐字提取图中所有文字，包括标题、正文、标注、水印、代码、数字。
2. 保持原始排版结构（段落、换行、列表、表格行列），代码块用代码格式原样输出。
3. 按阅读顺序（从上到下、从左到右）排列。
4. 识别不清晰的地方用 [不清晰] 标注，禁止猜测补全。
请只输出提取的文字内容本身。`,
  analyze: `你是一名专业的数据分析师。请对这张图片进行深度分析。要求：
1. 若包含图表/数据：提取全部可见数据点、坐标轴含义、单位、图例，并转写为 Markdown 表格。
2. 分析数据反映的趋势、异常点、关键结论。
3. 若包含公式：原样转写公式并解释各符号含义。
4. 提取图中所有文字，并说明图片的整体结构与布局。
5. 对无法确定的数值标注 [数值不确定]，禁止编造。
请用中文回答。`,
  prompt: `请对这张图片执行 Image2Prompt 分析：深度解读画面内容、主体、构图、光影、色彩、风格、质感，反向生成可直接用于 AI 绘画工具（如 Midjourney / Stable Diffusion）的高质量提示词。要求：
1. 先用中文详细描述画面内容与风格特征。
2. 输出一段英文提示词（主体+细节+风格+光照+镜头+画质词）。
3. 输出一段中文提示词。
4. 附风格关键词建议。`,
  compare: `你是一名专业的图像分析专家。请对比分析这批图片（共 {count} 张），供一个没有视觉能力的人理解。要求：
1. 按顺序逐张简要描述（编号：图1、图2……）。
2. 从内容、结构、布局、颜色、风格等维度列出它们的相同点与不同点。
3. 逐字提取每张图中出现的所有文字（标注所属图号）。
4. 若存在你无法确定的内容，明确写"无法确定"，禁止编造。
请用中文回答。`,
  pdf: `你是一名专业的文档图像分析专家。这是从 PDF 文档渲染出的第 {page}/{total} 页（图像形式）。请：
1. 先一句话概括本页的主要内容与版式类型（正文/表格/图表/扫描件/照片/图文混排）。
2. 详细描述本页中的图片、图表、示意图的内容。
3. 逐字提取本页所有文字，表格转写为 Markdown 表格，公式原样转写，代码原样保留。
4. 保持版式顺序（从上到下、从左到右），分栏内容按栏呈现。
5. 无法确定的内容写"无法确定"，禁止编造。
请用中文回答。`,
  docx: `你是一名专业的文档图像分析专家。这是从 Word 文档转换渲染出的第 {page}/{total} 页（图像形式）。请：
1. 先一句话概括本页的主要内容与版式类型（正文/表格/图表/图片/图文混排）。
2. 详细描述本页中的图片、图表、示意图的内容。
3. 逐字提取本页所有文字，表格转写为 Markdown 表格，公式原样转写，代码原样保留。
4. 保持版式顺序（从上到下、从左到右），分栏内容按栏呈现。
5. 无法确定的内容写"无法确定"，禁止编造。
请用中文回答。`,
  svg: `请分析以下 SVG 源码。要求：
1. 说明渲染后的视觉外观：形状、颜色、布局、尺寸关系。
2. 逐字提取其中所有文字内容（含 text/tspan 节点）。
3. 若是流程图/图标类图形，描述各元素之间的连接与层级关系。
4. 无法确定的内容写"无法确定"，禁止编造。
请用中文回答。SVG 源码如下：`,
};

const MODE_DEFS: Record<string, { temperature: number; think: boolean }> = {
  detail: { temperature: 0.4, think: true },
  ocr: { temperature: 0.1, think: false },
  analyze: { temperature: 0.3, think: true },
  prompt: { temperature: 0.9, think: false },
  compare: { temperature: 0.3, think: true },
  pdf: { temperature: 0.2, think: true },
  docx: { temperature: 0.2, think: true },
  svg: { temperature: 0.2, think: false },
};

// ---------- 工具 ----------
function fail(msg: string, code = 1): never {
  console.error(`[glm-vision] 错误: ${msg}`);
  process.exit(code);
}

function printHelp(): void {
  console.log(`视觉之眼 v2.1 · 智谱 GLM 视觉桥接脚本（图片/PDF/Word/URL，跨平台零安装）
用法: bun glm-vision.ts [模式] 文件路径或URL... [选项]

模式:
  auto     自动路由（默认）：按扩展名选择处理管线
  detail   图片详细描述：类型判定、结构化图形逐节点、逐字文字提取
  ocr      图片文字提取：逐字 OCR，保留排版
  analyze  图片深度分析：图表数据转表格、趋势分析、公式解读
  prompt   反推提示词：Image2Prompt，输出中英文绘画提示词
  compare  多图对比：全部图片放入同一请求由模型直接对比（支持 URL 混用）
  pdf      PDF 文档：内置 mupdf-wasm 逐页渲染后识别（断点续跑）
  docx     Word 文档：文本解析优先（零 API），含图时三级降级链
  svg      SVG 源码分析（文本请求，零图片上传）

输入: 图片 png/jpg/jpeg/webp/gif/bmp（单张原始 ≤5MB、像素 ≤6000x6000 为 API 硬限制），
      PDF 任意页数（断点续跑可分批续传），Word .docx/.doc，图片 http(s) URL
选项:
  --question/-q "问题"  自定义提问，覆盖默认 prompt
  --think / --no-think  强制开/关深度思考（默认按模式）
  --temperature T       覆盖模式默认温度
  --force               忽略缓存，全量重新识别 PDF
  --fast                PDF 文本层直抽：纯文字页零 API 秒出，含图/矢量/乱码页自动走视觉（仅对 pdf 管线生效）
  --parallel N          并发识别页数（默认 1，免费版限流风险自负）
  --save                结果另存为 <文件名>.vision.md
  --api-key KEY         临时指定 Key（不推荐，会留在 shell 历史）
  --help                查看帮助
Key 优先级: --api-key > ZHIPU_API_KEY > GLM_API_KEY > .glm-vision.json > ~/.glm-vision.json
环境变量: GLM_VISION_MODEL / GLM_VISION_FALLBACK / GLM_VISION_BASE_URL /
          GLM_VISION_MAX_TOKENS / GLM_VISION_TIMEOUT / GLM_VISION_NO_THINK_MODELS /
          GLM_VISION_CACHE_DIR（缓存目录）`);
}

interface Args {
  mode: string;
  paths: string[];       // 本地文件
  urls: string[];        // http(s) URL（按出现顺序与 paths 合并处理）
  question: string;
  apiKey: string;
  think: boolean | null;
  force: boolean;
  fast: boolean;         // PDF 文本层直抽（零 API 路由，见 processPdf）
  save: boolean;
  parallel: number;
  temperature: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    mode: "auto", paths: [], urls: [], question: "", apiKey: "",
    think: null, force: false, fast: false, save: false, parallel: 1, temperature: 0,
  };
  const MODES = new Set(["auto", "detail", "ocr", "analyze", "prompt", "compare", "pdf", "docx", "svg"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key") { out.apiKey = argv[++i] ?? ""; continue; }
    if (a === "--question" || a === "-q") { out.question = argv[++i] ?? ""; continue; }
    if (a === "--think") { out.think = true; continue; }
    if (a === "--no-think") { out.think = false; continue; }
    if (a === "--force") { out.force = true; continue; }
    if (a === "--fast") { out.fast = true; continue; }
    if (a === "--save") { out.save = true; continue; }
    if (a === "--parallel") { out.parallel = Math.max(1, Math.min(8, parseInt(argv[++i] ?? "1", 10) || 1)); continue; }
    if (a === "--temperature") { out.temperature = parseFloat(argv[++i] ?? "0"); continue; }
    if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    if (a.startsWith("--")) fail(`未知参数: ${a}`, 2);
    if (MODES.has(a)) { out.mode = a; continue; }
    if (URL_RE.test(a)) out.urls.push(a);
    else out.paths.push(a);
  }
  return out;
}

// ---------- API Key（惰性解析：纯文本 Word 路径零 API 调用，无需 Key） ----------
let keyCache: string | null = null;
function resolveApiKey(cliKey: string): string {
  if (keyCache !== null) return keyCache;
  if (cliKey) return (keyCache = cliKey);
  if (process.env.ZHIPU_API_KEY) return (keyCache = process.env.ZHIPU_API_KEY);
  if (process.env.GLM_API_KEY) return (keyCache = process.env.GLM_API_KEY);
  const candidates = [join(SKILL_DIR, ".glm-vision.json"), join(homedir(), ".glm-vision.json")];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const cfg = JSON.parse(readFileSync(p, "utf-8"));
        if (typeof cfg?.apiKey === "string" && cfg.apiKey.trim()) return (keyCache = cfg.apiKey.trim());
      }
    } catch { /* 配置损坏则跳过，继续尝试下一来源 */ }
  }
  fail(
    "未找到 API Key。请通过以下任一方式提供：\n" +
    "  1) 环境变量 ZHIPU_API_KEY 或 GLM_API_KEY\n" +
    '  2) 脚本同目录 .glm-vision.json，内容 {"apiKey": "你的Key"}\n' +
    "  3) 用户主目录 ~/.glm-vision.json\n" +
    "  4) 命令行 --api-key 参数（不推荐，会留在 shell 历史）",
    2,
  );
}

// ---------- 像素尺寸预检（读文件头，零依赖） ----------
function readImageDims(path: string): { w: number; h: number } | null {
  const b = readFileSync(path);
  if (b.length < 26) return null;
  // PNG: 签名 8B + 长度 4B + "IHDR" 4B + 宽 4B + 高 4B
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // JPEG: 扫描 SOFn 段
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 10 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return null; // 图像数据开始/结束仍未找到 SOF
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  // GIF
  if (b.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
  }
  // WebP（VP8X / VP8L / VP8 三种容器）
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") {
    const fourcc = b.subarray(12, 16).toString("ascii");
    if (fourcc === "VP8X" && b.length >= 30) {
      return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (fourcc === "VP8L" && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8 " && b.length >= 30) {
      return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
  }
  return null; // 无法读取尺寸则跳过像素检查
}

/** 预检本地文件：存在性、扩展名白名单、0 字节、大小、像素。超限即拒绝并给指引。 */
function precheckFiles(paths: string[]): void {
  for (const p of paths) {
    if (!existsSync(p)) fail(`文件不存在: ${p}。请检查路径拼写，确认文件已放入工作目录。`);
    if (!statSync(p).isFile()) fail(`不是普通文件: ${p}。`);
    const size = statSync(p).size;
    if (size === 0) fail(`文件为空 (0 字节): ${p}。文件可能损坏或未保存完成。`);
    const ext = extname(p).toLowerCase();
    if (!ALLOWED_EXT.has(ext))
      fail(`不支持的格式 "${ext}": ${p}。支持: ${[...ALLOWED_EXT].join(" / ")}（图片另支持 http(s) URL）。`);
    const sizeMB = size / 1024 / 1024;
    if (ext === ".pdf") {
      if (sizeMB > 100)
        console.warn(`[glm-vision] 警告: ${p} 为 ${sizeMB.toFixed(1)}MB，逐页渲染可能耗时较长。`);
      continue;
    }
    if (ext === ".svg") {
      if (sizeMB > 1) fail(`${p} 为 ${sizeMB.toFixed(1)}MB，SVG 源码分析上限 1MB。请简化或转 PNG 后重试。`);
      continue;
    }
    if (IMAGE_EXT.has(ext)) {
      const dims = readImageDims(p);
      const longSide = dims ? Math.max(dims.w, dims.h) : 0;
      if (longSide > MAX_PIXELS)
        fail(
          `${p} 像素 ${dims?.w}x${dims?.h} 超过 API 上限 ${MAX_PIXELS}x${MAX_PIXELS}。` +
          "请缩小分辨率后重试（超长截图建议分段截取）。",
        );
      if (sizeMB > REJECT_SIZE_MB)
        fail(
          `${p} 大小 ${sizeMB.toFixed(1)}MB，超过 ${REJECT_SIZE_MB}MB 上限（官方限制 base64 后 ≤5M）。` +
          "请压缩后再试（缩小分辨率、转为 JPEG/WebP）。",
        );
      if (sizeMB > WARN_SIZE_MB)
        console.warn(
          `[glm-vision] 警告: ${p} 为 ${sizeMB.toFixed(1)}MB，base64 编码后接近 API 的 5M 限制，若失败请压缩后重试。`,
        );
    }
  }
}

// ---------- 错误分类 ----------
function classifyError(status: number, raw: string): string {
  let msg = "";
  try { msg = JSON.parse(raw)?.error?.message ?? ""; } catch { msg = raw.slice(0, 300); }
  if (status === 401 || status === 403)
    return `API Key 无效或未授权 (HTTP ${status})。请检查 Key 是否拼写正确、所属项目是否开通了模型权限。`;
  if (status === 402)
    return "账户余额不足 (HTTP 402)。请充值后重试（免费模型一般不会遇到）。";
  if (status === 429 || /1302|1305|rate.?limit|限流|速率限制/i.test(raw))
    return "请求被限流（智谱按账户动态并发限流，免费版高峰时段更严格）。请稍后重试；PDF 直接重跑同一命令即可自动续跑补齐失败页。";
  if (status === 413 || /size|too large|图片.{0,6}(大小|过大|超限)/i.test(raw))
    return `图片超过 API 大小限制 (HTTP ${status})。请压缩图片（长边缩至 2000px 内或转 JPEG/WebP）后重试。`;
  if (status === 400)
    return `请求参数错误 (HTTP 400): ${msg}。若涉及模型或参数问题，请确认 GLM_VISION_MODEL 与 GLM_VISION_BASE_URL 匹配。`;
  return `API 错误 (HTTP ${status}): ${msg}`;
}

// ---------- API 调用（含模型降级链） ----------
interface ApiResult { content: string; reasoning: string; tokens: number; model: string; finish: string; }

function capOf(model: string): { thinking: boolean; maxTokens: number } {
  const cap = MODEL_CAP[model] ?? { ...CAP_DEFAULT };
  if (NO_THINK_MODELS.has(model)) cap.thinking = false;
  return cap;
}

function extractContent(data: unknown): { content: string; reasoning: string; tokens: number; finish: string } {
  const d = data as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }>;
    usage?: { total_tokens?: number };
  };
  const msg = d.choices?.[0]?.message ?? {};
  let content = "(模型返回了空内容)";
  if (typeof msg.content === "string") content = msg.content;
  else if (Array.isArray(msg.content))
    content = msg.content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n") || content;
  return {
    content,
    reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
    tokens: d.usage?.total_tokens ?? 0,
    finish: d.choices?.[0]?.finish_reason ?? "stop",
  };
}

/** 致命 API 错误（401/403/402/413 等换模型无意义的 4xx）：上抛后终止整个降级链 */
class FatalApiError extends Error {}

/**
 * 单模型调用（含退避重试）。images: 本地路径/URL 组成的图片列表（空 = 纯文本请求）。
 * 返回 null 表示该模型不可用（限流/服务器错误/超时），降级链尝试下一候选。
 */
async function callApiOnce(
  apiKey: string, model: string, images: Array<string | { path: string; b64: string }>,
  promptText: string, think: boolean, temperature: number, maxTokens: number,
): Promise<ApiResult | null> {
  const content: Array<Record<string, unknown>> = [];
  for (const img of images) {
    if (typeof img === "string") content.push({ type: "image_url", image_url: { url: img } });
    else content.push({ type: "image_url", image_url: { url: img.b64 } });
  }
  content.push({ type: "text", text: promptText });

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content }],
    max_tokens: maxTokens,
    temperature,
  };
  const cap = capOf(model);
  if (cap.thinking) body.thinking = { type: think ? "enabled" : "disabled" };

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT),
      });
      const raw = await resp.text();
      if (resp.ok) {
        let data: unknown;
        try { data = JSON.parse(raw); } catch { throw new Error("API 返回了非 JSON 响应"); }
        return { ...extractContent(data), model };
      }
      lastErr = classifyError(resp.status, raw);
      // 限流/服务器错误：退避重试；400（模型参数类）：交给降级链；其余 4xx 为致命错误（换模型无意义）
      if (resp.status === 429 || resp.status >= 500) continue;
      if (resp.status === 400) break;
      throw new FatalApiError(lastErr);
    } catch (e) {
      if (e instanceof FatalApiError) throw e;
      // 网络错误 / 超时 / 非 JSON 响应 → 退避重试
      lastErr = `网络错误或超时: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  console.warn(`[glm-vision] 模型 ${model} 不可用: ${lastErr}（尝试降级链中下一个模型...）`);
  return null;
}

async function callApiWithFallback(
  apiKey: string, images: Array<string | { path: string; b64: string }>,
  promptText: string, think: boolean, temperature: number,
): Promise<ApiResult> {
  const candidates = [MODEL, ...FALLBACK.filter((m) => m !== MODEL)];
  let lastErr = "";
  for (const cand of candidates) {
    const cap = capOf(cand);
    const maxTokens = MAX_TOKENS_ENV || cap.maxTokens;
    const r = await callApiOnce(apiKey, cand, images, promptText, think && cap.thinking, temperature, maxTokens);
    if (r) return r;
    lastErr = `模型 ${cand} 重试后仍不可用`;
  }
  throw new Error(`所有候选模型（${candidates.join(" → ")}）均不可用。${lastErr}。请稍后重试；PDF 可稍后重跑自动续跑。`);
}

// ---------- 深度思考确认行（首调后打印一次） ----------
let thinkingReported = false;
function reportThinking(r: ApiResult, thinkRequested: boolean): void {
  if (thinkingReported || !thinkRequested) return;
  thinkingReported = true;
  const cap = capOf(r.model);
  if (!cap.thinking) {
    console.log(`深度思考: 当前模型 ${r.model} 不支持思考模式，已自动省略思考参数。`);
    return;
  }
  if (r.reasoning.length > 0) {
    console.log(`深度思考: 已开启（本次返回思考内容 ${r.reasoning.length} 字，已从输出中剥离）`);
  } else {
    console.warn(`深度思考: 响应中未检测到思考内容，模型 ${r.model} 可能未启用思考模式，结果质量或受影响。`);
  }
}

// ---------- 图片加载（本地→base64；URL 原样） ----------
function loadImages(
  items: Array<{ path?: string; url?: string }>,
): Array<string | { path: string; b64: string }> {
  const out: Array<string | { path: string; b64: string }> = [];
  for (const it of items) {
    if (it.url) out.push(it.url);
    else if (it.path) {
      const b64 = readFileSync(it.path as string).toString("base64");
      out.push({ path: it.path as string, b64 });
    }
  }
  const totalMB = out.reduce((s, x) => s + (typeof x === "string" ? 0 : x.b64.length * 0.75 / 1024 / 1024), 0);
  if (totalMB > COMPARE_TOTAL_MB)
    console.warn(`[glm-vision] 警告: 本批次图片 base64 总体积约 ${totalMB.toFixed(1)}MB，请求可能超限或响应缓慢。`);
  return out;
}

// ---------- PDF 管线 ----------
/** 提取 PDF 文本层与视觉元素统计（spawn pdf-text.js）；失败返回 null（回退全视觉） */
function extractPdfText(pdfPath: string): Array<{ text: string; images: number; vectors: number }> | null {
  try {
    const proc = spawnSync({
      cmd: [BUN, join(SKILL_DIR, "pdf-text.js"), pdfPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      const err = new TextDecoder().decode(proc.stderr).trim();
      console.warn(`[glm-vision] 文本层提取失败 (exit ${proc.exitCode}): ${err.slice(0, 200)}`);
      return null;
    }
    const lines = new TextDecoder().decode(proc.stdout).trim().split(/\r?\n/).filter(Boolean);
    return lines
      .map((l) => JSON.parse(l) as { page: number; text: string; images: number; vectors: number })
      .sort((a, b) => a.page - b.page);
  } catch (e) {
    console.warn(`[glm-vision] 文本层提取失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** --fast 路由：纯文字页可零 API 直抽；含栅格图/矢量图/文本过少（扫描件/空白）/乱码启发式 → 走视觉 */
function isTextOnlyPage(info: { text: string; images: number; vectors: number }): boolean {
  if (info.images > 0 || info.vectors > 0) return false;
  if (info.text.length < 30) return false;
  const replacement = (info.text.match(/�/g) ?? []).length;
  const control = (info.text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) ?? []).length;
  if (replacement > 3 || control / info.text.length > 0.005) return false;
  return true;
}

function renderPdf(pdfPath: string, tmpDir: string): string[] {
  const proc = spawnSync({
    cmd: [BUN, join(SKILL_DIR, "render-pdf.js"), pdfPath, tmpDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(
      `PDF 渲染失败 (exit ${proc.exitCode})：${err.slice(0, 500) || "未知原因"}\n` +
      "提示：加密 PDF 请先解除密码；文件损坏请重新导出。",
    );
  }
  const pages = new TextDecoder().decode(proc.stdout).trim().split(/\r?\n/).filter(Boolean);
  if (pages.length === 0) throw new Error("PDF 渲染完成但没有输出任何页面。PDF 可能没有可渲染内容。");
  return pages;
}

interface PdfCache {
  path: string; size: number; mtime: number;
  model: string; mode: string; question: string;
  total: number; pages: Record<string, string>;
}

function cachePathFor(pdfPath: string, stat: { size: number; mtimeMs: number }): string {
  const abs = resolve(pdfPath);
  // Bun.hash 为本地缓存键（非安全用途），碰撞概率可忽略，且仍带完整元数据校验
  const h = Bun.hash(`${abs}|${stat.size}|${Math.round(stat.mtimeMs)}`).toString(16);
  return join(CACHE_DIR, `${basename(abs)}.${h}${CACHE_SUFFIX}`);
}

function loadCache(pdfPath: string, mode: string, question: string): { path: string; cache: PdfCache } | null {
  const st = statSync(pdfPath);
  const p = cachePathFor(pdfPath, st);
  try {
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as PdfCache;
    const abs = resolve(pdfPath);
    if (raw && raw.pages && typeof raw.pages === "object" &&
        raw.path === abs && raw.size === st.size && raw.mtime === Math.round(st.mtimeMs) &&
        raw.model === MODEL && raw.mode === mode && raw.question === question) {
      return { path: p, cache: raw };
    }
  } catch { /* 缓存损坏视为无缓存 */ }
  return null;
}

function saveCache(p: string, cache: PdfCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[glm-vision] 警告: 缓存写入失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 并发池（按 --parallel 控制） */
async function runPool<T>(items: T[], n: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function processPdf(
  pdfPath: string, mode: string, promptTemplate: string, question: string,
  think: boolean, temperature: number,
  force: boolean, parallel: number, writeCache: boolean, fast: boolean,
  getKey: () => string, tag: string, emit: (s: string) => void,
): Promise<{ ok: boolean; tokens: number }> {
  emit(`\n${tag} · PDF 逐页识别${fast ? "（--fast 文本直抽路由）" : ""}`);
  const tmpDir = mkdtempSync(join(tmpdir(), "glm-vision-pdf-"));
  let tokens = 0;
  try {
    const fastInfo = fast ? extractPdfText(pdfPath) : null;
    if (fast && fastInfo === null) emit("▸ 文本层提取失败，已回退为全视觉识别。");
    if (fastInfo && fastInfo.length > 0 && fastInfo.every((p) => isTextOnlyPage(p))) {
      emit(`▸ 共 ${fastInfo.length} 页均为纯文字页，文本层直抽（零 API，无需渲染）...`);
      fastInfo.forEach((p, idx) => {
        emit(`[第 ${idx + 1}/${fastInfo.length} 页 · 文本层直抽]`);
        emit(p.text || "(本页无可提取文字)");
      });
      return { ok: true, tokens: 0 };
    }
    emit("▸ 渲染中（内置 mupdf-wasm，约 144dpi）...");
    const pages = renderPdf(pdfPath, tmpDir);

    // 断点缓存：命中页跳过 API；--force 或文件内容变化（size/mtime）自动失效
    let cachePath = "";
    let pagesCache: Record<string, string> = {};
    if (!force) {
      const lc = loadCache(pdfPath, mode, question);
      if (lc) { cachePath = lc.path; pagesCache = { ...lc.cache.pages }; }
    }
    const cachedBefore = Object.keys(pagesCache).length;
    if (cachedBefore > 0) emit(`▸ 断点续跑：已缓存 ${cachedBefore}/${pages.length} 页，命中页将跳过 API 调用。`);
    emit(`▸ 共 ${pages.length} 页，开始逐页识别（并发 ${parallel}）...`);

    const st = statSync(pdfPath);
    let ok = 0;
    const pageResults = new Map<number, string>();
    await runPool(pages, parallel, async (pagePath, idx) => {
      const pageNo = String(idx + 1);
      if (fastInfo && fastInfo[idx] && isTextOnlyPage(fastInfo[idx])) {
        emit(`[第 ${idx + 1}/${pages.length} 页 · 文本层直抽]\n${fastInfo[idx].text}`);
        pageResults.set(idx, fastInfo[idx].text);
        ok++;
        return;
      }
      if (pagesCache[pageNo]) {
        emit(`[第 ${idx + 1}/${pages.length} 页${fastInfo ? " · 视觉识别" : ""}]（命中缓存，跳过 API 调用）\n${pagesCache[pageNo]}`);
        pageResults.set(idx, pagesCache[pageNo]);
        ok++;
        return;
      }
      emit(`[第 ${idx + 1}/${pages.length} 页${fastInfo ? " · 视觉识别" : ""}]`);
      try {
        const b64 = readFileSync(pagePath).toString("base64");
        const prompt = (question || promptTemplate)
          .replaceAll("{page}", pageNo)
          .replaceAll("{total}", String(pages.length));
        const r = await callApiWithFallback(getKey(), [{ path: pagePath, b64 }], prompt, think, temperature);
        reportThinking(r, think);
        emit(r.content);
        if (r.finish === "length") emit("[glm-vision] 警告: 本页输出达到长度上限被截断。");
        tokens += r.tokens;
        pagesCache[pageNo] = r.content;
        pageResults.set(idx, r.content);
        ok++;
      } catch (e) {
        emit(`  本页识别失败: ${e instanceof Error ? e.message : String(e)}`);
        emit("  已跳过本页，继续识别其余页面。（失败页未缓存，下次重跑自动续跑）");
      }
    });

    if (writeCache && !cachePath) cachePath = cachePathFor(pdfPath, st);
    if (writeCache && Object.keys(pagesCache).length > 0) {
      saveCache(cachePath, {
        path: resolve(pdfPath), size: st.size, mtime: Math.round(st.mtimeMs),
        model: MODEL, mode, question, total: pages.length, pages: pagesCache,
      });
      emit(`\n▸ 本 PDF 累计缓存 ${Object.keys(pagesCache).length}/${pages.length} 页 → ${cachePath}`);
    }
    return { ok: ok > 0, tokens };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true }); // 无论成败都清理临时渲染文件
  }
}

// ---------- Word 管线（三级降级链） ----------
function convertViaWordCom(src: string, tmpDir: string): string | null {
  if (process.platform !== "win32") return null;
  const psScript = join(SKILL_DIR, "docx2pdf.ps1");
  const dst = join(tmpDir, basename(src, extname(src)) + ".pdf");
  let proc;
  try {
    proc = spawnSync({
      cmd: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript, resolve(src), dst],
      stdout: "pipe",
      stderr: "pipe",
      timeout: WORD_TIMEOUT,
    });
  } catch {
    return null; // 无 PowerShell（极端环境），走下一级
  }
  if (proc.exitCode === null) {
    try { spawnSync({ cmd: ["taskkill", "/F", "/IM", "WINWORD.EXE"], stdout: "pipe", stderr: "pipe" }); } catch { /* 忽略 */ }
    console.warn("[glm-vision] Word 转换超时，已强制结束 Word 进程。");
    return null;
  }
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    console.warn(`[glm-vision] Word COM 转换失败: ${err.slice(0, 300) || "未知原因"}`);
    return null;
  }
  return existsSync(dst) ? dst : null;
}

function convertViaLibreOffice(src: string, tmpDir: string): string | null {
  const dst = join(tmpDir, basename(src, extname(src)) + ".pdf");
  for (const exe of ["soffice", "libreoffice"]) {
    let proc;
    try {
      proc = spawnSync({
        cmd: [exe, "--headless", "--convert-to", "pdf", "--outdir", tmpDir, resolve(src)],
        stdout: "pipe",
        stderr: "pipe",
        timeout: OFFICE_TIMEOUT,
      });
    } catch {
      continue; // 该命令不存在，试下一个
    }
    if (proc.exitCode !== null && proc.exitCode === 0 && existsSync(dst)) return dst;
    if (proc.exitCode === null) console.warn(`[glm-vision] ${exe} 转换超时，已跳过。`);
  }
  return null;
}

async function processWord(
  path: string, question: string, think: boolean, temperature: number,
  getKey: () => string, tag: string, emit: (s: string) => void,
): Promise<{ ok: boolean; tokens: number }> {
  const ext = extname(path).toLowerCase();
  let markdown = "";
  let media = 0;
  let drawings = 0;
  let isOle = false;
  const extras: string[] = [];

  if (ext === ".docx") {
    const j = parseDocx(path);
    ({ markdown, media, drawings, isOle } = j);
    for (const t of j.textboxes) extras.push(`(文本框) ${t}`);
    extras.push(...j.headers);
  }

  // 双路径分流：纯文本文档直接输出，零 API 成本（无需 Key）
  if (ext === ".docx" && !isOle && media === 0 && drawings === 0) {
    emit(`\n${tag} · Word 文本解析（无嵌入图片/绘图元素，直接提取，零 API 成本）`);
    emit([markdown || "(正文为空——内容可能全部位于图片或图表中，可手动导出 PDF 后用 pdf 模式识别)", ...extras].join("\n"));
    return { ok: true, tokens: 0 };
  }

  const hasText = markdown.trim().length > 0;
  const visualDesc = ext === ".doc" ? "旧格式文档" : `含视觉内容（嵌入图片 ${media} 个/绘图元素 ${drawings} 个）`;
  emit(`\n${tag} · Word ${visualDesc} → 渲染后逐页识别`);

  // 渲染器降级链：Word COM（Windows）→ LibreOffice（全平台）→ 嵌入图片直抽（永远可用）
  // GLM_VISION_NO_CONVERT=1 可强制跳过转换、直达图片直抽（无 Office 环境或追求速度时用）
  const tmpDir = mkdtempSync(join(tmpdir(), "glm-vision-word-"));
  let tokens = 0;
  try {
    const skipConvert = process.env.GLM_VISION_NO_CONVERT === "1";
    const pdfPath = skipConvert ? null : convertViaWordCom(path, tmpDir) ?? convertViaLibreOffice(path, tmpDir);
    if (pdfPath) {
      emit("▸ 已转换为 PDF，开始逐页识别...");
      // 转换产物是临时 PDF（每次路径不同），不写缓存
      const r = await processPdf(pdfPath, "docx", PROMPTS.docx, question, think, temperature, true, 1, false, false, getKey, tag + "（经 Word/LibreOffice 转换）", emit);
      return { ok: r.ok, tokens: r.tokens };
    }

    // 最后一级：文本 + 逐张识别嵌入图片（布局信息丢失，但内容不丢）
    emit("▸ 未找到 Word/LibreOffice，降级为「文本 + 嵌入图片直抽」模式。");
    if (hasText) emit(markdown);
    if (extras.length > 0) emit(extras.join("\n"));
    if (!hasText && ext === ".doc") {
      emit("[glm-vision] 提示: .doc 旧格式无法直接解析文本，且本机无 Word/LibreOffice。请手动另存为 PDF/docx 后重试。");
      if (media === 0) return { ok: false, tokens: 0 };
    }
    const imgs = ext === ".docx" ? extractDocxMedia(path) : [];
    if (imgs.length === 0) {
      if (hasText) {
        emit("[glm-vision] 警告: 文档中的绘图元素（形状/SmartArt 等）无法抽取，以上仅为文本内容。可手动导出 PDF 后用 pdf 模式识别。");
        return { ok: true, tokens: 0 };
      }
      return { ok: false, tokens: 0 };
    }
    for (const img of imgs) {
      emit(`\n[嵌入图片] ${img.name} · 模式: detail`);
      try {
        const b64 = img.data.toString("base64");
        const prompt = question || PROMPTS.detail;
        const r = await callApiWithFallback(getKey(), [{ path: `media:${img.name}`, b64 }], prompt, think, temperature);
        reportThinking(r, think);
        emit(r.content);
        tokens += r.tokens;
      } catch (e) {
        emit(`  图片识别失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { ok: true, tokens };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------- SVG 源码分析（纯文本请求，零图片上传） ----------
async function processSvg(
  path: string, question: string, think: boolean, temperature: number,
  getKey: () => string, tag: string, emit: (s: string) => void,
): Promise<{ ok: boolean; tokens: number }> {
  emit(`\n${tag} · SVG 源码分析（文本请求）`);
  const src = readFileSync(path, "utf-8");
  const prompt = (question ? question + "\n\n" : "") + PROMPTS.svg + "\n" + src;
  try {
    const r = await callApiWithFallback(getKey(), [], prompt, think, temperature);
    reportThinking(r, think);
    emit(r.content);
    return { ok: true, tokens: r.tokens };
  } catch (e) {
    emit(`  分析失败: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, tokens: 0 };
  }
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.paths.length === 0 && args.urls.length === 0)
    fail("未提供文件路径或图片 URL。用法: bun glm-vision.ts [模式] 文件路径或URL...（--help 查看帮助）", 2);

  precheckFiles(args.paths);

  const mode = args.mode;
  const md = MODE_DEFS[mode] ?? MODE_DEFS.detail;
  const think = args.think ?? md.think;
  const temperature = args.temperature || md.temperature;
  const getKey = () => resolveApiKey(args.apiKey); // 惰性：纯文本 Word 路径不触发

  const output: string[] = [];
  const emit = (s: string): void => {
    console.log(s);
    output.push(s);
  };

  emit(`━━━ 视觉之眼 v2.1 · ${MODEL} ━━━`);
  emit(`深度思考: ${think ? "按请求开启（可 --no-think 关闭）" : "已关闭（可 --think 开启）"} · 降级链: ${[MODEL, ...FALLBACK.filter((m) => m !== MODEL)].join(" → ")}`);
  emit("隐私提示: 文件内容将上传至智谱服务器识别，请确保已获授权。");

  let okUnits = 0;
  let failUnits = 0;
  let totalTokens = 0;

  // 合并本地路径与 URL，保持传入顺序
  type Item = { path?: string; url?: string; seq: number };
  const items: Item[] = [
    ...args.paths.map((p, i) => ({ path: p, seq: i })),
    ...args.urls.map((u, i) => ({ url: u, seq: args.paths.length + i })),
  ].sort((a, b) => a.seq - b.seq);

  // compare 模式：所有图片（本地+URL）放入同一请求；PDF/Word/SVG 仍走各自管线
  if (mode === "compare") {
    const isImage = (it: Item): boolean =>
      !it.path || IMAGE_EXT.has(extname(it.path as string).toLowerCase());
    const imgs = items.filter(isImage);
    const nonImgs = items.filter((it) => !isImage(it));
    if (imgs.length > 0) {
      emit(`\n[对比] ${imgs.length} 张图片同请求对比`);
      try {
        const prompt = (args.question ? args.question + "\n\n" : "") +
          PROMPTS.compare.replaceAll("{count}", String(imgs.length));
        const loaded = loadImages(imgs);
        const r = await callApiWithFallback(getKey(), loaded, prompt, think, temperature);
        reportThinking(r, think);
        emit(r.content);
        totalTokens += r.tokens;
        okUnits++;
      } catch (e) {
        failUnits++;
        emit(`  对比失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    items.length = 0;
    items.push(...nonImgs); // 其余类型按常规管线处理
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tag = `[文件 ${i + 1}/${items.length}] ${it.url ?? it.path}`;
    try {
      let r: { ok: boolean; tokens: number };
      if (it.url) {
        emit(`\n${tag} · 模式: ${mode === "auto" ? "detail" : mode}`);
        const prompt = args.question || PROMPTS[mode === "auto" ? "detail" : mode] || PROMPTS.detail;
        const res = await callApiWithFallback(getKey(), [it.url], prompt, think, temperature);
        reportThinking(res, think);
        emit(res.content);
        r = { ok: true, tokens: res.tokens };
      } else {
        const ext = extname(it.path as string).toLowerCase();
        if (ext === ".pdf") {
          r = await processPdf(it.path as string, mode, PROMPTS.pdf, args.question, think, temperature, args.force, args.parallel, true, args.fast, getKey, tag, emit);
        } else if (WORD_EXTS.has(ext)) {
          r = await processWord(it.path as string, args.question, think, temperature, getKey, tag, emit);
        } else if (ext === ".svg") {
          r = await processSvg(it.path as string, args.question, think, temperature, getKey, tag, emit);
        } else {
          const promptKey = mode === "auto" ? "detail" : mode;
          emit(`\n${tag} · 模式: ${promptKey}`);
          const loaded = loadImages([it]);
          const prompt = args.question || PROMPTS[promptKey] || PROMPTS.detail;
          const res = await callApiWithFallback(getKey(), loaded, prompt, think, temperature);
          reportThinking(res, think);
          emit(res.content);
          if (res.finish === "length") emit("[glm-vision] 警告: 输出达到长度上限被截断，可加 --question 缩小范围。");
          r = { ok: true, tokens: res.tokens };
        }
      }
      if (r.ok) okUnits++;
      else failUnits++;
      totalTokens += r.tokens;
    } catch (e) {
      failUnits++;
      emit(`  处理失败: ${e instanceof Error ? e.message : String(e)}`);
      emit("  已跳过该文件，继续处理其余文件（如有）。");
    }
  }

  const summaryLine =
    `\n━━━ 完成: ${okUnits} 个文件成功 / ${failUnits} 个失败 · 本次 API 调用共消耗约 ${totalTokens} tokens ━━━`;
  emit(summaryLine);

  if (args.save && items.length > 0) {
    const firstLocal = items.find((it) => it.path);
    const base = firstLocal?.path
      ? join(dirname(resolve(firstLocal.path as string)), basename(firstLocal.path as string, extname(firstLocal.path as string)) + ".vision.md")
      : join(process.cwd(), "glm-vision-output.vision.md");
    const head = `# 视觉之眼识别结果（${MODEL}）\n\n`;
    try {
      writeFileSync(base, head + output.join("\n") + "\n", "utf-8");
      emit(`结果已保存: ${base}`);
    } catch (e) {
      emit(`结果保存失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (okUnits === 0) process.exit(1);
}

main();
