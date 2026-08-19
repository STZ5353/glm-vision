#!/usr/bin/env bun
/**
 * glm-vision.ts — 视觉之眼核心脚本（v1.1）
 *
 * 读取本地图片 → base64 编码 → 调用智谱 GLM-4.6V-Flash（免费视觉模型）
 * → 输出结构化文字识别结果。零依赖，仅需 bun 运行时。
 *
 * 用法:
 *   bun glm-vision.ts detail  图片1.png [图片2.jpg ...]     # 详细描述（默认模式）
 *   bun glm-vision.ts ocr     screenshot.png                # OCR 文字提取
 *   bun glm-vision.ts analyze chart.png                     # 图表/数据深度分析
 *   bun glm-vision.ts prompt  artwork.jpg                   # 反推 AI 绘画提示词
 *   bun glm-vision.ts detail  photo.png --question "图里有几辆车？"
 *   bun glm-vision.ts ocr     shot.png --think              # 强制开启深度思考
 *   bun glm-vision.ts detail  文档.pdf                      # PDF：逐页渲染为 PNG 后识别
 *
 * PDF 处理链路: 本地 PDF 无法直传智谱 API（file_url 仅接受公网 URL，不支持 base64），
 *   因此用 uv + PyMuPDF（pdf2png.py，同目录）逐页渲染为 PNG，再逐页走 image_url 识别。
 *   单 PDF 最多 {MAX_PDF_PAGES} 页，渲染临时文件识别后自动清理。
 *
 * 深度思考: GLM-4.6V-Flash 官方支持 thinking 模式。
 *   默认 detail/analyze/pdf 开启、ocr/prompt 关闭；--think / --no-think 显式覆盖。
 *
 * API Key 读取优先级（命中即止）:
 *   1. 命令行 --api-key 参数（不推荐，会留在 shell 历史）
 *   2. 环境变量 ZHIPU_API_KEY
 *   3. 环境变量 GLM_API_KEY
 *   4. 脚本同级目录 .glm-vision.json   内容: {"apiKey": "你的Key"}
 *
 * 模型切换: 设置环境变量 GLM_VISION_MODEL（如 glm-4.6v-flashx），
 * 或替换为任意 OpenAI 兼容视觉模型服务的 model 名。
 */
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "bun";

const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = process.env.GLM_VISION_MODEL || "glm-4.6v-flash";
const MAX_IMAGES = 5;      // 单次最多处理图片数，防止误传整个文件夹
const MAX_PDFS = 3;        // 单次最多处理 PDF 数（PDF 按页计费调用，成本更高）
const MAX_PDF_PAGES = 20;  // 单个 PDF 最多识别页数，超出需拆分
// 官方限制：单张图片 base64 后 ≤5M。base64 膨胀约 1.33 倍，
// 故原始文件 >3.5MB 即警告、>5MB 直接拒绝（base64 后必然超限）。
const WARN_SIZE_MB = 3.5;
const REJECT_SIZE_MB = 5;
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".pdf"]);

// ---------- 模式 Prompt 模板 ----------
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
  pdf: `你是一名专业的文档图像分析专家。这是从 PDF 文档渲染出的第 {page}/{total} 页（图像形式）。请：
1. 先一句话概括本页的主要内容与版式类型（正文/表格/图表/扫描件/照片/图文混排）。
2. 详细描述本页中的图片、图表、示意图的内容。
3. 逐字提取本页所有文字，表格转写为 Markdown 表格，公式原样转写，代码原样保留。
4. 保持版式顺序（从上到下、从左到右），分栏内容按栏呈现。
5. 无法确定的内容写"无法确定"，禁止编造。
请用中文回答。`,
};

// ---------- 工具函数 ----------
function fail(msg: string, code = 1): never {
  console.error(`[glm-vision] 错误: ${msg}`);
  process.exit(code);
}

function printHelp(): void {
  console.log(`视觉之眼 · GLM-4.6V-Flash 图片识别脚本
用法: bun glm-vision.ts [模式] 图片或PDF路径... [--question "问题"] [--api-key KEY] [--think | --no-think]

模式:
  detail   详细描述（默认）：图片类型、结构、逐节点连线、逐字文字提取
  ocr      文字提取：逐字 OCR，保留排版
  analyze  深度分析：图表数据转表格、趋势分析、公式解读
  prompt   反推提示词：Image2Prompt，输出中英文绘画提示词
  pdf      PDF 文档：逐页渲染为 PNG 后详细识别（可用 --question 自定义提问）

输入: 图片 png/jpg/jpeg/webp/gif/bmp（单张原始文件 ≤5MB），PDF 单次 ≤3 个、每个 ≤20 页
深度思考: 默认 detail/analyze/pdf 开启、ocr/prompt 关闭；--think / --no-think 显式覆盖
Key 优先级: --api-key > 环境变量 ZHIPU_API_KEY > GLM_API_KEY > .glm-vision.json
模型切换: 环境变量 GLM_VISION_MODEL（默认 glm-4.6v-flash）`);
}

function parseArgs(argv: string[]): {
  mode: string; paths: string[]; question: string; apiKey: string; think: boolean | null;
} {
  const out = { mode: "detail", paths: [] as string[], question: "", apiKey: "", think: null as boolean | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key") { out.apiKey = argv[++i] ?? ""; continue; }
    if (a === "--question" || a === "-q") { out.question = argv[++i] ?? ""; continue; }
    if (a === "--think") { out.think = true; continue; }
    if (a === "--no-think") { out.think = false; continue; }
    if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    if (a.startsWith("--")) fail(`未知参数: ${a}`, 2);
    if (PROMPTS[a]) { out.mode = a; continue; }
    out.paths.push(a);
  }
  return out;
}

function resolveApiKey(cliKey: string): string {
  if (cliKey) return cliKey;
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  if (process.env.GLM_API_KEY) return process.env.GLM_API_KEY;
  const cfgPath = join(dirname(import.meta.path), ".glm-vision.json");
  try {
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (typeof cfg?.apiKey === "string" && cfg.apiKey.trim())
        return cfg.apiKey.trim();
    }
  } catch {
    // 配置文件损坏则跳过，继续尝试下一来源
  }
  fail(
    "未找到 API Key。请通过以下任一方式提供：\n" +
    "  1) 环境变量 ZHIPU_API_KEY 或 GLM_API_KEY\n" +
    '  2) 脚本同目录 .glm-vision.json，内容 {"apiKey": "你的Key"}\n' +
    "  3) 命令行 --api-key 参数（不推荐，会留在 shell 历史）",
    2,
  );
}

/** 预检文件：存在性、扩展名白名单、大小阈值 */
function precheckFiles(paths: string[]): void {
  for (const p of paths) {
    if (!existsSync(p))
      fail(`文件不存在: ${p}。请检查路径拼写，确认文件已放入工作目录。`);
    if (!statSync(p).isFile())
      fail(`不是普通文件: ${p}。`);
    if (statSync(p).size === 0)
      fail(`文件为空 (0 字节): ${p}。文件可能损坏或未保存完成。`);
    const ext = extname(p).toLowerCase();
    if (!ALLOWED_EXT.has(ext))
      fail(`不支持的格式 "${ext}": ${p}。支持: ${[...ALLOWED_EXT].join(" / ")}`);
    const sizeMB = statSync(p).size / 1024 / 1024;
    if (ext === ".pdf") {
      // PDF 在本地渲染，不受 API 图片 5M 限制；100MB 上限仅防误传巨型文件
      if (sizeMB > 100)
        fail(`${p} 大小 ${sizeMB.toFixed(1)}MB，超过 100MB 上限。请拆分文档后重试。`);
      continue;
    }
    if (sizeMB > REJECT_SIZE_MB)
      fail(
        `${p} 大小 ${sizeMB.toFixed(1)}MB，超过 ${REJECT_SIZE_MB}MB 上限（官方限制 base64 后 ≤5M）。` +
        "请压缩后再试（缩小分辨率、转为 JPEG/WebP）。",
      );
    if (sizeMB > WARN_SIZE_MB)
      console.warn(
        `[glm-vision] 警告: ${p} 为 ${sizeMB.toFixed(1)}MB，` +
        "base64 编码后接近 API 的 5M 限制，若识别失败请压缩后重试。",
      );
  }
}

function classifyError(status: number, body: string): string {
  if (status === 401 || status === 403)
    return `API Key 无效或未授权 (HTTP ${status})。请检查 Key 是否拼写正确、所属项目是否开通了模型权限。`;
  if (status === 429 || /1302|1305|rate.?limit|限流|速率限制/i.test(body))
    return "请求被限流（智谱按账户动态并发限流，免费版高峰时段更严格）。请稍后重试，或减少单次数量。";
  if (status === 413 || /size|too large|图片.{0,6}(大小|过大|超限)/i.test(body))
    return `图片超过 API 大小限制 (HTTP ${status})。请压缩图片（长边缩至 2000px 内或转 JPEG/WebP）后重试。`;
  return `API 错误 (HTTP ${status}): ${body.slice(0, 300)}`;
}

async function callApi(
  apiKey: string,
  imageB64: string,
  promptText: string,
  think: boolean,
): Promise<string> {
  const content: Array<Record<string, unknown>> = [
    { type: "image_url", image_url: { url: imageB64 } },
    { type: "text", text: promptText },
  ];
  const body = {
    model: MODEL,
    messages: [{ role: "user", content }],
    max_tokens: 8192, // 显式放大，防止"尽可能详细"的输出被默认值截断
    thinking: { type: think ? "enabled" : "disabled" },
  };
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000), // 防止网络挂起导致永久等待
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? "(模型返回了空内容)";
      }
      const errText = await resp.text().catch(() => "");
      lastErr = classifyError(resp.status, errText);
      if (resp.status !== 429) break; // 仅限流时自动重试
    } catch (e) {
      lastErr = `网络错误: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(lastErr || "未知错误");
}

/** 用 uv + PyMuPDF（同目录 pdf2png.py）把 PDF 逐页渲染为 PNG，返回临时目录与页面列表 */
function renderPdf(pdfPath: string): { tmpDir: string; pages: string[] } {
  const tmpDir = mkdtempSync(join(tmpdir(), "glm-vision-"));
  const pyScript = join(dirname(import.meta.path), "pdf2png.py");
  const proc = spawnSync({
    cmd: ["uv", "run", "--with", "pymupdf", "python", pyScript, pdfPath, tmpDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const cleanup = (msg: string): never => {
    rmSync(tmpDir, { recursive: true, force: true });
    fail(msg);
  };
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    cleanup(
      `PDF 渲染失败 (exit ${proc.exitCode})：${err.slice(0, 500) || "未知原因"}\n` +
      "提示：需要 uv 运行时（uv --version 检查）；uv 首次运行需联网下载 Python 环境。",
    );
  }
  const pages = new TextDecoder().decode(proc.stdout).trim().split(/\r?\n/).filter(Boolean);
  if (pages.length === 0)
    cleanup("PDF 渲染完成但没有输出任何页面。PDF 可能没有可渲染内容。");
  if (pages.length > MAX_PDF_PAGES)
    cleanup(
      `PDF 共 ${pages.length} 页，超过单次上限 ${MAX_PDF_PAGES} 页。` +
      "请拆分 PDF 或分批处理。",
    );
  return { tmpDir, pages };
}

/** 识别一个 PDF：逐页渲染 → 逐页调用 API → 清理临时文件。返回本次成功页数。 */
async function processPdf(
  pdfPath: string,
  apiKey: string,
  mode: string,
  question: string,
  think: boolean,
  fileIndex: number,
  fileTotal: number,
): Promise<number> {
  console.log(`\n[文件 ${fileIndex + 1}/${fileTotal}] ${pdfPath} · PDF 逐页识别`);
  console.log(`▸ 渲染中（uv + PyMuPDF，150dpi）...`);
  const { tmpDir, pages } = renderPdf(pdfPath);

  let ok = 0;
  try {
    console.log(`▸ 共 ${pages.length} 页，开始逐页识别...`);
    for (let i = 0; i < pages.length; i++) {
      const pageNo = String(i + 1);
      console.log(`\n[第 ${i + 1}/${pages.length} 页]`);
      try {
        const buf = readFileSync(pages[i]);
        const b64 = buf.toString("base64");
        const prompt = (question || PROMPTS.pdf)
          .replaceAll("{page}", pageNo)
          .replaceAll("{total}", String(pages.length));
        const result = await callApi(apiKey, b64, prompt, think);
        console.log(result);
        ok++;
      } catch (e) {
        console.error(`  本页识别失败: ${e instanceof Error ? e.message : String(e)}`);
        console.error("  已跳过本页，继续识别其余页面。");
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true }); // 无论成败都清理临时渲染文件
  }

  return ok;
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.paths.length === 0)
    fail("未提供图片路径。用法: bun glm-vision.ts [模式] 图片或PDF路径...（--help 查看帮助）", 2);
  const imgCount = args.paths.filter((p) => extname(p).toLowerCase() !== ".pdf").length;
  const pdfCount = args.paths.length - imgCount;
  if (imgCount > MAX_IMAGES)
    fail(`单次最多处理 ${MAX_IMAGES} 张图片（当前 ${imgCount} 张）。请分批处理。`);
  if (pdfCount > MAX_PDFS)
    fail(`单次最多处理 ${MAX_PDFS} 个 PDF（当前 ${pdfCount} 个）。请分批处理。`);

  const apiKey = resolveApiKey(args.apiKey);
  precheckFiles(args.paths);
  // 深度思考：显式参数优先，否则按模式默认（detail/analyze/pdf 开，ocr/prompt 关）
  const think = args.think ?? ["detail", "analyze", "pdf"].includes(args.mode);

  console.log(`━━━ 视觉之眼 · ${MODEL} ━━━`);
  console.log(`深度思考: ${think ? "已开启" : "已关闭"}`);
  let okUnits = 0;
  let totalUnits = 0;
  for (let i = 0; i < args.paths.length; i++) {
    const p = args.paths[i];
    if (extname(p).toLowerCase() === ".pdf") {
      okUnits += await processPdf(p, apiKey, args.mode, args.question, think, i, args.paths.length);
      continue;
    }
    totalUnits++;
    console.log(`\n[文件 ${i + 1}/${args.paths.length}] ${p} · 模式: ${args.mode}`);
    try {
      const buf = readFileSync(p);
      const b64 = buf.toString("base64");
      const result = await callApi(apiKey, b64, args.question || PROMPTS[args.mode], think);
      console.log(result);
      okUnits++;
    } catch (e) {
      console.error(`  识别失败: ${e instanceof Error ? e.message : String(e)}`);
      console.error("  已跳过该文件，继续处理其余文件（如有）。");
    }
  }
  console.log(`\n━━━ 完成: ${okUnits} 个图片/页面识别成功 ━━━`);
  if (okUnits === 0) process.exit(1);
}

main();
